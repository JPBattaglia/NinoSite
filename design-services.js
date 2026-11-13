// Order Nino's ready-to-order design services (stage 10 of the Nino + Menu-made automation handbook).
// Checkout runs through Menu-made's order engine and Stripe account (the shirt shop's checkout stays separate);
// prices are read from Menu-made's catalog, and the buyer comes back to design-thanks.html after paying.
// Owner testing: add ?checkout=test to the page address for Stripe test mode.
// Owner sandbox (owner, Nov 12, 2026): keeps test mode on in that browser until ?sandbox=off or the bar's button. It
// covers this page only; the shirt shop has no test mode and stays live. Locked Nov 13, 2026 (owner: "Lock it"): it
// turns on only from the link emailed to the owner inbox (services.html?sandbox=<owner pass>), and the pass goes with
// every test checkout; Menu-made refuses a test checkout without it. The old ?sandbox=on does nothing.
(() => {
  const API = 'https://menu-made.com';
  const KEY = 'nino-owner-sandbox';
  const PASS = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/;
  let TOKEN = '';
  try {
    const asked = new URLSearchParams(location.search).get('sandbox') || '';
    if (PASS.test(asked)) localStorage.setItem(KEY, asked);
    if (asked === 'off') localStorage.removeItem(KEY);
    TOKEN = localStorage.getItem(KEY) || '';
    if (TOKEN && !PASS.test(TOKEN)) { localStorage.removeItem(KEY); TOKEN = ''; }
  } catch { TOKEN = ''; }
  const SANDBOX = !!TOKEN;
  const TEST = SANDBOX || new URLSearchParams(location.search).get('checkout') === 'test';
  if (SANDBOX) {
    const show = () => {
      const bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:sticky;top:0;z-index:1000;background:#ffd84d;color:#1a0605;font-weight:700;text-align:center;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:center';
      const text = document.createElement('span');
      text.textContent = 'TEST MODE on this device, design services only. Card 4242 4242 4242 4242. The shirt shop is still live.';
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.textContent = 'Leave test mode';
      leave.style.cssText = 'font:inherit;font-weight:700;color:#ffd84d;background:#1a0605;border:0;border-radius:999px;padding:6px 14px;cursor:pointer';
      leave.addEventListener('click', () => {
        try { localStorage.removeItem(KEY); } catch { /* storage blocked: nothing to clear */ }
        const url = new URL(location.href);
        url.searchParams.delete('sandbox');
        url.searchParams.delete('checkout');
        location.replace(url.toString());
      });
      bar.append(text, leave);
      document.body.prepend(bar);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
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

  // Campaign labels saved by signup.js when the visitor landed (marketing plan v4): an ad visit is credited to its
  // campaign; anything else stays "ninobattaglia.com" as before.
  function designTracking() {
    try {
      if (navigator.globalPrivacyControl !== true && navigator.doNotTrack !== '1') {
        const a = JSON.parse(sessionStorage.getItem('nino-attribution') || 'null');
        if (a && (a.source || a.campaign)) return { source: a.source || 'ninobattaglia.com', ...(a.medium ? { medium: a.medium } : {}), ...(a.campaign ? { campaign: a.campaign } : {}) };
      }
    } catch {}
    return { source: 'ninobattaglia.com' };
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
          body: JSON.stringify({ items: [{ key: chosen }], return_to: 'nino', ...(TEST ? { sandbox_token: TOKEN } : {}), ...(chosen === 'NINO_MENU_DESIGN' ? { design_pages: Number(value('pages')) } : {}),
            customer: { name: value('name'), business: value('business'), email: value('email') }, tracking: designTracking() })
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.url) { location.href = data.url; return; }
        status.textContent = data.error || 'Checkout could not open. Please try again in a minute.'; status.hidden = false;
      } catch { status.textContent = 'Checkout could not open. Please check your connection and try again.'; status.hidden = false; }
      button.disabled = false;
    });
  });
})();
