(() => {
  'use strict';
  const fallbackShop = 'shop.html';
  const navButton = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-navigation');
  const mobile = window.matchMedia('(max-width: 980px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let gearRotation;
  function closeNavigation(restoreFocus = false) {
    nav?.classList.remove('is-open');
    navButton?.setAttribute('aria-expanded', 'false');
    navButton?.setAttribute('aria-label', 'Open navigation');
    if (restoreFocus) navButton?.focus();
  }
  navButton?.addEventListener('click', () => {
    const gear = navButton.querySelector('img');
    if (gear?.animate && !reducedMotion.matches) {
      gearRotation?.cancel();
      gearRotation = gear.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 2400, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
    }
    const open = navButton.getAttribute('aria-expanded') !== 'true';
    nav.classList.toggle('is-open', open);
    navButton.setAttribute('aria-expanded', String(open));
    navButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  mobile.addEventListener('change', () => closeNavigation());
  document.addEventListener('click', event => {
    if (nav?.classList.contains('is-open') && !event.target.closest('.site-header')) closeNavigation();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav?.classList.contains('is-open')) closeNavigation(true);
  });
  nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => closeNavigation()));
  document.querySelectorAll('[data-year]').forEach(node => { node.textContent = new Date().getFullYear(); });
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const title = value => String(value || '').trim().replace(/[.。]+$/u, '');
  const text = value => String(value || '').toLocaleLowerCase();
  function image(source, alt, eager = false) {
    const img = node('img');
    img.src = source;
    img.alt = alt;
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => { if (img.dataset.fallback) return; img.dataset.fallback = 'true'; img.src = 'assets/brand-mark.webp'; img.alt = 'Image currently unavailable'; img.classList.add('image-unavailable'); });
    return img;
  }
  function priceLabel(product) {
    if (!product.price || !product.price.currency || product.price.amount === null) return '';
    const amount = Number(product.price.amount);
    if (!Number.isFinite(amount)) return '';
    try { const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: product.price.currency }); const digits = formatter.resolvedOptions().maximumFractionDigits; const value = amount / (10 ** digits); const text = Number.isInteger(value) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: product.price.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value) : formatter.format(value); return 'From ' + text; }
    catch { return ''; }
  }
  const previewDesigns = [
    { id: 'preview-skull-wave', title: 'Skull Wave', image: 'assets/shirt-skull-wave-black.webp', gallery: ['assets/shirt-skull-wave-black.webp', 'assets/shirt-skull-wave.webp', 'assets/art-skull-wave.webp'], category: 'Shirt design preview' },
    { id: 'preview-oroboros', title: 'Oroboros', image: 'assets/shirt-oroboros.webp', gallery: ['assets/shirt-oroboros.webp', 'assets/shirt-oroboros-olive.webp', 'assets/art-oroboros.webp'], category: 'Shirt design preview' },
    { id: 'preview-ride-or-die', title: 'Ride or Die', image: 'assets/shirt-ride-or-die.webp', category: 'Shirt design preview' },
    { id: 'preview-face-landscape', title: 'Face Landscape', image: 'assets/shirt-face-landscape.webp', gallery: ['assets/shirt-face-landscape.webp', 'assets/art-face-landscape.webp'], category: 'Shirt design preview' }
  ];
  const dialog = document.getElementById('product-dialog');
  let catalog = { shop: { name: 'Nino’s Ts', url: fallbackShop }, products: [], artworks: [] };
  let resolveCatalog;
  const catalogReady = new Promise(resolve => { resolveCatalog = resolve; });
  let currentGallery = [];
  let galleryIndex = 0;
  let galleryLabels = [];
  let trigger = null;
  let activeProduct = null;
  let colorPhoto = null;
  const measure = (event, product_id = '') => document.dispatchEvent(new CustomEvent('nino:measure', { detail: { event, product_id } }));
  // Browser storage can be unavailable (private modes, blocked site data); every feature still works without it.
  function readList(store, key) { try { const value = JSON.parse(window[store].getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
  function writeList(store, key, value) { try { window[store].setItem(key, JSON.stringify(value)); } catch { /* not saved */ } }
  function spinGear(image) {
    if (!image?.animate || reducedMotion.matches) return;
    image.getAnimations?.().forEach(animation => animation.cancel());
    image.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 2400, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  let toastTimer;
  function toast(message) {
    let element = document.querySelector('[data-toast]');
    if (!element) { element = node('div', 'toast'); element.dataset.toast = ''; element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); document.body.append(element); }
    // Inside an open modal only the dialog is visible, so the toast moves there.
    const host = dialog?.open ? dialog : document.body;
    if (element.parentElement !== host) host.append(element);
    element.textContent = message; element.classList.add('is-visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2600);
  }
  const productUrl = record => { const url = new URL('shop.html', location.href); url.searchParams.set('product', record.id); return url.href; };
  async function shareProduct(record, button) {
    if (!record) return;
    const url = productUrl(record);
    const name = title(record.title);
    const status = document.querySelector('[data-share-status]');
    // Phones get the native share sheet; desktops copy the link.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: name + ' — Nino Battaglia', text: 'Check out “' + name + '” by Nino Battaglia', url }); return; }
      catch (error) { if (error?.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied'); if (status) status.textContent = 'Product link copied.'; }
    catch {
      let field = document.querySelector('[data-product-link]');
      if (!field) { field = node('input'); field.type = 'url'; field.readOnly = true; field.dataset.productLink = ''; field.setAttribute('aria-label', 'Product link to copy'); }
      (button || document.querySelector('[data-share-product]'))?.after(field);
      field.value = url; field.focus(); field.select();
      if (status) status.textContent = 'Select and copy this product link.';
    }
  }
  const share = document.querySelector('[data-share-product]');
  if (share) share.textContent = 'Send to a friend ↗';
  share?.addEventListener('click', () => shareProduct(activeProduct, share));
  // Recently viewed shirts, newest first. The slug survives the switch to live product IDs.
  const VIEWED_KEY = 'nino-recently-viewed';
  function rememberViewed(record) {
    const list = readList('localStorage', VIEWED_KEY).filter(entry => entry && entry.id !== record.id && !(record.slug && entry.slug === record.slug));
    list.unshift({ id: record.id, slug: record.slug || '' });
    writeList('localStorage', VIEWED_KEY, list.slice(0, 8));
  }
  function viewedRecords(excludeId) {
    const seen = new Set();
    return readList('localStorage', VIEWED_KEY)
      .map(entry => catalog.products.find(item => item.id === entry?.id) || (entry?.slug ? catalog.products.find(item => item.slug === entry.slug) : null))
      .filter(record => record && record.id !== excludeId && !seen.has(record.id) && seen.add(record.id));
  }
  function miniCard(record) {
    const link = node('a', 'mini-card');
    link.href = 'shop.html?product=' + encodeURIComponent(record.id);
    link.setAttribute('aria-haspopup', 'dialog');
    link.append(image(record.image, ''), node('span', '', title(record.title)));
    link.addEventListener('click', event => { event.preventDefault(); openRecord(record, 'product', link); });
    return link;
  }
  function renderViewed() {
    const section = document.querySelector('[data-recently-viewed]');
    if (section) {
      const records = viewedRecords('');
      section.querySelector('[data-recent-row]').replaceChildren(...records.map(miniCard));
      section.hidden = !records.length;
    }
    const inDialog = document.querySelector('[data-dialog-recent]');
    if (inDialog) {
      const records = activeProduct ? viewedRecords(activeProduct.id).slice(0, 6) : [];
      inDialog.querySelector('.dialog-recent-row').replaceChildren(...records.map(miniCard));
      inDialog.hidden = !records.length;
    }
  }
  if (dialog && !dialog.querySelector('[data-dialog-recent]')) {
    const recent = node('div', 'dialog-recent'); recent.dataset.dialogRecent = ''; recent.hidden = true;
    recent.append(node('p', 'eyebrow', 'Recently viewed'), node('div', 'dialog-recent-row'));
    dialog.querySelector('.dialog-copy')?.append(recent);
  }
  document.querySelector('[data-recent-clear]')?.addEventListener('click', () => {
    writeList('localStorage', VIEWED_KEY, []); renderViewed();
    document.getElementById('product-search')?.focus();
  });
  // The open product is reflected in the shop URL so it can be shared or bookmarked.
  // Opening the preview adds a history entry, so the browser's Back button closes it and
  // returns to the shop instead of leaving for the previous page.
  let dialogEntry = false, closingFromHistory = false;
  function setProductParam(id, push = false) {
    const shop = Boolean(document.querySelector('[data-shop-products]'));
    const next = new URL(location.href);
    if (shop) { if (id) next.searchParams.set('product', id); else next.searchParams.delete('product'); }
    const url = next.pathname + next.search + next.hash;
    if (push) { history.pushState({ ninoDialog: true }, '', url); dialogEntry = true; }
    else if (shop) history.replaceState(dialogEntry && id ? { ninoDialog: true } : null, '', url);
  }
  addEventListener('popstate', () => {
    if (dialog?.open && !history.state?.ninoDialog) { closingFromHistory = true; dialog.close(); }
  });
  function showImage(index) {
    if (!currentGallery.length) return;
    galleryIndex = (index + currentGallery.length) % currentGallery.length;
    const container = document.querySelector('[data-dialog-image]');
    container.replaceChildren(image(currentGallery[galleryIndex], document.getElementById('dialog-title').textContent, true));
    document.querySelectorAll('[data-gallery-index]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.galleryIndex) === galleryIndex));
    });
  }
  function openRecord(record, kind, opener) {
    if (!dialog || typeof dialog.showModal !== 'function') {
      if (kind === 'product') location.href = 'shop.html?product=' + encodeURIComponent(record.id);
      return;
    }
    // Switching products inside an open preview keeps focus returning to the original card.
    if (!dialog.open) trigger = opener || document.activeElement;
    activeProduct = kind === 'product' ? record : null;
    document.querySelector('[data-product-link]')?.remove();
    const shareStatus = document.querySelector('[data-share-status]'); if (shareStatus) shareStatus.textContent = '';
    const question = document.querySelector('[data-product-question]');
    if (question) question.href = 'mailto:hello@ninobattaglia.com?subject=' + encodeURIComponent('Question about ' + title(record.title));
    if (kind === 'product') { measure('product_view', record.id); rememberViewed(record); setProductParam(record.id, !dialog.open); }
    else if (!dialog.open) setProductParam('', true);
    renderViewed();
    currentGallery = [...new Set((Array.isArray(record.gallery) && record.gallery.length ? record.gallery : [record.image]).filter(Boolean))];
    document.getElementById('dialog-title').textContent = title(record.title);
    document.querySelector('[data-dialog-category]').textContent = record.category || (kind === 'product' ? 'Artwork on shirts' : 'Original artwork');
    const price = document.querySelector('[data-dialog-price]');
    price.textContent = kind === 'product' ? priceLabel(record) : '';
    price.hidden = !price.textContent;
    let description = String(record.description || '').replace(/<[^>]+>/g, '').trim().split(/\n\s*\n/)[0];
    if (description.length > 240) description = description.slice(0, 237).trimEnd() + '…';
    if (kind === 'preview') description = 'Original artwork by Nino Battaglia.';
    if (kind === 'product' && (!description || /— Nino’s Ts shirt collection\.?$/.test(description))) description = title(record.title) + ' — original artwork by Nino Battaglia, on a shirt. Explore the design and check the available garment options below.';
    document.querySelector('[data-dialog-description]').textContent = description;
    document.querySelector('[data-dialog-description]').hidden = !description;
    document.querySelector('[data-product-actions]').hidden = kind !== 'product';
    document.querySelector('[data-art-actions]').hidden = kind === 'product';
    colorPhoto = null;
    if (kind === 'product') document.dispatchEvent(new CustomEvent('nino:product-open', { detail: { product: record, container: document.querySelector('[data-native-purchase]') } }));
    const browse = document.querySelector('[data-art-actions] .button');
    if (kind === 'preview') {
      browse.href = catalog.shop.url;
      browse.textContent = 'Shop the collection ↗';
      browse.target = '_blank';
      browse.rel = 'noopener';
    } else {
      browse.href = 'contact.html';
      browse.textContent = 'Discuss a project ↗';
      browse.removeAttribute('target');
      browse.removeAttribute('rel');
    }
    galleryLabels = [];
    renderThumbs();
    showImage(0);
    // A color preselected while the purchase options mounted arrives before the gallery is drawn.
    if (colorPhoto) showColorPhoto();
    document.body.classList.add('modal-open');
    if (dialog.open) {
      const heading = document.getElementById('dialog-title');
      heading.tabIndex = -1; dialog.scrollTop = 0; heading.focus({ preventScroll: true });
    } else dialog.showModal();
  }
  function renderThumbs() {
    const thumbs = document.querySelector('[data-gallery-thumbs]');
    thumbs.replaceChildren();
    thumbs.hidden = currentGallery.length < 2;
    currentGallery.forEach((src, index) => {
      const button = node('button');
      button.type = 'button';
      button.dataset.galleryIndex = index;
      const color = galleryLabels[index];
      button.setAttribute('aria-label', color ? `View it in ${color}` : `View image ${index + 1} of ${currentGallery.length}`);
      if (color) button.title = color;
      button.append(image(src, ''));
      button.addEventListener('click', () => showImage(index));
      thumbs.append(button);
    });
    document.querySelectorAll('[data-gallery-index]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.galleryIndex) === galleryIndex)));
  }
  // Every shirt also shows Printful's photo of it in each available color.
  document.addEventListener('nino:color-gallery', event => {
    const { id, photos } = event.detail || {};
    if (!dialog?.open || !activeProduct || String(activeProduct.id) !== id || !Array.isArray(photos)) return;
    let added = false;
    for (const photo of photos) {
      if (!photo?.image || currentGallery.includes(photo.image)) continue;
      currentGallery.push(photo.image); galleryLabels[currentGallery.length - 1] = photo.color || ''; added = true;
    }
    if (added) renderThumbs();
  });
  function showColorPhoto() {
    document.querySelector('[data-dialog-image]').replaceChildren(image(colorPhoto.image, document.getElementById('dialog-title').textContent + ' in ' + colorPhoto.color, true));
    document.querySelectorAll('[data-gallery-index]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }
  document.addEventListener('nino:color-image', event => {
    if (!event.detail?.image) return;
    colorPhoto = event.detail;
    if (dialog?.open) showColorPhoto();
  });
  document.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    if (dialogEntry && !closingFromHistory && history.state?.ninoDialog) history.back();
    else if (activeProduct) setProductParam('');
    dialogEntry = false; closingFromHistory = false;
    if (trigger && document.contains(trigger)) trigger.focus();
  });
  dialog?.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea')) return;
    if (event.key === 'ArrowRight' && currentGallery.length > 1) { event.preventDefault(); showImage(galleryIndex + 1); }
    if (event.key === 'ArrowLeft' && currentGallery.length > 1) { event.preventDefault(); showImage(galleryIndex - 1); }
  });
  const hexColor = value => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '';
  function cardSwatches(record) {
    const colors = (Array.isArray(record.options?.colors) ? record.options.colors : []).filter(color => color && typeof color.name === 'string' && hexColor(color.hex));
    if (colors.length < 2) return null;
    const row = node('div', 'card-swatches');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Choose a shirt color for ' + title(record.title));
    const picked = node('span', 'card-swatch-name');
    const shown = colors.slice(0, 5);
    shown.forEach(color => {
      const button = node('button', 'card-swatch');
      button.type = 'button';
      button.style.setProperty('--swatch', color.hex);
      button.setAttribute('aria-label', color.name);
      button.title = color.name;
      button.setAttribute('aria-pressed', String(record.preferredColor === color.name));
      button.addEventListener('click', () => {
        const chosen = record.preferredColor !== color.name;
        record.preferredColor = chosen ? color.name : '';
        row.querySelectorAll('.card-swatch').forEach(item => { item.tabIndex = item === button ? 0 : -1; });
        // Every visible card for this shirt (grid, hero, quiz) reflects the same choice.
        document.querySelectorAll('.card-swatches').forEach(group => {
          if (group.dataset.product !== record.id) return;
          group.querySelectorAll('.card-swatch').forEach(item => item.setAttribute('aria-pressed', String(chosen && item.getAttribute('aria-label') === color.name)));
          const label = group.querySelector('.card-swatch-name'); if (label) label.textContent = chosen ? color.name : '';
          // Show Printful's photo of the shirt in that color once the live catalog has it.
          const photo = group.closest('article')?.querySelector('.product-image-link img');
          const colored = chosen ? window.NinoCommerce?.colorImage?.(record, color.name) : '';
          if (photo && !photo.dataset.fallback) photo.src = colored || record.image;
        });
      });
      row.append(button);
    });
    row.dataset.product = record.id;
    // One Tab stop per card; arrow keys move between colors.
    const buttons = [...row.querySelectorAll('.card-swatch')];
    const current = buttons.find(button => button.getAttribute('aria-pressed') === 'true') || buttons[0];
    buttons.forEach(button => { button.tabIndex = button === current ? 0 : -1; });
    row.addEventListener('keydown', event => {
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((button, position) => { button.tabIndex = position === next ? 0 : -1; });
      buttons[next].focus();
    });
    if (colors.length > shown.length) {
      const more = node('span', 'card-swatch-more', '+' + (colors.length - shown.length));
      more.title = colors.slice(shown.length).map(color => color.name).join(', ');
      more.setAttribute('aria-label', (colors.length - shown.length) + ' more colors in the product view');
      row.append(more);
    }
    picked.textContent = colors.some(color => color.name === record.preferredColor) ? record.preferredColor : '';
    picked.setAttribute('aria-live', 'polite');
    row.append(picked);
    return row;
  }
  function recordCard(record, kind) {
    const article = node('article', kind === 'art' ? 'art-tile' : 'product-card');
    article.dataset.record = record.id;
    article.dataset.discipline = record.category || '';
    const link = node('a', kind === 'art' ? 'art-open' : 'product-image-link');
    link.href = kind === 'product' ? 'shop.html?product=' + encodeURIComponent(record.id) : kind === 'art' ? 'art.html?art=' + encodeURIComponent(record.id) : 'shop.html';
    link.setAttribute('aria-haspopup', 'dialog');
    link.setAttribute('aria-label', `Preview ${title(record.title)}`);
    const photo = image(record.image, record.imageUnavailable ? 'Product image not available yet' : title(record.title));
    if (kind === 'art') { const frame = node('span', 'art-image'); frame.append(photo); link.append(frame); }
    else {
      link.append(photo); const mark = node('span', 'product-open-mark', '↗'); mark.setAttribute('aria-hidden', 'true'); link.append(mark);
      const badge = kind === 'product' && record.new === true ? 'New' : '';
      if (badge) { link.append(node('span', 'product-badge', badge)); link.setAttribute('aria-label', `Preview ${title(record.title)} (${badge.toLowerCase()})`); }
    }
    link.addEventListener('click', event => { event.preventDefault(); openRecord(record, kind, link); });
    article.append(link);
    if (kind !== 'art') article.append(node('p', 'product-category', record.category || 'Artwork on shirts'));
    const heading = node('h3');
    const titleLink = node('a', '', title(record.title));
    titleLink.href = link.href;
    titleLink.addEventListener('click', event => { event.preventDefault(); openRecord(record, kind, titleLink); });
    heading.append(titleLink);
    article.append(heading);
    if (kind === 'art') article.append(node('p', '', record.category || 'Artwork'));
    if (kind === 'product') article.append(node('p', 'product-price', priceLabel(record) || 'View shirt details'));
    if (kind === 'product') { const swatches = cardSwatches(record); if (swatches) article.append(swatches); }
    return article;
  }
  function shopLink(label) {
    const link = node('a', '', label);
    link.href = catalog.shop.url;
    link.target = '_blank'; link.rel = 'noopener';
    return link;
  }
  function previewCollection(container) {
    container.replaceChildren(...previewDesigns.map(record => recordCard(record, 'preview')));
    const note = node('div', 'preview-collection-note');
    note.append(node('p', '', 'Explore Nino’s shirt designs and choose your own point of view.'), shopLink('Shop the collection ↗'));
    container.after(note);
  }
  function renderFilters(container, categories, dataKey, handler) {
    if (!container) return;
    if (categories.length < 2) { container.hidden = true; return; }
    categories.forEach(category => {
      const button = node('button', 'filter-button', category);
      button.type = 'button'; button.dataset[dataKey] = category;
      button.setAttribute('aria-pressed', 'false'); container.append(button);
    });
    container.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || !container.contains(button)) return;
      container.querySelectorAll('button').forEach(item => { const active = item === button; item.classList.toggle('is-active', active); item.setAttribute('aria-pressed', String(active)); });
      handler(button.dataset[dataKey]);
    });
  }
  function initializeProducts() {
    const featured = document.querySelector('[data-featured-products]');
    if (featured) {
      if (catalog.products.length) {
        const selection = [...catalog.products.filter(item => item.featured), ...catalog.products.filter(item => !item.featured)].slice(0, 4);
        featured.replaceChildren(...selection.map(record => recordCard(record, 'product')));
      } else previewCollection(featured);
    }
    const grid = document.querySelector('[data-shop-products]');
    if (!grid) return;
    if (!catalog.products.length) {
      previewCollection(grid);
      document.querySelector('[data-result-count]').textContent = 'Shirt design previews';
      document.querySelector('[data-product-filters]').hidden = true;
      document.querySelector('.collection-toolbar').hidden = true;
      return;
    }
    const query = new URLSearchParams(location.search);
    const search = document.getElementById('product-search');
    const clear = document.querySelector('[data-search-clear]');
    const loadMore = document.querySelector('[data-load-more]');
    const sort = document.getElementById('product-sort');
    const state = { category: query.get('category') || 'all', collection: query.get('collection') || '', search: query.get('q') || '', limit: 24 };
    sort.value = ['title', 'featured'].includes(query.get('sort')) ? query.get('sort') : 'featured';
    search.value = state.search;
    const categories = [...new Set(catalog.products.map(item => item.category).filter(Boolean))];
    if (!categories.includes(state.category)) state.category = 'all';
    const collections = (Array.isArray(catalog.shop.collections) ? catalog.shop.collections : []).filter(collection => collection?.id && catalog.products.some(item => (item.collections || []).includes(collection.id)));
    if (!collections.some(collection => collection.id === state.collection)) state.collection = '';
    // Categories and collections are two ways into the same grid; choosing one clears the other.
    renderFilters(document.querySelector('[data-product-filters]'), categories, 'category', value => { state.category = value; state.collection = ''; state.limit = 24; render(); });
    const collectionRow = document.querySelector('[data-collection-filters]');
    if (collectionRow && collections.length) {
      collectionRow.hidden = false;
      const chips = collectionRow.querySelector('[data-collection-chips]') || collectionRow;
      collections.forEach(collection => {
        const button = node('button', 'collection-chip', collection.name);
        button.type = 'button'; button.dataset.collection = collection.id;
        if (collection.blurb) button.title = collection.blurb;
        button.setAttribute('aria-pressed', 'false');
        chips.append(button);
      });
      chips.addEventListener('click', event => {
        const button = event.target.closest('[data-collection]');
        if (!button) return;
        state.collection = state.collection === button.dataset.collection ? '' : button.dataset.collection;
        state.category = 'all'; state.limit = 24; render();
      });
      // On small screens the chips collapse into a dropdown (see .collection-select in main.css).
      const picker = node('select', 'collection-select');
      picker.setAttribute('aria-labelledby', 'collections-label');
      picker.append(new Option('Browse collections', ''), ...collections.map(collection => new Option(collection.name, collection.id)));
      picker.value = state.collection;
      picker.addEventListener('change', () => { state.collection = picker.value; state.category = 'all'; state.limit = 24; render(); });
      collectionRow.append(picker);
    }
    const terms = () => text(state.search).split(/\s+/).filter(Boolean);
    const filtered = () => catalog.products.filter(item => (state.category === 'all' || item.category === state.category) && (!state.collection || (item.collections || []).includes(state.collection)) && terms().every(term => text(item.title + ' ' + (item.description || '') + ' ' + (item.category || '')).includes(term)));
    const section = grid.closest('.shop-section');
    function render() {
      let products = filtered();
      if (sort.value === 'title') products.sort((a, b) => a.title.localeCompare(b.title));
      else products.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
      const visible = products.slice(0, state.limit);
      grid.replaceChildren(...visible.map(record => recordCard(record, 'product')));
      if (!products.length) {
        const empty = node('p', 'empty-state', 'No designs match this search. Try a different word or explore the full collection.');
        grid.append(empty);
      }
      const collectionName = collections.find(collection => collection.id === state.collection)?.name;
      document.querySelector('[data-result-count]').textContent = `Showing ${Math.min(state.limit, products.length)} of ${products.length} ${products.length === 1 ? 'shirt' : 'shirts'}${collectionName ? ' in ' + collectionName : ''}${state.search ? ' matching your search' : ''}`;
      loadMore.hidden = products.length <= state.limit;
      const showAll = document.querySelector('[data-show-all-products]');
      if (showAll) { showAll.hidden = products.length <= state.limit; showAll.textContent = `Show all ${products.length} shirts`; }
      clear.hidden = !state.search;
      const next = new URL(location.href);
      for (const [key, value] of [['q', state.search], ['category', state.category === 'all' ? '' : state.category], ['collection', state.collection], ['sort', sort.value === 'featured' ? '' : sort.value]]) { if (value) next.searchParams.set(key, value); else next.searchParams.delete(key); }
      history.replaceState(null, '', next.pathname + next.search + next.hash);
      document.querySelectorAll('[data-category]').forEach(button => { const active = button.dataset.category === state.category; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
      const collectionPicker = document.querySelector('.collection-select'); if (collectionPicker) { collectionPicker.value = state.collection; collectionPicker.classList.toggle('is-set', Boolean(state.collection)); }
      document.querySelectorAll('[data-collection]').forEach(button => { const active = button.dataset.collection === state.collection; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
      // Section tone follows what is on screen: picks lift, originals go teal, seasonal goes warm.
      if (section) section.dataset.band = state.collection === 'ninos-picks' ? 'lift' : state.category === 'Originals' ? 'teal' : state.category === 'Seasonal' ? 'warm' : '';
    }
    // Shuffle: a random shirt from whatever is currently filtered, avoiding the last ten picks.
    const SHUFFLE_KEY = 'nino-shuffle-recent';
    document.querySelectorAll('[data-shuffle]').forEach(shuffleButton => shuffleButton.addEventListener('click', event => {
      const button = event.currentTarget;
      const gear = button.querySelector('img'); if (gear) spinGear(gear);
      const pool = filtered();
      if (!pool.length) { toast('No shirts match these filters yet.'); return; }
      let recent = readList('sessionStorage', SHUFFLE_KEY);
      let options = pool.filter(item => !recent.includes(item.id));
      if (!options.length) { recent = recent.filter(id => !pool.some(item => item.id === id)); options = pool.length > 1 ? pool.filter(item => item.id !== activeProduct?.id) : pool; }
      const pick = options[Math.floor(Math.random() * options.length)];
      writeList('sessionStorage', SHUFFLE_KEY, [pick.id, ...recent].slice(0, 10));
      openRecord(pick, 'product', button);
    }));
    renderHero();
    search.addEventListener('input', () => { state.search = search.value; state.limit = 24; render(); });
    document.querySelector('[data-search-form]').addEventListener('submit', event => event.preventDefault());
    clear.addEventListener('click', () => { search.value = ''; state.search = ''; state.limit = 24; render(); search.focus(); });
    sort.addEventListener('change', render);
    loadMore.addEventListener('click', () => { const previous = state.limit; state.limit += 24; render(); grid.querySelectorAll('.product-image-link')[previous]?.focus(); });
    document.querySelector('[data-show-all-products]')?.addEventListener('click', () => { state.limit = catalog.products.length; render(); });
    render();
    const requestedId = query.get('product');
    const requested = catalog.products.find(item => item.id === requestedId) || catalog.products.find(item => (item.aliases || []).includes(requestedId));
    if (requested) {
      document.title = title(requested.title) + ' — Nino Battaglia';
      document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
      document.querySelector('meta[property="og:image"]')?.setAttribute('content', new URL(requested.image, location.href).href);
    }
    if (requested) openRecord(requested, 'product');
    renderViewed();
  }
  // Shop hero: one featured shirt, chosen on each visit (no auto-rotation).
  function renderHero() {
    const hero = document.querySelector('[data-shop-hero]');
    const choices = catalog.products.filter(item => item.featured);
    if (!hero || !choices.length) return;
    const record = choices[Math.floor(Math.random() * choices.length)];
    const picture = node('a', 'shop-hero-image');
    picture.href = 'shop.html?product=' + encodeURIComponent(record.id);
    picture.setAttribute('aria-haspopup', 'dialog');
    picture.setAttribute('aria-label', 'Preview ' + title(record.title));
    picture.append(image(record.image, title(record.title), true));
    picture.addEventListener('click', event => { event.preventDefault(); openRecord(record, 'product', picture); });
    const copy = node('div', 'shop-hero-copy');
    const heading = node('h2', '', title(record.title));
    const price = node('p', 'shop-hero-price', priceLabel(record));
    price.hidden = !price.textContent;
    const actions = node('div', 'shop-hero-actions');
    const shop = node('button', 'button button-coral', 'Shop now');
    shop.type = 'button'; shop.setAttribute('aria-haspopup', 'dialog');
    const arrow = node('span', '', '↗'); arrow.setAttribute('aria-hidden', 'true'); shop.append(arrow);
    shop.addEventListener('click', () => openRecord(record, 'product', shop));
    const quiz = node('a', 'text-link', 'Which shirt are you? ↗'); quiz.href = 'quiz.html';
    actions.append(shop, quiz);
    copy.append(node('p', 'eyebrow', 'Featured design'), heading, price, actions);
    const swatches = cardSwatches(record); if (swatches) copy.insertBefore(swatches, actions);
    hero.replaceChildren(picture, copy);
    hero.hidden = false;
  }
  function initializeArt() {
    const featured = document.querySelector('[data-featured-art]');
    if (featured) {
      const selection = [...catalog.artworks.filter(item => item.featured), ...catalog.artworks.filter(item => !item.featured)];
      featured.replaceChildren(...selection.slice(0, Number(featured.dataset.limit) || 6).map(record => recordCard(record, 'art')));
    }
    const grid = document.querySelector('[data-art-grid]');
    if (!grid) return;
    function render(category) {
      const records = catalog.artworks.filter(item => category === 'all' || item.category === category);
      grid.replaceChildren(...records.map(record => recordCard(record, 'art')));
      const count = document.querySelector('[data-art-count]');
      if (count) count.textContent = `${records.length} ${records.length === 1 ? 'piece' : 'pieces'}${category === 'all' ? '' : ' / ' + category}`;
      if (!records.length) grid.append(node('p', 'empty-state', 'Choose another category to explore Nino’s work.'));
    }
    renderFilters(document.querySelector('[data-art-filters]'), [...new Set(catalog.artworks.map(item => item.category).filter(Boolean))], 'artCategory', render);
    render('all');
    const requested = catalog.artworks.find(item => item.id === new URLSearchParams(location.search).get('art'));
    if (requested) openRecord(requested, 'art');
  }
  async function initializeCatalog() {
    try {
      const response = await fetch('catalog.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Catalog unavailable');
      const data = await response.json();
      catalog = {
        shop: { ...(data.shop || {}), url: 'shop.html' },
        products: (Array.isArray(data.products) ? data.products : []).filter(item => item.id && item.title && item.image),
        artworks: (Array.isArray(data.artworks) ? data.artworks : []).filter(item => item.id && item.title && item.image)
      };
      document.querySelectorAll('[data-shop-link]').forEach(link => { link.href = catalog.shop.url; });
      if (data.shop?.contactUrl) document.querySelectorAll('[data-contact-instruction]').forEach(item => { item.hidden = true; });
      initializeArt();
      // Completed provider snapshots include future products without a site rebuild.
      // Keep the curated catalog when credentials, initial sync or the API are unavailable.
      let timer;
      try {
        const synced = await Promise.race([
          (async () => {
            if (!window.NinoCommerce) return null;
            const records = await window.NinoCommerce.loadProducts();
            const { storefrontProducts } = await import('./catalog-sync.mjs?v=20261024w');
            return storefrontProducts(catalog.products, records, window.NinoCommerce.getCatalogStatus().complete);
          })(),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })
        ]);
        if (synced) catalog.products = synced;
      } catch { /* The original collection remains browseable during an outage. */ }
      finally { clearTimeout(timer); }
      initializeProducts();
      resolveCatalog();
    } catch {
      resolveCatalog();
      document.querySelectorAll('[data-featured-products],[data-shop-products]').forEach(previewCollection);
      document.querySelectorAll('[data-featured-art],[data-art-grid]').forEach(container => {
        const message = node('p', 'empty-state', 'The collection could not be loaded. Please refresh this page. ');
        message.append(shopLink('Return to the shop ↗')); container.replaceChildren(message);
      });
      const count = document.querySelector('[data-result-count]'); if (count) count.textContent = 'Shirt design previews';
      document.querySelector('.collection-toolbar')?.setAttribute('hidden', '');
      document.querySelector('[data-product-filters]')?.setAttribute('hidden', '');
    }
  }
  document.querySelector('[data-inquiry-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const field = key => String(data.get(key) || '').trim();
    const subject = (/order/i.test(field('type')) ? 'Order question' : 'Project inquiry: ' + field('type')) + ' — ' + field('name');
    const body = ['Name: ' + field('name'), 'Reply to: ' + field('email'), 'Project: ' + field('type'), 'Timing: ' + (field('timing') || 'Not specified'), '', field('message')].join('\n');
    location.href = 'mailto:hello@ninobattaglia.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  });
  // "Which Nino shirt are you?" — questions and results live in quiz.html (#quiz-data) so they can be edited without touching code.
  (function quiz() {
    const root = document.querySelector('[data-quiz]');
    const source = document.getElementById('quiz-data');
    if (!root || !source) return;
    let data;
    try { data = JSON.parse(source.textContent); } catch { return; }
    const questions = Array.isArray(data.questions) ? data.questions.filter(item => item?.q && Array.isArray(item.answers) && item.answers.length) : [];
    const results = data.results && typeof data.results === 'object' ? data.results : {};
    if (!questions.length) return;
    const stage = root.querySelector('[data-quiz-stage]');
    const outcome = root.querySelector('[data-quiz-result]');
    const dots = root.querySelector('[data-quiz-dots]');
    const step = root.querySelector('[data-quiz-step]');
    const heading = root.querySelector('[data-quiz-question]');
    const answers = root.querySelector('[data-quiz-answers]');
    const back = root.querySelector('[data-quiz-back]');
    let picks = [];
    dots.replaceChildren(...questions.map(() => node('span')));
    function setResultParam(id) {
      const next = new URL(location.href);
      if (id) next.searchParams.set('result', id); else next.searchParams.delete('result');
      history.replaceState(null, '', next.pathname + next.search + next.hash);
    }
    function ask(index, focus = true) {
      stage.hidden = false; outcome.hidden = true;
      const question = questions[index];
      step.textContent = `Question ${index + 1} of ${questions.length}`;
      heading.textContent = question.q;
      [...dots.children].forEach((dot, position) => { dot.classList.toggle('is-done', position < index); dot.classList.toggle('is-current', position === index); });
      answers.replaceChildren(...question.answers.map(answer => {
        const button = node('button', 'quiz-answer', answer.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          picks = picks.slice(0, index); picks[index] = answer.result;
          if (index + 1 < questions.length) ask(index + 1); else finish();
        });
        return button;
      }));
      back.hidden = index === 0;
      back.onclick = () => ask(index - 1);
      if (focus) heading.focus({ preventScroll: false });
    }
    function finish() {
      const tally = new Map();
      picks.forEach((id, order) => { const entry = tally.get(id) || { count: 0, last: 0 }; entry.count++; entry.last = order; tally.set(id, entry); });
      // Most answers wins; a tie goes to the more recent answer.
      const [winner] = [...tally].filter(([id]) => results[id]).sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)[0] || [];
      showResult(winner || Object.keys(results)[0], true);
    }
    async function showResult(id, fromQuiz) {
      const result = results[id];
      if (!result) { ask(0, false); return; }
      setResultParam(id);
      stage.hidden = true; outcome.hidden = false;
      outcome.querySelector('[data-result-name]').textContent = result.name;
      outcome.querySelector('[data-result-line]').textContent = result.line || '';
      const more = outcome.querySelector('[data-result-more]');
      const params = result.collection ? 'collection=' + encodeURIComponent(result.collection) : 'category=' + encodeURIComponent(result.category || '');
      more.href = 'shop.html?' + params;
      outcome.querySelector('[data-result-intro]').textContent = fromQuiz ? 'Your Nino shirt match' : 'A friend’s Nino shirt match';
      const retake = outcome.querySelector('[data-quiz-restart]');
      retake.textContent = fromQuiz ? 'Take the quiz again ↺' : 'Take the quiz yourself ↗';
      const grid = outcome.querySelector('[data-result-products]');
      grid.replaceChildren(node('p', 'loading-state', 'Finding your shirts…'));
      outcome.querySelector('[data-result-heading]').focus({ preventScroll: false });
      await catalogReady;
      const matches = catalog.products.filter(item => result.collection ? (item.collections || []).includes(result.collection) : item.category === result.category);
      const ordered = [...matches.filter(item => item.featured), ...matches.filter(item => !item.featured)].slice(0, 4);
      more.textContent = `See all ${matches.length} in the shop ↗`;
      more.hidden = !matches.length;
      if (!ordered.length) { grid.replaceChildren(node('p', 'empty-state', 'These shirts are taking a break. Explore the full collection instead.')); return; }
      const open = document.documentElement.dataset.checkout === 'open';
      grid.replaceChildren(...ordered.map((record, index) => {
        const card = recordCard(record, 'product');
        if (index === 0) card.classList.add('quiz-hero-card');
        const actions = node('div', 'quiz-card-actions');
        const choose = node('button', 'button button-coral', open ? 'Add to cart' : 'Choose size & color');
        choose.type = 'button'; choose.setAttribute('aria-haspopup', 'dialog');
        choose.setAttribute('aria-label', (open ? 'Add to cart: ' : 'Choose size and color: ') + title(record.title));
        choose.addEventListener('click', () => openRecord(record, 'product', choose));
        const send = node('button', 'text-link share-product', 'Send to a friend ↗');
        send.type = 'button'; send.setAttribute('aria-label', 'Send ' + title(record.title) + ' to a friend');
        send.addEventListener('click', () => shareProduct(record, send));
        actions.append(choose, send); card.append(actions);
        return card;
      }));
    }
    root.querySelector('[data-quiz-restart]').addEventListener('click', () => { picks = []; setResultParam(''); ask(0); });
    root.querySelector('[data-quiz-share]')?.addEventListener('click', async event => {
      const url = location.href;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: 'Which Nino shirt are you?', url }); return; } catch (error) { if (error?.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(url); toast('Result link copied'); }
      catch { event.currentTarget.textContent = url; }
    });
    const requested = new URLSearchParams(location.search).get('result');
    if (requested && results[requested]) showResult(requested, false);
    else ask(0, false);
  })();
  // Phones: a small cart button once something is in the cart.
  (function stickyCart() {
    if (document.body.dataset.page === 'cart') return;
    const nav = document.querySelector('.nav-cart [data-cart-count]');
    if (!nav) return;
    const button = node('a', 'sticky-cart');
    button.href = 'cart.html';
    const count = node('span', 'sticky-cart-count'); count.dataset.cartCount = '';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<path d="M3 4h2.2l2.1 10.2a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.2L20.6 8H6.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/>';
    button.append(icon, count);
    document.body.append(button);
    const sync = () => {
      const value = Number(nav.textContent) || 0;
      count.textContent = String(value);
      button.setAttribute('aria-label', `Cart, ${value} ${value === 1 ? 'item' : 'items'}`);
      button.classList.toggle('has-items', value > 0);
    };
    new MutationObserver(sync).observe(nav, { childList: true, characterData: true, subtree: true });
    sync();
    // Step aside when the footer (with its links) is on screen.
    const footer = document.querySelector('.site-footer');
    if (footer && 'IntersectionObserver' in window) new IntersectionObserver(([entry]) => button.classList.toggle('near-footer', entry.isIntersecting)).observe(footer);
  })();
  // About page photo: shown only once the image file exists.
  document.querySelectorAll('[data-optional-photo]').forEach(figure => {
    const photo = figure.querySelector('img');
    const hide = () => { figure.hidden = true; figure.closest('[data-has-photo]')?.removeAttribute('data-has-photo'); };
    const show = () => { figure.hidden = false; figure.closest('.about-intro')?.setAttribute('data-has-photo', ''); };
    if (!photo) return hide();
    if (photo.complete) { if (photo.naturalWidth) show(); else hide(); }
    photo.addEventListener('load', show); photo.addEventListener('error', hide);
  });
  (function reveal() {
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const targets = document.querySelectorAll('main > section, .art-tile, .product-card, .service-detail, .contact-card');
    if (!targets.length) return;
    document.documentElement.classList.add('js-reveal');
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
    const watch = el => { if (el.classList.contains('reveal')) return; el.classList.add('reveal'); const r = el.getBoundingClientRect(); if (r.top < innerHeight) el.classList.add('is-visible'); else io.observe(el); };
    targets.forEach(watch);
    new MutationObserver(() => document.querySelectorAll('.art-tile, .product-card').forEach(watch)).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  })();
  initializeCatalog();
})();
