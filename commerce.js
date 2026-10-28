(() => {
  'use strict';
  const STORAGE_KEY = 'nino-battaglia-cart-v1';
  const MAX_QUANTITY = 99;
  const RECEIPT_KEY = STORAGE_KEY + '-receipt';
  const RECEIPT_DELAYS = [0, 1500, 3000, 5000];
  const RECEIPT_TOKEN = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}){2}$/i;
  const state = { products: new Map(), catalogComplete: false, cart: [], cartSignature: '', cartVersion: '', loading: false, ready: false, pending: false, checkoutReady: false, error: '', load: null, loadVersion: 0, storageAvailable: true };
  let cartPageBound = false;
  const shipping = { mode: null, countries: [], recipient: {}, quote: null, selected: '', loading: false, message: '', version: 0, timer: null, controller: null };
  let shippingUI = null;
  let config = { apiBase: '', productsPath: '/api/products', checkoutPath: '/api/checkout', ordersPath: '/api/orders', shippingPath: '/api/shipping-quotes', checkoutHosts: ['checkout.stripe.com'], maxUnits: 50, maxLines: 20 };
  const create = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  };
  const id = value => {
    const result = String(value ?? '');
    return /^[A-Za-z0-9_-]{1,100}$/.test(result) ? result : '';
  };
  const label = value => typeof value === 'string' ? value.trim().slice(0, 200) : '';
  const quantity = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= MAX_QUANTITY ? Number(value) : null;
  function money(value) {
    if (!value || typeof value !== 'object' || value.amount === null || value.amount === '' || typeof value.amount === 'boolean') return null;
    const amount = Number(value.amount);
    const currency = label(value.currency).toUpperCase();
    if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
    try { new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); }
    catch { return null; }
    return { amount, currency };
  }
  function formatMoney(value) {
    const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency });
    const divisor = 10 ** formatter.resolvedOptions().maximumFractionDigits;
    return formatter.format(value.amount / divisor);
  }
  function normalizeProducts(data) {
    const source = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];
    const products = new Map();
    for (const record of source) {
      const productId = id(record?.id);
      if (!productId || !label(record.title)) continue;
      const variants = new Map();
      for (const raw of Array.isArray(record.variants) ? record.variants : []) {
        const variantId = id(raw?.id);
        if (!variantId) continue;
        const size = label(raw.size ?? raw.options?.size);
        const color = label(raw.color ?? raw.options?.color);
        const name = label(raw.name ?? raw.title);
        const price = money(raw.price);
        const image = label(raw.image);
        const hex = /^#[0-9a-f]{6}$/i.test(String(raw.color_hex || '')) ? String(raw.color_hex) : '';
        variants.set(variantId, {
          id: variantId, size, color, name, price, hex,
          image: /^https:\/\/[^/]+\/./.test(image) ? image : '',
          available: raw.available === true,
          maximum: quantity(raw.max_quantity) || MAX_QUANTITY,
          purchasable: raw.available === true && Boolean(price) && Boolean(size || color || name)
        });
      }
      products.set(productId, { id: productId, external_id: id(record.external_id), title: label(record.title).replace(/\s+T$/, ''), image: label(record.image), variants });
    }
    return products;
  }
  function readCart() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      const merged = new Map();
      for (const item of value.slice(0, 200)) {
        const productId = id(item?.product_id), variantId = id(item?.variant_id), count = quantity(item?.quantity);
        if (!productId || !variantId || !count) continue;
        const key = productId + ':' + variantId;
        const previous = merged.get(key)?.quantity || 0;
        merged.set(key, { product_id: productId, variant_id: variantId, quantity: Math.min(MAX_QUANTITY, previous + count) });
      }
      return [...merged.values()];
    } catch { state.storageAvailable = false; return []; }
  }
  function cartSignature(items) {
    return JSON.stringify(items.map(item => ({ product_id: item.product_id, variant_id: item.variant_id, quantity: item.quantity })).sort((a, b) => (a.product_id + ':' + a.variant_id).localeCompare(b.product_id + ':' + b.variant_id)));
  }
  function readCartVersion() {
    try {
      const previous = localStorage.getItem(STORAGE_KEY + '-version');
      if (/^[a-f0-9-]{36}$/i.test(previous || '')) return previous;
      const version = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY + '-version', version);
      return version;
    } catch { state.storageAvailable = false; return crypto.randomUUID(); }
  }
  function writeCart() {
    const signature = cartSignature(state.cart);
    if (signature !== state.cartSignature) {
      state.cartVersion = crypto.randomUUID();
      invalidateShipping('Your cart changed. Get updated delivery rates.');
    }
    state.cartSignature = signature;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cart));
      localStorage.setItem(STORAGE_KEY + '-version', state.cartVersion);
    } catch { state.storageAvailable = false; }
    refreshCounts();
    document.dispatchEvent(new CustomEvent('nino:cart-change', { detail: { count: state.cart.reduce((sum, item) => sum + item.quantity, 0) } }));
  }
  function refreshCounts() {
    const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    document.querySelectorAll('[data-cart-count]').forEach(element => { element.textContent = String(count); });
  }
  function apiUrl(path) {
    const base = config.apiBase ? String(config.apiBase).replace(/\/$/, '') + '/' : location.origin + '/';
    const result = new URL(String(path).replace(/^\//, ''), base);
    if (result.protocol !== 'https:' && !(result.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(result.hostname))) throw new Error('Shopping is currently unavailable');
    return result.href;
  }
  function imageUrl(source) {
    if (!source) return '';
    try {
      const result = new URL(source, location.href);
      if (result.protocol === 'https:' || result.origin === location.origin) return result.href;
    } catch {}
    return '';
  }
  function cartStatus(message, error = false) {
    document.querySelectorAll('[data-cart-status]').forEach(element => {
      element.textContent = message;
      element.classList.toggle('commerce-error', error);
    });
  }
  function details(item) {
    const product = state.products.get(item.product_id);
    const variant = product?.variants.get(item.variant_id);
    return { product, variant, valid: Boolean(product && variant?.purchasable && item.quantity <= variant.maximum) };
  }
  function reconcileCart() {
    const original = state.cart.length;
    state.cart = state.cart.filter(item => {
      const product = state.products.get(item.product_id);
      return product?.variants.has(item.variant_id);
    });
    writeCart();
    return original !== state.cart.length;
  }
  async function loadProducts(force = false) {
    if (state.load && !force) return state.load;
    const version = ++state.loadVersion;
    state.loading = true;
    state.checkoutReady = false;
    state.error = '';
    renderCart();
    state.load = (async () => {
      try {
        const response = await fetch(apiUrl(config.productsPath), { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) throw new Error('Product options are currently unavailable');
        const data = await response.json();
        if (version !== state.loadVersion) return state.products;
        state.products = normalizeProducts(data);
        state.catalogComplete = data?.catalog_complete === true || data?.catalog_ready === true;
        setShippingPolicy(data?.shipping_mode, data?.shipping_countries);
        state.checkoutReady = data?.checkout_ready === true;
        document.documentElement.dataset.checkout = state.checkoutReady && state.catalogComplete ? 'open' : 'soon';
        state.ready = true;
        const removed = reconcileCart();
        state.loading = false;
        renderCart();
        if (removed) cartStatus('Some saved items are no longer in the collection and were removed.');
        return state.products;
      } catch (error) {
        if (version !== state.loadVersion) return state.products;
        state.loading = false;
        state.ready = false;
        state.checkoutReady = false;
        state.error = 'Product options are currently unavailable. Please try again.';
        renderCart();
        throw new Error(state.error);
      }
    })();
    return state.load;
  }
  function variantLabel(variant) {
    return [variant.color, variant.size].filter(Boolean).join(' / ') || variant.name;
  }
  function mountUnavailable(container, message, retry) {
    container.replaceChildren(create('p', 'commerce-option-status', message));
    if (retry) {
      const button = create('button', 'button button-outline', 'Try again');
      button.type = 'button';
      button.addEventListener('click', async () => { button.disabled = true; await retry(); });
      container.append(button);
    }
  }
  // Printful's photo of the shirt in the chosen color, shown in place of the main product photo.
  function colorImageUrl(product, color) {
    return (color && product ? [...product.variants.values()].find(item => item.color === color && item.image)?.image : '') || '';
  }
  function showColorImage(product, color) {
    const image = colorImageUrl(product, color);
    if (image) document.dispatchEvent(new CustomEvent('nino:color-image', { detail: { image, color } }));
  }
  function findProduct(record) {
    const productId = id(record?.printful_id || record?.printful_product_id || record?.id);
    const externalId = id(record?.external_id);
    return state.products.get(productId) || [...state.products.values()].find(item => item.external_id && (item.external_id === productId || item.external_id === externalId)) || null;
  }
  function mountComingSoon(container, record, product) {
    const name = label(record?.title).replace(/\s+T$/, '');
    const options = record?.options && typeof record.options === 'object' ? record.options : null;
    const colors = Array.isArray(options?.colors) ? options.colors.filter(c => c && typeof c.name === 'string') : [];
    const sizes = Array.isArray(options?.sizes) ? options.sizes.filter(s => typeof s === 'string') : [];
    const prices = options?.prices && typeof options.prices === 'object' ? options.prices : {};
    const money = cents => '$' + (Number(cents) / 100).toFixed(2).replace(/\.00$/, '');
    const note = create('div', 'coming-soon');
    let color = '', size = '';
    if (colors.length || sizes.length) {
      const picker = create('div', 'preview-options');
      if (colors.length) {
        const group = create('fieldset', 'preview-colors');
        const legend = create('legend', '', 'Color: ');
        const chosen = create('span', 'preview-chosen', 'choose one');
        legend.append(chosen); group.append(legend);
        const swatches = create('div', 'swatch-row');
        colors.forEach(c => {
          const button = create('button', 'swatch');
          button.type = 'button';
          button.style.setProperty('--swatch', /^#[0-9a-f]{6}$/i.test(c.hex || '') ? c.hex : '#888888');
          button.setAttribute('aria-label', c.name);
          button.setAttribute('aria-pressed', 'false');
          button.title = c.name;
          button.addEventListener('click', () => {
            color = c.name; chosen.textContent = c.name;
            swatches.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
            showColorImage(product, c.name);
            update();
          });
          swatches.append(button);
        });
        group.append(swatches); picker.append(group);
      }
      if (sizes.length) {
        const group = create('fieldset', 'preview-sizes');
        group.append(create('legend', '', 'Size'));
        const row = create('div', 'size-row');
        sizes.forEach(s => {
          const button = create('button', 'size-chip', s);
          button.type = 'button';
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            size = s;
            row.querySelectorAll('.size-chip').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
            update();
          });
          row.append(button);
        });
        group.append(row); picker.append(group);
      }
      note.append(picker);
    }
    const price = create('p', 'coming-soon-price');
    note.append(price);
    note.append(create('p', 'coming-soon-title', 'Online ordering opens soon'));
    note.append(create('p', 'commerce-option-status', 'Pick your color and size, then ask Nino to hold it for you — he’ll let you know as soon as it’s ready to order.'));
    const ask = create('a', 'button button-cyan', 'Email me when it’s ready ↗');
    note.append(ask);
    function update() {
      const cents = size && prices[size] ? prices[size] : Object.values(prices).map(Number).filter(Number.isFinite).sort((a, b) => a - b)[0];
      price.textContent = cents ? (size ? money(cents) : 'From ' + money(cents)) : '';
      price.hidden = !price.textContent;
      const subject = 'Notify me: ' + (name || 'shirt shop');
      const body = 'Hi Nino, please let me know when ' + (name ? '“' + name + '”' : 'the shirt shop') + ' is available to order.\n\nColor: ' + (color || '') + '\nSize: ' + (size || '') + '\n';
      ask.href = 'mailto:hello@ninobattaglia.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    }
    update();
    container.replaceChildren(note);
    // A color picked on the product card arrives preselected.
    const preferred = label(record?.preferredColor);
    if (preferred) [...note.querySelectorAll('.swatch')].find(button => button.getAttribute('aria-label') === preferred)?.click();
  }
  async function mountProduct(recordOrId, container) {
    if (!container) return;
    const requestedId = id(typeof recordOrId === 'object' ? (recordOrId?.printful_id || recordOrId?.printful_product_id || recordOrId?.id) : recordOrId);
    const requestedExternalId = id(typeof recordOrId === 'object' ? recordOrId?.external_id : '');
    container.dataset.purchaseProduct = requestedId;
    container.replaceChildren(create('p', 'commerce-option-status', 'Loading product options…'));
    try { if (!state.ready) await loadProducts(); }
    catch {
      if (container.dataset.purchaseProduct !== requestedId) return;
      mountUnavailable(container, 'Product options are currently unavailable. Please try again.', async () => {
        try { await loadProducts(true); } catch {}
        await mountProduct(recordOrId, container);
      });
      return;
    }
    if (container.dataset.purchaseProduct !== requestedId) return;
    const product = state.products.get(requestedId) || [...state.products.values()].find(item => item.external_id && (item.external_id === requestedId || item.external_id === requestedExternalId));
    const productId = product?.id;
    const variants = product ? [...product.variants.values()].filter(item => item.purchasable) : [];
    if (!variants.length || !state.catalogComplete || !state.checkoutReady) {
      if (!state.catalogComplete || !state.checkoutReady) { mountComingSoon(container, typeof recordOrId === 'object' ? recordOrId : null, product); return; }
      mountUnavailable(container, 'This design is not available to purchase right now.'); return;
    }
    const form = create('form', 'variant-picker');
    form.setAttribute('aria-label', 'Choose your product options');
    const chooser = create('div', 'variant-picker-options');
    const status = create('p', 'commerce-option-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const price = create('p', 'commerce-selected-price');
    const sizeValues = [...new Set(variants.map(item => item.size).filter(Boolean))];
    const colorValues = [...new Set(variants.map(item => item.color).filter(Boolean))];
    const fields = new Map();
    // Colors are chosen from dots in the garment's actual color; the hidden select keeps the value.
    const colorHex = new Map((Array.isArray(recordOrId?.options?.colors) ? recordOrId.options.colors : [])
      .filter(color => color && typeof color.name === 'string' && /^#[0-9a-f]{6}$/i.test(String(color.hex || '')))
      .map(color => [color.name, color.hex]));
    // Designs added after the curated catalog get their swatch colors from the API.
    for (const item of variants) if (item.color && item.hex && !colorHex.has(item.color)) colorHex.set(item.color, item.hex);
    let syncSwatches = () => {};
    function addSwatches(select, values, wrapper, chosenName) {
      select.hidden = true;
      const group = create('div', 'commerce-swatches');
      group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Color');
      const buttons = values.map(value => {
        const button = create('button', 'commerce-swatch');
        button.type = 'button'; button.dataset.value = value; button.title = value;
        button.setAttribute('role', 'radio'); button.setAttribute('aria-label', value);
        const hex = colorHex.get(value);
        if (hex) button.style.setProperty('--swatch', hex); else { button.classList.add('is-text'); button.textContent = value; }
        button.addEventListener('click', () => { select.value = value; select.dispatchEvent(new Event('change')); });
        return button;
      });
      group.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const current = Math.max(0, buttons.findIndex(button => button.dataset.value === select.value));
        const next = buttons[(current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length];
        next.click(); next.focus();
      });
      group.append(...buttons); wrapper.append(group);
      syncSwatches = () => {
        buttons.forEach((button, index) => {
          const checked = button.dataset.value === select.value;
          button.setAttribute('aria-checked', String(checked));
          button.tabIndex = checked || (!select.value && index === 0) ? 0 : -1;
        });
        chosenName.textContent = select.value ? ': ' + select.value : '';
      };
    }
    function addSelect(key, heading, values) {
      const swatches = key === 'color' && colorHex.size > 0;
      const wrapper = create(swatches ? 'div' : 'label', 'commerce-field' + (swatches ? ' commerce-field-color' : ''));
      const title = create('span', '', heading); wrapper.append(title);
      const select = create('select'); select.name = key;
      select.append(new Option('Choose ' + heading.toLowerCase(), ''));
      values.forEach(value => select.append(new Option(value, value)));
      wrapper.append(select); chooser.append(wrapper); fields.set(key, select);
      select.addEventListener('change', updateSelection);
      if (swatches) { const chosenName = create('span', 'commerce-swatch-name'); title.append(chosenName); addSwatches(select, values, wrapper, chosenName); }
    }
    const uniqueDimensions = new Set(variants.map(item => item.size + '\u0000' + item.color)).size === variants.length;
    const useDimensions = uniqueDimensions && variants.every(item => Boolean(item.size || item.color)) && !(variants.some(item => !item.size) && sizeValues.length) && !(variants.some(item => !item.color) && colorValues.length);
    if (useDimensions) {
      if (colorValues.length) addSelect('color', 'Color', colorValues);
      if (sizeValues.length) addSelect('size', 'Size', sizeValues);
    } else addSelect('variant', 'Option', variants.map(item => item.id));
    if (fields.has('variant')) {
      [...fields.get('variant').options].slice(1).forEach(option => { option.textContent = variantLabel(product.variants.get(option.value)); });
    }
    const qtyWrapper = create('label', 'commerce-field quantity-field');
    qtyWrapper.append(create('span', '', 'Quantity'));
    const qty = create('input'); qty.type = 'number'; qty.name = 'quantity'; qty.min = '1'; qty.max = String(MAX_QUANTITY); qty.step = '1'; qty.value = '1'; qty.inputMode = 'numeric';
    qtyWrapper.append(qty); chooser.append(qtyWrapper);
    const add = create('button', 'button button-cyan', 'Add to cart'); add.type = 'submit'; add.disabled = true;
    const viewCart = create('a', 'text-link commerce-cart-link', 'View cart ↗'); viewCart.href = 'cart.html'; viewCart.hidden = true;
    form.append(chooser, price, add, viewCart, status);
    container.replaceChildren(form);
    let selected = null;
    let shownColor = '';
    function updateSelection() {
      syncSwatches();
      selected = null;
      const chosenColor = fields.has('color') ? fields.get('color').value : fields.has('variant') ? product.variants.get(fields.get('variant').value)?.color || '' : '';
      if (chosenColor !== shownColor) { shownColor = chosenColor; showColorImage(product, chosenColor); }
      if (fields.has('variant')) selected = variants.find(item => item.id === fields.get('variant').value) || null;
      else if ([...fields.values()].every(field => field.value)) selected = variants.find(item => [...fields].every(([key, field]) => item[key] === field.value)) || null;
      if (fields.has('color') && fields.has('size')) {
        const chosenColor = fields.get('color').value;
        [...fields.get('size').options].slice(1).forEach(option => {
          option.disabled = Boolean(chosenColor) && !variants.some(item => item.color === chosenColor && item.size === option.value);
        });
      }
      price.textContent = selected ? formatMoney(selected.price) : '';
      qty.max = String(selected?.maximum || MAX_QUANTITY);
      add.disabled = !selected || !quantity(qty.value) || Number(qty.value) > selected.maximum;
      if ([...fields.values()].every(field => field.value) && !selected) status.textContent = 'This combination is unavailable. Choose a different option.';
      else status.textContent = '';
    }
    qty.addEventListener('input', updateSelection);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const count = quantity(qty.value);
      if (!selected || !count || count > selected.maximum) { status.textContent = 'Choose an available option and a valid quantity.'; return; }
      const current = state.products.get(productId)?.variants.get(selected.id);
      if (!current?.purchasable) { status.textContent = 'This option is no longer available.'; return; }
      const existing = state.cart.find(item => item.product_id === productId && item.variant_id === selected.id);
      const total = (existing?.quantity || 0) + count;
      const units = state.cart.reduce((sum, item) => sum + item.quantity, 0) + count;
      if (units > config.maxUnits) { status.textContent = `Choose no more than ${config.maxUnits} total items for one checkout.`; return; }
      if (!existing && state.cart.length >= config.maxLines) { status.textContent = `Choose no more than ${config.maxLines} different options for one checkout.`; return; }
      if (total > current.maximum) { status.textContent = `Choose a quantity of ${current.maximum} or less for this option.`; return; }
      if (existing) existing.quantity = total;
      else state.cart.push({ product_id: productId, variant_id: selected.id, quantity: count });
      writeCart(); renderCart();
      document.dispatchEvent(new CustomEvent('nino:measure', { detail: { event: 'add_to_cart', product_id: productId } }));
      // Back to where the shopper found the shirt: the product view closes (like Back) and the toast confirms.
      const toastEvent = new CustomEvent('nino:toast', { detail: { message: 'Added to cart', closeProduct: state.storageAvailable } });
      document.dispatchEvent(toastEvent);
      // The status line keeps only what the toast can't say: a warning, or the fallback if no toast exists.
      status.textContent = !state.storageAvailable ? 'Added to this page’s cart. Your browser cannot save the cart between pages.' : toastEvent.detail.shown ? '' : 'Added to your cart.';
      viewCart.hidden = false;
    });
    // A color picked on the product card arrives preselected.
    const preferred = typeof recordOrId === 'object' ? label(recordOrId?.preferredColor) : '';
    if (preferred && fields.has('color') && colorValues.includes(preferred)) fields.get('color').value = preferred;
    updateSelection();
  }
  function forgetCheckoutAttempt() {
    try { sessionStorage.removeItem(STORAGE_KEY + '-checkout'); } catch {}
  }
  function invalidateShipping(message = '') {
    const hadQuote = Boolean(shipping.quote) || shipping.loading;
    clearTimeout(shipping.timer); shipping.timer = null;
    shipping.controller?.abort(); shipping.controller = null;
    shipping.version++; shipping.quote = null; shipping.selected = ''; shipping.loading = false;
    shipping.message = hadQuote ? message : '';
    if (hadQuote) forgetCheckoutAttempt();
  }
  function setShippingPolicy(mode, countries) {
    const nextMode = ['calculated', 'flat', 'free'].includes(mode) ? mode : null;
    const nextCountries = [...new Set((Array.isArray(countries) ? countries : []).filter(value => typeof value === 'string' && /^[A-Z]{2}$/.test(value)))];
    if (shipping.mode !== nextMode || JSON.stringify(shipping.countries) !== JSON.stringify(nextCountries)) invalidateShipping('Delivery options changed. Get updated rates.');
    shipping.mode = nextMode; shipping.countries = nextCountries;
    if (shipping.recipient.country_code && !nextCountries.includes(shipping.recipient.country_code)) shipping.recipient.country_code = '';
  }
  function shippingReady() {
    if (shipping.mode === 'flat' || shipping.mode === 'free') return true;
    return shipping.mode === 'calculated' && Boolean(shipping.quote) && shipping.quote.expires > Date.now() && shipping.quote.cart === cartSignature(state.cart) && shipping.quote.address === JSON.stringify(shipping.recipient) && shipping.quote.rates.some(rate => rate.id === shipping.selected);
  }
  function countryName(code) {
    try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) || code; } catch { return code; }
  }
  function createShippingUI(summary) {
    const section = create('section', 'shipping-calculator'); section.dataset.shippingCalculator = '';
    const heading = create('h3', '', 'Delivery address'); heading.id = 'shipping-address-title';
    const form = create('form', 'shipping-address-form'); form.setAttribute('aria-labelledby', heading.id);
    const fields = new Map();
    const definitions = [
      ['name','Full name','name'],['address1','Street address','address-line1'],['address2','Apartment or suite (optional)','address-line2'],['city','City','address-level2'],['state_code','State / province','address-level1'],['country_code','Country','country'],['zip','Postal code','postal-code']
    ];
    for (const [name, title, autocomplete] of definitions) {
      const wrapper = create('label', 'commerce-field shipping-field shipping-field-' + name);
      wrapper.append(create('span', '', title));
      const input = create(name === 'country_code' ? 'select' : 'input'); input.name = name; input.autocomplete = 'shipping ' + autocomplete;
      if (name !== 'country_code') { input.type = 'text'; input.maxLength = 150; }
      input.required = !['address2','state_code'].includes(name);
      input.value = shipping.recipient[name] || '';
      input.addEventListener(name === 'country_code' ? 'change' : 'input', () => {
        shipping.recipient = Object.fromEntries([...fields].map(([key, field]) => [key, field.value.trim()]));
        invalidateShipping('Your address changed. Get updated delivery rates.');
        updateShippingControls(); renderShippingRates(); updateCheckoutButton();
      });
      wrapper.append(input); fields.set(name, input); form.append(wrapper);
    }
    const button = create('button', 'button button-outline', 'Get delivery rates'); button.type = 'submit'; form.append(button);
    const status = create('p', 'shipping-status'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const rates = create('div', 'shipping-rates');
    section.append(heading, form, status, rates);
    const checkout = summary.querySelector('[data-cart-checkout]'); checkout.before(section);
    const cost = create('div', 'shipping-summary-line'); cost.dataset.shippingSummary = ''; cost.hidden = true; cost.append(create('dt','','Delivery'),create('dd'));
    summary.querySelector('dl')?.append(cost);
    shippingUI = { section, form, fields, button, status, rates, cost };
    form.addEventListener('submit', event => { event.preventDefault(); requestShippingQuote(); });
  }
  function updateCheckoutButton() {
    const checkout = document.querySelector('[data-cart-checkout]');
    if (checkout) checkout.disabled = state.pending || state.loading || !state.ready || !totals().allValid || !state.checkoutReady || !shippingReady();
  }
  function updateShippingControls() {
    if (!shippingUI) return;
    const { fields, button, section } = shippingUI;
    section.hidden = shipping.mode !== 'calculated';
    const country = fields.get('country_code');
    if (country.dataset.allowedCountries !== shipping.countries.join(',')) {
      country.replaceChildren(new Option('Choose country', ''), ...shipping.countries.map(code => new Option(countryName(code), code)));
      country.dataset.allowedCountries = shipping.countries.join(',');
      country.value = shipping.recipient.country_code || '';
    }
    for (const field of fields.values()) field.disabled = state.pending || shipping.loading;
    fields.get('state_code').required = ['US','AU','CA'].includes(country.value);
    button.disabled = state.pending || state.loading || shipping.loading || !state.ready || !state.checkoutReady || !totals().allValid || !shipping.countries.length;
    button.textContent = shipping.loading ? 'Getting delivery rates…' : 'Get delivery rates';
    button.setAttribute('aria-busy', String(shipping.loading));
  }
  function renderShippingRates() {
    if (!shippingUI) return;
    const { rates, status, cost } = shippingUI;
    status.textContent = shipping.message;
    rates.replaceChildren(); cost.hidden = true;
    if (!shipping.quote || shipping.quote.expires <= Date.now()) return;
    const address = create('div','shipping-address-review'); address.append(create('h4','','Deliver to'));
    const recipient = shipping.quote.recipient;
    address.append(create('p','', [recipient.name, recipient.address1, recipient.address2, [recipient.city,recipient.state_code,recipient.zip].filter(Boolean).join(', '), countryName(recipient.country_code)].filter(Boolean).join('\n')));
    const group = create('fieldset'); group.append(create('legend','','Delivery options'));
    for (const rate of shipping.quote.rates) {
      const row = create('label','shipping-rate');
      const radio = create('input'); radio.type = 'radio'; radio.name = 'shipping_rate'; radio.value = rate.id; radio.checked = shipping.selected === rate.id; radio.disabled = state.pending;
      radio.addEventListener('change', () => {
        shipping.selected = rate.id; forgetCheckoutAttempt();
        renderShippingRates();
        [...shippingUI.rates.querySelectorAll('input[name=shipping_rate]')].find(input => input.value === rate.id)?.focus();
        updateCheckoutButton();
      });
      row.append(radio,create('span','',rate.name),create('strong','',formatMoney(rate.price))); group.append(row);
    }
    rates.append(address,group);
    const selected = shipping.quote.rates.find(rate => rate.id === shipping.selected);
    if (selected) { cost.hidden = false; cost.querySelector('dd').textContent = formatMoney(selected.price); }
  }
  function renderShipping() {
    const summary = document.querySelector('[data-cart-summary]');
    if (!summary) return;
    summary.classList.toggle('has-calculated-shipping', shipping.mode === 'calculated');
    if (!shippingUI && shipping.mode === 'calculated') createShippingUI(summary);
    if (!shippingUI) return;
    updateShippingControls(); renderShippingRates();
    if (shipping.mode !== 'calculated') shippingUI.cost.hidden = true;
  }
  async function requestShippingQuote() {
    if (shipping.mode !== 'calculated' || shipping.loading || state.pending || !state.checkoutReady || !totals().allValid || !shippingUI?.form.reportValidity()) return;
    shipping.recipient = Object.fromEntries([...shippingUI.fields].map(([key, field]) => [key, field.value.trim()]));
    const recipient = { ...shipping.recipient };
    if (!shipping.countries.includes(recipient.country_code)) { shipping.message = 'Choose an available delivery country.'; renderShipping(); return; }
    invalidateShipping();
    const version = shipping.version;
    const cart = cartSignature(state.cart), address = JSON.stringify(recipient);
    const items = state.cart.map(item => ({ product_id:item.product_id, variant_id:item.variant_id, quantity:item.quantity }));
    shipping.loading = true; shipping.message = 'Checking delivery options for this address…';
    const controller = new AbortController(); shipping.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    renderShipping(); updateCheckoutButton();
    try {
      const response = await fetch(apiUrl(config.shippingPath), { method:'POST', credentials:'omit', headers:{'Content-Type':'application/json',Accept:'application/json'}, body:JSON.stringify({items,recipient}), signal:controller.signal });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (version !== shipping.version || cart !== cartSignature(state.cart) || address !== JSON.stringify(shipping.recipient)) return;
      const expires = Number(result?.expires_at) * 1000;
      if (!id(result?.quote_id) || !Number.isSafeInteger(result?.expires_at) || !Number.isFinite(expires) || expires <= Date.now() || !Array.isArray(result?.rates)) throw new Error();
      const currency = [...totals().sums.keys()][0];
      const ids = new Set();
      const rates = result.rates.flatMap(raw => {
        const rateId = typeof raw?.id === 'string' ? raw.id : '';
        const rateName = label(raw?.name), amount = raw?.amount, code = label(raw?.currency).toUpperCase();
        if (!rateId || rateId.length > 100 || /[\u0000-\u001f]/.test(rateId) || ids.has(rateId) || !rateName || !Number.isSafeInteger(amount) || amount < 0 || code !== currency) return [];
        ids.add(rateId); return [{id:rateId,name:rateName,price:{amount,currency:code}}];
      });
      if (!rates.length) throw new Error();
      shipping.quote = { id:result.quote_id, expires, rates, cart, address, recipient };
      shipping.selected = ''; shipping.message = 'Review the delivery address and choose a rate.';
      forgetCheckoutAttempt();
      shipping.timer = setTimeout(() => { invalidateShipping('Delivery rates expired. Get updated rates before checkout.'); renderShipping(); updateCheckoutButton(); }, Math.min(2147483647, expires - Date.now()));
    } catch {
      if (version === shipping.version) shipping.message = 'Delivery rates are unavailable for this address right now. Check the address and try again.';
    } finally {
      clearTimeout(timeout);
      if (version === shipping.version) { shipping.loading = false; shipping.controller = null; renderShipping(); updateCheckoutButton(); }
    }
  }
  function totals() {
    const sums = new Map();
    let allValid = state.cart.length > 0;
    for (const item of state.cart) {
      const { variant, valid } = details(item);
      if (!valid) { allValid = false; continue; }
      sums.set(variant.price.currency, (sums.get(variant.price.currency) || 0) + variant.price.amount * item.quantity);
    }
    const units = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    return { sums, allValid: allValid && sums.size === 1 && units <= config.maxUnits && state.cart.length <= config.maxLines };
  }
  function renderCart() {
    refreshCounts();
    const root = document.querySelector('[data-cart-root]');
    if (!root) return;
    const lines = root.querySelector('[data-cart-lines]');
    const empty = root.querySelector('[data-cart-empty]');
    const summary = root.querySelector('[data-cart-summary]');
    const checkout = root.querySelector('[data-cart-checkout]');
    const retry = root.querySelector('[data-cart-retry]');
    const count = state.cart.length;
    empty.hidden = count > 0 || state.loading || Boolean(state.error);
    summary.hidden = count === 0;
    checkout.disabled = state.pending || state.loading || !state.ready || !totals().allValid || !state.checkoutReady || !shippingReady();
    renderShipping();
    checkout.textContent = state.pending ? 'Opening checkout…' : 'Continue to checkout ↗';
    checkout.setAttribute('aria-busy', String(state.pending));
    if (retry) retry.hidden = !state.error;
    lines.replaceChildren();
    if (state.loading) { cartStatus('Checking product options and prices…'); return; }
    if (state.error) { cartStatus(state.error, true); return; }
    cartStatus(!state.checkoutReady ? 'Checkout is not open yet. Your selections are saved in your cart.' : '');
    for (const item of state.cart) {
      const { product, variant, valid } = details(item);
      if (!product || !variant) continue;
      const row = create('article', 'cart-line');
      // Each line shows its own color: the variant's photo, else the product's main photo.
      const source = imageUrl(variant.image) || imageUrl(product.image);
      if (source) {
        const image = create('img', 'cart-line-image'); image.src = source; image.alt = variant.color ? `${product.title} in ${variant.color}` : product.title; image.loading = 'lazy'; row.append(image);
      }
      const copy = create('div', 'cart-line-copy');
      copy.append(create('h2', '', product.title), create('p', 'cart-line-options', variantLabel(variant)));
      if (!valid) copy.append(create('p', 'commerce-error', 'This option is currently unavailable. Remove it before checking out.'));
      else copy.append(create('p', 'cart-unit-price', formatMoney(variant.price) + ' each'));
      const actions = create('div', 'cart-line-actions');
      const qtyLabel = create('label', 'commerce-field cart-quantity'); qtyLabel.append(create('span', '', 'Quantity'));
      const qty = create('input'); qty.type = 'number'; qty.min = '1'; qty.max = String(variant.maximum); qty.step = '1'; qty.value = String(item.quantity); qty.inputMode = 'numeric'; qty.disabled = state.pending;
      qty.setAttribute('aria-label', 'Quantity for ' + product.title + ', ' + variantLabel(variant));
      qty.addEventListener('change', () => {
        const next = quantity(qty.value);
        if (!next || next > variant.maximum || state.cart.reduce((sum, other) => sum + other.quantity, 0) - item.quantity + next > config.maxUnits) { qty.value = String(item.quantity); cartStatus(`Choose a quantity from 1 to ${variant.maximum}, with no more than ${config.maxUnits} total items in the cart.`, true); return; }
        item.quantity = next; writeCart(); renderCart();
      });
      qtyLabel.append(qty); actions.append(qtyLabel);
      const remove = create('button', 'cart-remove', 'Remove'); remove.type = 'button'; remove.disabled = state.pending;
      remove.setAttribute('aria-label', 'Remove ' + product.title + ', ' + variantLabel(variant));
      remove.addEventListener('click', () => {
        const index = state.cart.indexOf(item); state.cart.splice(index, 1); writeCart(); renderCart();
        const next = root.querySelectorAll('.cart-remove')[Math.min(index, state.cart.length - 1)];
        if (next) next.focus(); else root.querySelector('[data-empty-shop-link]')?.focus();
        cartStatus('Removed from your cart.');
      });
      actions.append(remove); copy.append(actions); row.append(copy);
      if (valid) row.append(create('p', 'cart-line-total', formatMoney({ amount: variant.price.amount * item.quantity, currency: variant.price.currency })));
      lines.append(row);
    }
    const subtotal = root.querySelector('[data-cart-subtotal]');
    subtotal.textContent = [...totals().sums].map(([currency, amount]) => formatMoney({ currency, amount })).join(' + ') || '—';
    if (totals().sums.size > 1) cartStatus('Use a single currency in one checkout.', true);
    else if (state.cart.reduce((sum, item) => sum + item.quantity, 0) > config.maxUnits || count > config.maxLines) cartStatus(`Choose no more than ${config.maxUnits} total items and ${config.maxLines} different options for one checkout.`, true);
    else if (count && !totals().allValid) cartStatus('Remove unavailable options before checking out.', true);
  }
  function checkoutRequestId(items) {
    const signature = JSON.stringify({ items: cartSignature(items), shipping_quote_id: shipping.mode === 'calculated' ? shipping.quote?.id : null, shipping_rate_id: shipping.mode === 'calculated' ? shipping.selected : null });
    try {
      const previous = JSON.parse(sessionStorage.getItem(STORAGE_KEY + '-checkout') || 'null');
      if (previous?.signature === signature && /^[a-f0-9-]{36}$/i.test(previous.request_id)) return previous.request_id;
    } catch {}
    const request_id = crypto.randomUUID();
    try { sessionStorage.setItem(STORAGE_KEY + '-checkout', JSON.stringify({ signature, request_id })); } catch {}
    return request_id;
  }
  async function checkout() {
    if (state.pending) return;
    if (!state.checkoutReady) { cartStatus('Checkout is not open yet. Your selections are saved in your cart.'); return; }
    state.pending = true; renderCart();
    document.dispatchEvent(new CustomEvent('nino:measure', { detail: { event: 'checkout_attempt' } }));
    try {
      await loadProducts(true);
      if (!state.checkoutReady) throw new Error('Checkout is not open yet. Your selections are saved in your cart.');
      if (!state.cart.length || !totals().allValid) throw new Error('Review the available items in your cart before checking out.');
      if (!shippingReady()) throw new Error(shipping.mode === 'calculated' ? 'Review your address and choose a current delivery rate before checkout.' : 'Shipping options are not ready for checkout.');
      const items = state.cart.map(item => ({ product_id: item.product_id, variant_id: item.variant_id, quantity: item.quantity }));
      const cartVersion = state.cartVersion;
      cartStatus('Opening secure checkout…');
      const requestId = checkoutRequestId(items);
      const payload = { items, request_id: requestId };
      if (shipping.mode === 'calculated') { payload.shipping_quote_id = shipping.quote.id; payload.shipping_rate_id = shipping.selected; }
      const response = await fetch(apiUrl(config.checkoutPath), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
      let data; try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        if (['shipping_quote_expired','invalid_shipping_rate','shipping_quote_required'].includes(data?.error)) {
          invalidateShipping('Delivery rates changed. Get updated rates before checkout.');
          throw new Error('Get updated delivery rates before checkout.');
        }
        if (data?.error === 'checkout_paused') throw new Error('Checkout is paused for a short time. Your cart is saved; please try again later today.');
        throw new Error(response.status === 409 ? 'A product option changed. Review your cart and try again.' : 'Checkout is unavailable right now. Your cart is saved; please try again.');
      }
      let destination;
      try { destination = new URL(data?.checkout_url); }
      catch { throw new Error('Checkout could not be opened. Please try again.'); }
      if (destination.protocol !== 'https:' || !config.checkoutHosts.includes(destination.hostname)) throw new Error('Checkout could not be opened. Please try again.');
      saveCheckoutReceipt(data, items, cartVersion, requestId);
      document.dispatchEvent(new CustomEvent('nino:measure', { detail: { event: 'checkout_opened' } }));
      location.assign(destination.href);
    } catch (error) {
      state.pending = false; renderCart();
      cartStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Checkout is unavailable right now. Your cart is saved; please try again.', true);
    }
  }
  let receiptRun = 0;
  let receiptStarted = false;
  function saveCheckoutReceipt(data, items, cartVersion, requestId) {
    if (!/^ord_[a-f0-9]{24}$/.test(data?.order_id || '') || !RECEIPT_TOKEN.test(data?.receipt_token || '')) throw new Error('Checkout could not be saved. Please try again.');
    const receipt = { order_id: data.order_id, receipt_token: data.receipt_token, items, cart_version: cartVersion, request_id: requestId, created_at: Date.now(), cart_cleared: false };
    try {
      sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
      const saved = JSON.parse(sessionStorage.getItem(RECEIPT_KEY) || 'null');
      if (saved?.order_id !== receipt.order_id || saved?.receipt_token !== receipt.receipt_token) throw new Error();
    } catch { throw new Error('Checkout could not be saved in this browser. Please allow session storage and try again.'); }
  }
  function readCheckoutReceipt() {
    try {
      const receipt = JSON.parse(sessionStorage.getItem(RECEIPT_KEY) || 'null');
      if (!/^ord_[a-f0-9]{24}$/.test(receipt?.order_id || '') || !RECEIPT_TOKEN.test(receipt?.receipt_token || '') || !Array.isArray(receipt?.items) || !receipt.items.length || receipt.items.length > 200) return null;
      if (!receipt.items.every(item => id(item?.product_id) && id(item?.variant_id) && quantity(item?.quantity))) return null;
      return receipt;
    } catch { return null; }
  }
  function clearUnchangedPurchasedCart(receipt) {
    if (receipt.cart_cleared) return true;
    try {
      const savedCart = readCart();
      const savedVersion = localStorage.getItem(STORAGE_KEY + '-version');
      if (!state.storageAvailable || !receipt.cart_version || savedVersion !== receipt.cart_version || cartSignature(savedCart) !== cartSignature(receipt.items)) return false;
      state.cart = []; writeCart(); renderCart();
      receipt.cart_cleared = true;
      sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
      return true;
    } catch { return false; }
  }
  function receiptRegion() {
    let region = document.querySelector('[data-checkout-receipt]');
    if (region) return region;
    const main = document.querySelector('main');
    if (!main) return null;
    region = create('section', 'shell checkout-receipt');
    region.dataset.checkoutReceipt = '';
    region.setAttribute('aria-labelledby', 'checkout-receipt-title');
    const title = create('h2'); title.id = 'checkout-receipt-title';
    const message = create('p', 'receipt-message'); message.dataset.receiptMessage = ''; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const reference = create('p', 'receipt-reference'); reference.dataset.receiptReference = '';
    const retry = create('button', 'button button-outline', 'Check payment status'); retry.type = 'button'; retry.dataset.receiptRetry = ''; retry.hidden = true;
    retry.addEventListener('click', () => verifyCheckoutReceipt(readCheckoutReceipt()));
    const cart = create('a', 'text-link', 'Review your cart ↗'); cart.href = 'cart.html';
    const actions = create('div', 'button-row receipt-actions'); actions.append(retry, cart);
    region.append(title, message, reference, actions);
    const intro = main.querySelector('.page-intro');
    if (intro) intro.after(region); else main.prepend(region);
    return region;
  }
  function showReceipt(heading, message, { retry = false, busy = false, reference = '' } = {}) {
    const region = receiptRegion();
    if (!region) return;
    region.setAttribute('aria-busy', String(busy));
    region.querySelector('h2').textContent = heading;
    region.querySelector('[data-receipt-message]').textContent = message;
    const ref = region.querySelector('[data-receipt-reference]'); ref.textContent = reference; ref.hidden = !reference;
    const button = region.querySelector('[data-receipt-retry]'); button.hidden = !retry; button.disabled = busy;
  }
  async function verifyCheckoutReceipt(receipt) {
    const run = ++receiptRun;
    if (!receipt) {
      showReceipt('Payment status unavailable', 'We cannot verify this checkout in this browser. Your cart has been kept.');
      return;
    }
    showReceipt('Checking your payment', 'Waiting for a verified payment update. Your cart is still saved.', { busy: true });
    for (let attempt = 0; attempt < RECEIPT_DELAYS.length; attempt++) {
      if (RECEIPT_DELAYS[attempt]) await new Promise(resolve => setTimeout(resolve, RECEIPT_DELAYS[attempt]));
      if (run !== receiptRun) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const path = String(config.ordersPath).replace(/\/$/, '') + '/' + encodeURIComponent(receipt.order_id);
        const url = new URL(apiUrl(path)); url.searchParams.set('token', receipt.receipt_token);
        const response = await fetch(url.href, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error();
        const order = await response.json();
        if (run !== receiptRun) return;
        if (order?.order_id !== receipt.order_id || !['pending', 'failed', 'paid'].includes(order?.payment_status)) throw new Error();
        if (order.payment_status === 'paid') {
          try {
            const attempt = JSON.parse(sessionStorage.getItem(STORAGE_KEY + '-checkout') || 'null');
            if (receipt.request_id && attempt?.request_id === receipt.request_id) sessionStorage.removeItem(STORAGE_KEY + '-checkout');
          } catch {}
          const test = order.fulfillment_status === 'test_paid';
          const review = order.fulfillment_status === 'review';
          const verifiedTotal = money({ amount: order.total_cents, currency: order.currency });
          const cleared = !test && !review && verifiedTotal && clearUnchangedPurchasedCart(receipt);
          let message = test ? 'This is a test checkout. Your cart has been kept.' : review ? 'Your payment was received. Your order needs review before fulfillment.' : 'Your payment has been confirmed.';
          if (!test && !cleared) message += ' Your current cart has been kept.';
          const total = verifiedTotal ? ' · ' + formatMoney(verifiedTotal) : '';
          showReceipt(test ? 'Test checkout confirmed' : review ? 'Payment received — order under review' : 'Payment confirmed', message, { reference: 'Order ' + receipt.order_id + total });
          return;
        }
        if (order.payment_status === 'failed') {
          showReceipt('Payment not completed', 'Payment has not been confirmed. Your cart is still saved; check again or review your selections.', { retry: true, reference: 'Order ' + receipt.order_id });
          return;
        }
        if (attempt === RECEIPT_DELAYS.length - 1) showReceipt('Payment confirmation pending', 'Confirmation is taking longer than usual. Your cart has been kept. Check the payment status again shortly.', { retry: true, reference: 'Order ' + receipt.order_id });
      } catch {
        if (run === receiptRun) showReceipt('Payment status unavailable', 'We cannot verify your payment right now. Your cart has been kept. Please check again.', { retry: true });
        return;
      } finally { clearTimeout(timeout); }
    }
  }
  function startCheckoutReceipt() {
    if (receiptStarted || new URLSearchParams(location.search).get('checkout') !== 'success') return;
    receiptStarted = true;
    verifyCheckoutReceipt(readCheckoutReceipt());
  }
  function bindCartPage() {
    if (cartPageBound) return;
    cartPageBound = true;
    document.querySelector('[data-cart-checkout]')?.addEventListener('click', checkout);
    document.querySelector('[data-cart-retry]')?.addEventListener('click', () => { loadProducts(true).catch(() => {}); });
  }
  async function initialize(options = {}) {
    config = { ...config, ...options };
    delete config.checkoutReady;
    if (!Array.isArray(config.checkoutHosts)) config.checkoutHosts = ['checkout.stripe.com'];
    refreshCounts(); bindCartPage(); startCheckoutReceipt();
    if (Array.isArray(options.products)) {
      state.catalogComplete = false;
      state.loadVersion++; state.load = null; state.loading = false;
      setShippingPolicy(null, []);
      state.products = normalizeProducts(options.products); state.ready = true; state.checkoutReady = false; state.error = ''; reconcileCart(); renderCart();
      return state.products;
    }
    return loadProducts();
  }
  state.cart = readCart();
  state.cartSignature = cartSignature(state.cart);
  state.cartVersion = readCartVersion();
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== STORAGE_KEY + '-version') return;
    const previous = state.cartSignature;
    state.cart = readCart(); state.cartSignature = cartSignature(state.cart); state.cartVersion = readCartVersion();
    if (previous !== state.cartSignature) invalidateShipping('Your cart changed. Get updated delivery rates.');
    renderCart();
  });
  window.NinoCommerce = Object.freeze({ initialize, loadProducts, mountProduct, renderCart, checkout, getCart: () => state.cart.map(item => ({ ...item })), getProducts: () => [...state.products.values()], getCatalogStatus: () => ({ complete: state.ready && state.catalogComplete }), colorImage: (record, color) => colorImageUrl(findProduct(record), label(color)) });
  // Printful's photo of the shirt in each available color, in catalog order, one per color.
  function colorGallery(product) {
    const photos = []; const seen = new Set();
    for (const variant of product ? product.variants.values() : []) {
      if (!variant.image || seen.has(variant.image) || (variant.color && photos.some(photo => photo.color === variant.color))) continue;
      seen.add(variant.image); photos.push({ image: variant.image, color: variant.color });
    }
    return photos;
  }
  document.addEventListener('nino:product-open', async event => {
    const { product, container } = event.detail || {};
    if (container) mountProduct(product, container);
    try { await loadProducts(); } catch { return; }
    const photos = colorGallery(findProduct(product));
    if (photos.length) document.dispatchEvent(new CustomEvent('nino:color-gallery', { detail: { id: String(product?.id || ''), photos } }));
  });
  function start() { initialize(window.NINO_COMMERCE_CONFIG || {}).catch(() => {}); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
