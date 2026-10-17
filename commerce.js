(() => {
  'use strict';
  const STORAGE_KEY = 'nino-battaglia-cart-v1';
  const MAX_QUANTITY = 99;
  const state = { products: new Map(), cart: [], loading: false, ready: false, pending: false, checkoutReady: false, error: '', load: null, loadVersion: 0, storageAvailable: true };
  let cartPageBound = false;
  let config = { apiBase: '', productsPath: '/api/products', checkoutPath: '/api/checkout', checkoutHosts: ['checkout.stripe.com'], maxUnits: 50, maxLines: 20 };
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
        variants.set(variantId, {
          id: variantId, size, color, name, price,
          available: raw.available === true,
          maximum: quantity(raw.max_quantity) || MAX_QUANTITY,
          purchasable: raw.available === true && Boolean(price) && Boolean(size || color || name)
        });
      }
      products.set(productId, { id: productId, external_id: id(record.external_id), title: label(record.title), image: label(record.image), variants });
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
  function writeCart() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cart)); }
    catch { state.storageAvailable = false; }
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
        state.checkoutReady = data?.checkout_ready === true;
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
    if (!variants.length) { mountUnavailable(container, 'This design is not available to purchase right now.'); return; }
    const form = create('form', 'variant-picker');
    form.setAttribute('aria-label', 'Choose your product options');
    const chooser = create('div', 'variant-picker-options');
    const status = create('p', 'commerce-option-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const price = create('p', 'commerce-selected-price');
    const sizeValues = [...new Set(variants.map(item => item.size).filter(Boolean))];
    const colorValues = [...new Set(variants.map(item => item.color).filter(Boolean))];
    const fields = new Map();
    function addSelect(key, heading, values) {
      const wrapper = create('label', 'commerce-field');
      wrapper.append(create('span', '', heading));
      const select = create('select'); select.name = key;
      select.append(new Option('Choose ' + heading.toLowerCase(), ''));
      values.forEach(value => select.append(new Option(value, value)));
      wrapper.append(select); chooser.append(wrapper); fields.set(key, select);
      select.addEventListener('change', updateSelection);
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
    function updateSelection() {
      selected = null;
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
      status.textContent = state.storageAvailable ? 'Added to your cart.' : 'Added to this page’s cart. Your browser cannot save the cart between pages.';
      viewCart.hidden = false;
    });
    updateSelection();
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
    checkout.disabled = state.pending || state.loading || !state.ready || !totals().allValid || !state.checkoutReady;
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
      const source = imageUrl(product.image);
      if (source) {
        const image = create('img', 'cart-line-image'); image.src = source; image.alt = product.title; image.loading = 'lazy'; row.append(image);
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
    const signature = JSON.stringify([...items].sort((a, b) => (a.product_id + ':' + a.variant_id).localeCompare(b.product_id + ':' + b.variant_id)));
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
    try {
      await loadProducts(true);
      if (!state.checkoutReady) throw new Error('Checkout is not open yet. Your selections are saved in your cart.');
      if (!state.cart.length || !totals().allValid) throw new Error('Review the available items in your cart before checking out.');
      const items = state.cart.map(item => ({ product_id: item.product_id, variant_id: item.variant_id, quantity: item.quantity }));
      cartStatus('Opening secure checkout…');
      const response = await fetch(apiUrl(config.checkoutPath), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items, request_id: checkoutRequestId(items) }) });
      let data; try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(response.status === 409 ? 'A product option changed. Review your cart and try again.' : 'Checkout is unavailable right now. Your cart is saved; please try again.');
      let destination;
      try { destination = new URL(data?.checkout_url); }
      catch { throw new Error('Checkout could not be opened. Please try again.'); }
      if (destination.protocol !== 'https:' || !config.checkoutHosts.includes(destination.hostname)) throw new Error('Checkout could not be opened. Please try again.');
      location.assign(destination.href);
    } catch (error) {
      state.pending = false; renderCart();
      cartStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : 'Checkout is unavailable right now. Your cart is saved; please try again.', true);
    }
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
    refreshCounts(); bindCartPage();
    if (Array.isArray(options.products)) {
      state.loadVersion++; state.load = null; state.loading = false;
      state.products = normalizeProducts(options.products); state.ready = true; state.checkoutReady = false; state.error = ''; reconcileCart(); renderCart();
      return state.products;
    }
    return loadProducts();
  }
  state.cart = readCart();
  window.NinoCommerce = Object.freeze({ initialize, loadProducts, mountProduct, renderCart, checkout, getCart: () => state.cart.map(item => ({ ...item })), getProducts: () => [...state.products.values()] });
  document.addEventListener('nino:product-open', event => {
    const { product, container } = event.detail || {};
    if (container) mountProduct(product, container);
  });
  function start() { initialize(window.NINO_COMMERCE_CONFIG || {}).catch(() => {}); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
