// Staff merch page (stage 10, logo-first since Oct 28, 2026): upload the business's logo, see it straight away on
// typical restaurant merch (shirts, aprons, hats, mugs, coasters...), pick colours, sizes and quantities, optionally add
// shirts in Nino Battaglia's designs, get Printful's delivery price, then pay with Stripe.
// Mockups are drawn here from Printful's own mockup templates (product photo + print area), served by
// /api/merch/products. Every price is re-checked and quoted by menu-made.com (/api/merch/quote) before payment, so
// nothing shown here is trusted at checkout. Owner testing: ?checkout=test uses Stripe test mode and a Printful draft.
(() => {
  const NINO_API = 'https://nino-printful-commerce-api.ijpbattaglia.workers.dev';
  const API = location.hostname.endsWith('menu-made.com') ? '' : 'https://menu-made.com';
  const TEST = new URLSearchParams(location.search).get('checkout') === 'test';
  // The same script runs on menu-made.com and ninobattaglia.com (copied there; menu-made's MENU repo is the source).
  const NINO = location.hostname.endsWith('ninobattaglia.com');
  const $ = (id) => document.getElementById(id);
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const decode = (t) => { const d = document.createElement('textarea'); d.innerHTML = String(t ?? ''); return d.value; };
  const esc = (t) => decode(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Same rule as booking-api/src/producers/staff-merch/pricing.js: Printful's price x 2, ending in .99.
  const listPrice = (base) => Math.floor(Math.round(base * 2) / 100) * 100 + 99;
  const discount = (n) => (n >= 24 ? 15 : n >= 12 ? 10 : 0);
  // Printful's embroidery threads; the logo's main colours are matched to these for embroidered items.
  const THREADS = { '#FFFFFF': 'White', '#000000': 'Black', '#96A1A8': 'Grey', '#A67843': 'Old Gold', '#FFCC00': 'Gold', '#E25C27': 'Orange', '#CC3366': 'Flamingo', '#CC3333': 'Red', '#660000': 'Maroon', '#333366': 'Navy', '#005397': 'Royal', '#3399FF': 'Aqua', '#6B5294': 'Purple', '#01784E': 'Kelly Green', '#7BA35A': 'Kiwi Green' };
  const state = { threads: [], logoId: null, logoUrl: null, logoW: 1, logoH: 1, skipped: false, merch: [], designs: [], cart: new Map(), item: null, color: null, design: null, designColor: null, quote: null };

  if (TEST) {
    const note = document.createElement('div');
    note.className = 'test-mode-banner'; note.setAttribute('role', 'status');
    note.textContent = 'TEST MODE: Stripe test checkout (card 4242 4242 4242 4242). Printful gets a draft only; nothing is printed.';
    document.body.prepend(note);
  }
  const status = (msg, id = 'merchStatus') => { const el = $(id); el.textContent = msg || ''; el.hidden = !msg; };
  const count = () => [...state.cart.values()].reduce((n, l) => n + l.quantity, 0);

  // ---- 1. Logo ----
  async function uploadLogo(file) {
    status('', 'logoStatus');
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > 5e6) { status('The logo must be a PNG or JPG under 5 MB.', 'logoStatus'); return; }
    $('logoDrop').classList.add('is-busy');
    try {
      const form = new FormData(); form.append('logo', file);
      const res = await fetch(API + '/api/merch/logo', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) { status(data.error || 'The logo could not be uploaded.', 'logoStatus'); return; }
      if (state.logoUrl) URL.revokeObjectURL(state.logoUrl);
      Object.assign(state, { logoId: data.logo_id, logoUrl: URL.createObjectURL(file), logoW: data.width || 1, logoH: data.height || 1, skipped: false, quote: null });
      $('logoThumb').src = state.logoUrl; $('logoThumb').hidden = false;
      state.threads = await logoThreads(state.logoUrl).catch(() => []);
      $('logoDropText').textContent = 'Logo uploaded. Choose a different file to change it.';
      $('mockStep').hidden = false;
      renderMockups(); renderPicker(); renderCart();
      $('mockStep').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally { $('logoDrop').classList.remove('is-busy'); }
  }

  // The logo's main colours (opaque pixels, at least 4% of them), matched to the nearest thread; at most six.
  async function logoThreads(url) {
    const img = new Image(); img.src = url; await img.decode();
    const size = 80; const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, size, size);
    const px = g.getImageData(0, 0, size, size).data;
    const keys = Object.keys(THREADS).map((h) => [h, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    const counts = new Map(); let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      total++;
      let best = null; let bestD = Infinity;
      for (const [h, r, gg, b] of keys) { const d = (px[i] - r) ** 2 + (px[i + 1] - gg) ** 2 + (px[i + 2] - b) ** 2; if (d < bestD) { bestD = d; best = h; } }
      counts.set(best, (counts.get(best) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= total * 0.04).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h]) => h);
  }

  // ---- 2. Mockups ----
  async function loadMerch() {
    try {
      const res = await fetch(API + '/api/merch/products?v=3', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      state.merch = data.products || [];
      if (state.logoId) renderMockups();
    } catch { $('mockGrid').innerHTML = '<p>The products could not be loaded. Please refresh the page in a minute.</p>'; }
  }

  const templateFor = (product, variant) => product.templates.find((t) => t.variant_ids.includes(variant?.id)) || product.templates[0] || null;

  // The logo inside the print area: same share, alignment and aspect as the order (merch-products.mjs logoPosition).
  function logoBox(product, box) {
    let w = box.width * product.scale; let h = w * state.logoH / state.logoW;
    const maxH = box.height * (product.align === 'top' ? 0.45 : 1);
    if (h > maxH) { h = maxH; w = h * state.logoW / state.logoH; }
    const left = box.left + (box.width - w) / 2;
    const top = product.align === 'top' ? box.top + box.height * 0.08 : box.top + (box.height - h) / 2;
    return { left, top, w, h };
  }

  function mockup(product, variant) {
    const t = templateFor(product, variant);
    const logo = state.logoUrl ? `<img class="mm-logo" alt="" src="${state.logoUrl}"` : '';
    if (!t) {
      return `<div class="merch-mock"><img class="mm-base" alt="" src="${esc(variant?.image || '')}">${logo ? `${logo} style="left:30%;top:28%;width:40%">` : ''}</div>`;
    }
    const pct = (v, of) => `${(100 * v / of).toFixed(3)}%`;
    const b = logoBox(product, t.box);
    const logoTag = logo ? `${logo} style="left:${pct(b.left, t.width)};top:${pct(b.top, t.height)};width:${pct(b.w, t.width)};height:${pct(b.h, t.height)}">` : '';
    const bg = t.background_color || variant?.color_code || '#ffffff';
    const layers = [
      t.background ? `<img class="mm-base" alt="" src="${esc(t.background)}">` : '',
      t.overlay ? '' : (t.image ? `<img class="mm-base" alt="" src="${esc(t.image)}">` : ''),
      logoTag,
      t.overlay && t.image ? `<img class="mm-base" alt="" src="${esc(t.image)}">` : ''
    ].join('');
    return `<div class="merch-mock" style="aspect-ratio:${t.width}/${t.height};background:${esc(bg)}">${layers}</div>`;
  }

  function fromPrice(product) { return Math.min(...product.variants.map((v) => listPrice(v.base_cents))); }

  function renderMockups() {
    if (!state.merch.length) { $('mockGrid').innerHTML = '<p>Loading products…</p>'; return; }
    $('mockGrid').innerHTML = state.merch.map((p) => {
      const v = p.variants.find((x) => x.color === (state.item?.key === p.key ? state.color : null)) || p.variants[0];
      const inCart = [...state.cart.values()].filter((l) => l.kind === 'logo' && l.key === p.key).reduce((n, l) => n + l.quantity, 0);
      return `<button type="button" class="merch-design merch-mock-card" data-key="${esc(p.key)}" aria-pressed="${state.item?.key === p.key}">
        ${mockup(p, v)}<span><strong>${esc(p.title)}</strong><br><small>from ${money(fromPrice(p))}${p.technique === 'embroidery' ? ' · embroidered' : ''}${inCart ? ` · ${inCart} in your order` : ''}</small></span></button>`;
    }).join('');
  }

  function pickItem(key) {
    state.item = state.merch.find((p) => p.key === key) || null;
    state.color = null;
    renderMockups(); renderPicker();
    $('pickerStep').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPicker() {
    const p = state.item;
    if (!p || !state.logoId) { $('pickerStep').hidden = true; return; }
    $('pickerStep').hidden = false;
    const colors = [...new Map(p.variants.map((v) => [v.color, v])).values()];
    if (!state.color || !colors.some((v) => v.color === state.color)) state.color = colors[0]?.color || '';
    const current = p.variants.find((v) => v.color === state.color);
    $('pickerTitle').textContent = p.title;
    $('pickerMock').innerHTML = mockup(p, current);
    $('pickerNote').textContent = p.technique === 'embroidery' ? `Embroidered${state.threads.length ? ` in ${state.threads.map((h) => THREADS[h]).join(', ')} thread` : ''}. A one-time set-up charge for digitizing your logo is added with the delivery price.` : (p.key === 'tee' ? 'Your logo on the front. Prefer one of Nino\'s designs? See "Shirts in Nino\'s designs" below.' : '');
    $('colorList').innerHTML = colors.length > 1 ? colors.map((v) => `<button type="button" class="merch-swatch" data-color="${esc(v.color)}" aria-pressed="${v.color === state.color}" title="${esc(v.color)}"><span style="background:${esc(v.color_code || '#ccc')}"></span>${esc(v.color || 'Standard')}</button>`).join('') : '';
    const sizes = p.variants.filter((v) => v.color === state.color);
    $('sizeList').innerHTML = sizes.map((v) => {
      const inCart = state.cart.get('logo:' + v.id)?.quantity || 0;
      return `<label class="merch-size"><span>${esc(v.size)} <small>${money(listPrice(v.base_cents))}</small></span><input type="number" min="0" max="250" step="1" inputmode="numeric" value="${inCart || ''}" placeholder="0" data-logo-variant="${v.id}" aria-label="Quantity, ${esc(v.size)}"></label>`;
    }).join('');
  }

  function setLogoQuantity(variantId, quantity) {
    const p = state.item; const v = p?.variants.find((x) => String(x.id) === String(variantId));
    if (!v) return;
    const q = Math.max(0, Math.min(250, Math.floor(Number(quantity) || 0)));
    const id = 'logo:' + v.id;
    if (!q) state.cart.delete(id);
    else state.cart.set(id, { kind: 'logo', key: p.key, variant_id: v.id, quantity: q, title: p.title, color: v.color, size: v.size, price: listPrice(v.base_cents), embroidery: p.technique === 'embroidery' });
    state.quote = null; renderCart(); renderMockups();
  }

  // ---- Nino designs on shirts (optional) ----
  async function loadDesigns() {
    try {
      const res = await fetch(NINO_API + '/api/products', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      state.designs = (data.products || []).filter((p) => p.variants?.some((v) => v.available));
      renderDesigns();
    } catch { $('designGrid').innerHTML = '<p>The designs could not be loaded. Please refresh the page in a minute.</p>'; }
  }
  function renderDesigns() {
    const q = $('designSearch').value.trim().toLowerCase();
    const list = state.designs.filter((p) => !q || decode(p.title).toLowerCase().includes(q));
    $('designCount').textContent = `${list.length} design${list.length === 1 ? '' : 's'}`;
    $('designGrid').innerHTML = list.slice(0, 60).map((p) => `<button type="button" class="merch-design" data-id="${esc(p.id)}" aria-pressed="${state.design?.id === p.id}">
      <img loading="lazy" src="${esc(p.image || p.variants[0]?.image || '')}" alt="" width="240" height="240"><span>${esc(p.title)}</span></button>`).join('') + (list.length > 60 ? '<p class="merch-more">Search to find more designs.</p>' : '');
  }
  function pickDesign(id) {
    state.design = state.designs.find((p) => String(p.id) === String(id)) || null;
    state.designColor = null; renderDesigns(); renderDesignPicker();
    $('designPicker').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderDesignPicker() {
    const p = state.design;
    if (!p) { $('designPicker').hidden = true; return; }
    $('designPicker').hidden = false;
    const colors = [...new Map(p.variants.filter((v) => v.available).map((v) => [v.color, v])).values()];
    if (!state.designColor || !colors.some((v) => v.color === state.designColor)) state.designColor = colors[0]?.color || null;
    const current = p.variants.find((v) => v.color === state.designColor && v.image);
    $('designTitle').textContent = decode(p.title);
    $('designImage').src = current?.image || p.image || '';
    $('designImage').alt = `${decode(p.title)} in ${state.designColor || ''}`;
    $('designColors').innerHTML = colors.map((v) => `<button type="button" class="merch-swatch" data-color="${esc(v.color)}" aria-pressed="${v.color === state.designColor}" title="${esc(v.color)}"><span style="background:${esc(v.color_hex || '#ccc')}"></span>${esc(v.color)}</button>`).join('');
    const extra = state.logoId ? 500 : 0;
    $('designSizes').innerHTML = p.variants.filter((v) => v.available && v.color === state.designColor).map((v) => {
      const inCart = state.cart.get('nino:' + v.id)?.quantity || 0;
      return `<label class="merch-size"><span>${esc(v.size)} <small>${money(v.price.amount + extra)}</small></span><input type="number" min="0" max="100" step="1" inputmode="numeric" value="${inCart || ''}" placeholder="0" data-nino-variant="${esc(v.id)}" aria-label="Quantity, size ${esc(v.size)}"></label>`;
    }).join('');
  }
  function setNinoQuantity(variantId, quantity) {
    const p = state.design; const v = p?.variants.find((x) => String(x.id) === String(variantId));
    if (!v) return;
    const q = Math.max(0, Math.min(100, Math.floor(Number(quantity) || 0)));
    const id = 'nino:' + v.id;
    if (!q) state.cart.delete(id);
    else state.cart.set(id, { kind: 'nino', product_id: String(p.id), variant_id: String(v.id), quantity: q, title: decode(p.title), color: v.color, size: v.size, price: v.price.amount });
    state.quote = null; renderCart();
  }

  // ---- Order ----
  function renderCart() {
    const lines = [...state.cart.entries()];
    const n = count(); const pct = discount(n);
    const unit = (l) => l.kind === 'nino' ? l.price + (state.logoId ? 500 : 0) : l.price;
    $('cartLines').innerHTML = lines.length ? lines.map(([id, l]) => `<li><span>${esc(l.title)}${l.kind === 'nino' ? ' (Nino design' + (state.logoId ? ', your logo on the back' : '') + ')' : ''} · ${esc([l.color, l.size].filter((x) => x && x !== 'One size').join(' · ') || 'one size')} × ${l.quantity}</span><button type="button" class="link-btn" data-remove="${esc(id)}" aria-label="Remove">Remove</button></li>`).join('') : '<li class="muted">Nothing yet. Tap a product above and enter quantities.</li>';
    const subtotal = lines.reduce((s, [, l]) => s + Math.round(unit(l) * (100 - pct) / 100) * l.quantity, 0);
    const emb = lines.some(([, l]) => l.embroidery);
    $('cartSummary').textContent = n ? `${n} item${n === 1 ? '' : 's'}${pct ? `, ${pct}% team discount` : n < 12 ? ` (add ${12 - n} more for 10% off)` : ''} · about ${money(subtotal)}${emb ? ' plus embroidery set-up' : ''} before delivery and tax` : '';
    $('detailsForm').hidden = n === 0;
    $('quoteBox').hidden = true;
  }

  const field = (id) => $(id).value.trim();
  async function getQuote(event) {
    event.preventDefault();
    status('', 'detailsStatus');
    const recipient = { name: field('shipName'), address1: field('shipAddress1'), address2: field('shipAddress2'), city: field('shipCity'), state_code: field('shipState').toUpperCase(), zip: field('shipZip'), country_code: field('shipCountry').toUpperCase() || 'US' };
    const lines = [...state.cart.values()];
    $('quoteBtn').disabled = true; $('quoteBtn').textContent = 'Checking…';
    try {
      const res = await fetch(API + '/api/merch/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: TEST ? 'sandbox' : 'live', logo_id: state.logoId, thread_colors: state.threads, recipient,
          items: lines.filter((l) => l.kind === 'nino').map(({ product_id, variant_id, quantity }) => ({ product_id, variant_id, quantity })),
          logo_items: lines.filter((l) => l.kind === 'logo').map(({ key, variant_id, quantity }) => ({ key, variant_id, quantity })) }) });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) { status(data.error || 'We could not price that order. Check the address and try again.', 'detailsStatus'); return; }
      state.quote = data; renderQuote();
    } finally { $('quoteBtn').disabled = false; $('quoteBtn').textContent = 'Get delivery price'; }
  }

  function renderQuote() {
    const q = state.quote; const p = q.pricing;
    $('quoteLines').innerHTML = q.lines.map((l) => `<tr><td>${esc(l.title)}<br><small>${esc([l.color, l.size].filter((x) => x && x !== 'One size').join(' · '))}</small></td><td>${l.quantity}</td><td>${money(l.unit_cents)}</td><td>${money(l.line_cents)}</td></tr>`).join('') +
      (p.setup_cents ? `<tr><td>Embroidery set-up (one-time)</td><td>1</td><td>${money(p.setup_cents)}</td><td>${money(p.setup_cents)}</td></tr>` : '');
    $('quoteRates').innerHTML = q.rates.map((r, i) => `<label class="merch-rate"><input type="radio" name="rate" value="${esc(r.id)}" ${i === 0 ? 'checked' : ''}> ${esc(r.name)} · ${money(r.amount_cents)}${r.min_days ? ` <small>(${r.min_days}-${r.max_days} days)</small>` : ''}</label>`).join('');
    const update = () => {
      const rate = q.rates.find((r) => r.id === document.querySelector('input[name="rate"]:checked')?.value) || q.rates[0];
      $('quoteTotal').innerHTML = `Items ${money(p.subtotal_cents)}${p.discount_percent ? ` <small>(${p.discount_percent}% team discount, you save ${money(p.discount_cents)})</small>` : ''} + delivery ${money(rate.amount_cents)} = <strong>${money(p.subtotal_cents + rate.amount_cents)}</strong> + sales tax, calculated at checkout from the delivery address`;
    };
    $('quoteRates').onchange = update; update();
    $('quoteBox').hidden = false;
    $('quoteBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function checkout() {
    status('', 'quoteStatus');
    const customer = { name: field('buyerName'), email: field('buyerEmail'), business: field('buyerBusiness'), phone: field('buyerPhone') };
    if (!customer.business || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) { status('Enter your business name and a valid email.', 'quoteStatus'); return; }
    $('payBtn').disabled = true; $('payBtn').textContent = 'Opening secure checkout…';
    const res = await fetch(API + '/api/merch/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote_id: state.quote.quote_id, rate_id: document.querySelector('input[name="rate"]:checked')?.value, customer, ...(NINO ? { return_to: 'nino' } : {}) }) });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.url) { location.href = data.url; return; }
    $('payBtn').disabled = false; $('payBtn').textContent = 'Pay securely';
    status(data.error || 'Checkout could not open. Please try again.', 'quoteStatus');
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).get('paid')) {
      status('Thank you, your order is paid. We email a proof and the tracking link as your merch is made and shipped.');
      $('merchStatus').classList.add('merch-paid'); $('merchStatus').scrollIntoView({ block: 'center' });
    }
    loadMerch(); loadDesigns();
    $('logoFile').addEventListener('change', (e) => uploadLogo(e.target.files[0]));
    const drop = $('logoDrop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); uploadLogo(e.dataTransfer.files[0]); });
    $('skipLogo').addEventListener('click', () => { state.skipped = true; $('ninoDesigns').open = true; $('ninoDesigns').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    $('mockGrid').addEventListener('click', (e) => { const b = e.target.closest('.merch-mock-card'); if (b) pickItem(b.dataset.key); });
    $('colorList').addEventListener('click', (e) => { const b = e.target.closest('.merch-swatch'); if (b) { state.color = b.dataset.color; renderPicker(); renderMockups(); } });
    $('sizeList').addEventListener('change', (e) => { if (e.target.dataset.logoVariant) setLogoQuantity(e.target.dataset.logoVariant, e.target.value); });
    $('designSearch').addEventListener('input', renderDesigns);
    $('designGrid').addEventListener('click', (e) => { const b = e.target.closest('.merch-design'); if (b) pickDesign(b.dataset.id); });
    $('designColors').addEventListener('click', (e) => { const b = e.target.closest('.merch-swatch'); if (b) { state.designColor = b.dataset.color; renderDesignPicker(); } });
    $('designSizes').addEventListener('change', (e) => { if (e.target.dataset.ninoVariant) setNinoQuantity(e.target.dataset.ninoVariant, e.target.value); });
    $('cartLines').addEventListener('click', (e) => { const id = e.target.dataset.remove; if (id) { state.cart.delete(id); state.quote = null; renderCart(); renderPicker(); renderMockups(); renderDesignPicker(); } });
    $('detailsForm').addEventListener('submit', getQuote);
    $('payBtn').addEventListener('click', checkout);
    renderCart();
  });
})();
