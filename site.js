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
  let currentGallery = [];
  let galleryIndex = 0;
  let trigger = null;
  let activeProduct = null;
  const measure = (event, product_id = '') => document.dispatchEvent(new CustomEvent('nino:measure', { detail: { event, product_id } }));
  const share = document.querySelector('[data-share-product]');
  share?.addEventListener('click', async () => {
    if (!activeProduct) return;
    const url = new URL('shop.html', location.href); url.searchParams.set('product', activeProduct.id);
    const status = document.querySelector('[data-share-status]');
    try { await navigator.clipboard.writeText(url.href); share.textContent = 'Link copied ✓'; if (status) status.textContent = 'Product link copied.'; }
    catch {
      let field = document.querySelector('[data-product-link]');
      if (!field) { field = node('input'); field.type = 'url'; field.readOnly = true; field.dataset.productLink = ''; field.setAttribute('aria-label', 'Product link to copy'); share.after(field); }
      field.value = url.href; field.focus(); field.select();
      if (status) status.textContent = 'Select and copy this product link.';
    }
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
    trigger = opener || document.activeElement;
    activeProduct = kind === 'product' ? record : null;
    if (share) share.textContent = 'Copy product link ↗';
    document.querySelector('[data-product-link]')?.remove();
    const shareStatus = document.querySelector('[data-share-status]'); if (shareStatus) shareStatus.textContent = '';
    const question = document.querySelector('[data-product-question]');
    if (question) question.href = 'mailto:hello@ninobattaglia.com?subject=' + encodeURIComponent('Question about ' + title(record.title));
    if (kind === 'product') measure('product_view', record.id);
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
    const thumbs = document.querySelector('[data-gallery-thumbs]');
    thumbs.replaceChildren();
    thumbs.hidden = currentGallery.length < 2;
    currentGallery.forEach((src, index) => {
      const button = node('button');
      button.type = 'button';
      button.dataset.galleryIndex = index;
      button.setAttribute('aria-label', `View image ${index + 1} of ${currentGallery.length}`);
      button.append(image(src, ''));
      button.addEventListener('click', () => showImage(index));
      thumbs.append(button);
    });
    showImage(0);
    document.body.classList.add('modal-open');
    dialog.showModal();
  }
  document.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    if (trigger && document.contains(trigger)) trigger.focus();
  });
  dialog?.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea')) return;
    if (event.key === 'ArrowRight' && currentGallery.length > 1) { event.preventDefault(); showImage(galleryIndex + 1); }
    if (event.key === 'ArrowLeft' && currentGallery.length > 1) { event.preventDefault(); showImage(galleryIndex - 1); }
  });
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
    else { link.append(photo); const mark = node('span', 'product-open-mark', '↗'); mark.setAttribute('aria-hidden', 'true'); link.append(mark); }
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
    const state = { category: query.get('category') || 'all', search: query.get('q') || '', limit: 24 };
    sort.value = ['title', 'featured'].includes(query.get('sort')) ? query.get('sort') : 'featured';
    search.value = state.search;
    const categories = [...new Set(catalog.products.map(item => item.category).filter(Boolean))];
    if (!categories.includes(state.category)) state.category = 'all';
    renderFilters(document.querySelector('[data-product-filters]'), categories, 'category', value => { state.category = value; state.limit = 24; render(); });
    function render() {
      const terms = text(state.search).split(/\s+/).filter(Boolean);
      let products = catalog.products.filter(item => (state.category === 'all' || item.category === state.category) && terms.every(term => text(item.title + ' ' + (item.description || '') + ' ' + (item.category || '')).includes(term)));
      if (sort.value === 'title') products.sort((a, b) => a.title.localeCompare(b.title));
      else products.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
      const visible = products.slice(0, state.limit);
      grid.replaceChildren(...visible.map(record => recordCard(record, 'product')));
      if (!products.length) {
        const empty = node('p', 'empty-state', 'No designs match this search. Try a different word or explore the full collection.');
        grid.append(empty);
      }
      document.querySelector('[data-result-count]').textContent = `Showing ${Math.min(state.limit, products.length)} of ${products.length} ${products.length === 1 ? 'shirt' : 'shirts'}${state.search ? ' matching your search' : ''}`;
      loadMore.hidden = products.length <= state.limit;
      const showAll = document.querySelector('[data-show-all-products]');
      if (showAll) { showAll.hidden = products.length <= state.limit; showAll.textContent = `Show all ${products.length} shirts`; }
      clear.hidden = !state.search;
      const next = new URL(location.href);
      for (const [key, value] of [['q', state.search], ['category', state.category === 'all' ? '' : state.category], ['sort', sort.value === 'featured' ? '' : sort.value]]) { if (value) next.searchParams.set(key, value); else next.searchParams.delete(key); }
      history.replaceState(null, '', next.pathname + next.search + next.hash);
      document.querySelectorAll('[data-category]').forEach(button => { const active = button.dataset.category === state.category; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); });
    }
    search.addEventListener('input', () => { state.search = search.value; state.limit = 24; render(); });
    document.querySelector('[data-search-form]').addEventListener('submit', event => event.preventDefault());
    clear.addEventListener('click', () => { search.value = ''; state.search = ''; state.limit = 24; render(); search.focus(); });
    sort.addEventListener('change', render);
    loadMore.addEventListener('click', () => { const previous = state.limit; state.limit += 24; render(); grid.querySelectorAll('.product-image-link')[previous]?.focus(); });
    document.querySelector('[data-show-all-products]')?.addEventListener('click', () => { state.limit = catalog.products.length; render(); });
    render();
    const requested = catalog.products.find(item => item.id === query.get('product'));
    if (requested) {
      document.title = title(requested.title) + ' — Nino Battaglia';
      document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
      document.querySelector('meta[property="og:image"]')?.setAttribute('content', new URL(requested.image, location.href).href);
    }
    if (requested) openRecord(requested, 'product');
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
            const { storefrontProducts } = await import('./catalog-sync.mjs');
            return storefrontProducts(catalog.products, records, window.NinoCommerce.getCatalogStatus().complete);
          })(),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); })
        ]);
        if (synced) catalog.products = synced;
      } catch { /* The original collection remains browseable during an outage. */ }
      finally { clearTimeout(timer); }
      initializeProducts();
    } catch {
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
