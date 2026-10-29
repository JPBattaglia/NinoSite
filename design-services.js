// Order Nino's ready-to-order design services (stage 10 of the Nino + Menu-made automation handbook).
// Checkout runs through Menu-made's order engine and Stripe account (the shirt shop's checkout stays separate);
// prices are read from Menu-made's catalog, and the buyer comes back to design-thanks.html after paying.
// Owner testing: add ?checkout=test to the page address for Stripe test mode.
(() => {
  const API = 'https://menu-made.com';
  const TEST = new URLSearchParams(location.search).get('checkout') === 'test';
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  let catalog = new Map();
  let chosen = null;

  function total() {
    const o = catalog.get(chosen);
    if (!o) return null;
    if (chosen !== 'NINO_MENU_DESIGN' || !o.design_pages) return o.price_cents;
    const pages = Number(document.querySelector('#design-order [name="pages"]').value);
    return o.price_cents + Math.max(0, pages - o.design_pages.included_pages) * o.design_pages.extra_page_cents;
  }
  // Owner decision Oct 28, 2026: only the flyer is taxed; Stripe adds the tax from the billing address.
  const TAXED = new Set(['NINO_FLYER']);
  function showTotal() {
    const t = total();
    document.querySelector('[data-design-total]').textContent = t == null ? '' : `Total ${money(t)} (USD)${TAXED.has(chosen) ? ' + sales tax, added at checkout' : ''}`;
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('design-order');
    if (!form) return;
    if (TEST) { const n = document.createElement('p'); n.className = 'design-order-status'; n.textContent = 'TEST MODE: Stripe test checkout (card 4242 4242 4242 4242).'; form.prepend(n); }
    try {
      const data = await (await fetch(API + '/api/catalog')).json();
      catalog = new Map((data.offers || []).filter((o) => /^NINO_/.test(o.code)).map((o) => [o.code, o]));
      for (const el of document.querySelectorAll('[data-design-price]')) {
        const o = catalog.get(el.dataset.designPrice);
        if (o) el.textContent = money(o.price_cents) + (o.design_pages ? ` for ${o.design_pages.included_pages} pages` : '') + (TAXED.has(o.code) ? ' + tax' : '');
        if (o && !o.on_sale && !TEST) { const b = document.querySelector(`[data-design-order="${o.code}"]`); b.disabled = true; b.firstChild.textContent = 'Opening soon '; }
      }
    } catch { /* prices stay as printed; checkout re-prices on the server */ }
    for (const button of document.querySelectorAll('[data-design-order]')) {
      button.addEventListener('click', () => {
        chosen = button.dataset.designOrder;
        const card = button.closest('.design-card');
        document.getElementById('design-order-title').textContent = card.querySelector('h3').textContent;
        form.querySelector('[data-pages-field]').hidden = chosen !== 'NINO_MENU_DESIGN';
        form.hidden = false;
        showTotal();
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        form.querySelector('[name="name"]').focus({ preventScroll: true });
      });
    }
    form.querySelector('[name="pages"]').addEventListener('change', showTotal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-design-status]');
      const value = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      if (!value('business') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) { status.textContent = 'Please enter your business name and a valid email.'; status.hidden = false; return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true; status.hidden = true;
      try {
        const res = await fetch(API + (TEST ? '/api/create-checkout-test' : '/api/create-checkout'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ key: chosen }], return_to: 'nino', ...(chosen === 'NINO_MENU_DESIGN' ? { design_pages: Number(value('pages')) } : {}),
            customer: { name: value('name'), business: value('business'), email: value('email') }, tracking: { source: 'ninobattaglia.com' } })
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.url) { location.href = data.url; return; }
        status.textContent = data.error || 'Checkout could not open. Please try again in a minute.'; status.hidden = false;
      } catch { status.textContent = 'Checkout could not open. Please check your connection and try again.'; status.hidden = false; }
      button.disabled = false;
    });
  });
})();
