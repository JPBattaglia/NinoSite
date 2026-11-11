// Visit and shopping-step counting (Nov 4, 2026; steps added Nov 10, 2026). Anonymous counts sent to
// menu-made.com/api/funnel-event so the weekly numbers can show, per source, how many visits viewed a design, added
// to the cart and pressed checkout (opened checkouts and paid orders come from the order records).
// - The source is the ad or email label (utm_source / utm_medium / utm_campaign) when the address has one, otherwise
//   the website that linked here (just its name, e.g. facebook.com), otherwise "direct".
// - Each step counts once per browser tab: one visit, each design once, one add to cart, one checkout press. The
//   label and which steps were counted are kept in this tab's session storage only, and go when the tab closes.
// - No cookies, no visitor identifiers, no cart contents, no personal data.
// - Nothing is sent when the browser asks not to be tracked (Global Privacy Control or Do Not Track).
(() => {
  'use strict';
  try {
    const n = navigator;
    if (n.globalPrivacyControl === true || n.doNotTrack === '1' || window.doNotTrack === '1') return;
    const KEY = 'nino-steps';
    const ENDPOINT = 'https://menu-made.com/api/funnel-event';
    const clip = (value, max) => String(value || '').trim().slice(0, max) || null;
    let state = null;
    try { state = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { state = null; }
    const canKeep = (() => { try { sessionStorage.setItem(KEY + '-probe', '1'); sessionStorage.removeItem(KEY + '-probe'); return true; } catch { return false; } })();

    if (!state || typeof state !== 'object') {
      const q = new URLSearchParams(location.search);
      let source = clip(q.get('utm_source'), 100);
      let medium = clip(q.get('utm_medium'), 100);
      const campaign = clip(q.get('utm_campaign'), 100);
      if (!source && !campaign) {
        let host = '';
        try { host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch { host = ''; }
        if (host === location.hostname.replace(/^www\./, '')) host = '';
        // Facebook and Instagram link through l.facebook.com / lm.facebook.com / l.instagram.com.
        host = host.replace(/^(l|lm|m)\.(facebook|instagram)\.com$/, '$2.com');
        source = host ? host.slice(0, 100) : 'direct';
        medium = host ? 'referral' : 'none';
      }
      state = { source, medium, campaign, visit: false, designs: [], cart: false, checkout: false };
    }
    const save = () => { if (canKeep) try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* counting must never break the page */ } };

    function send(event_type, metadata = {}) {
      const body = JSON.stringify({
        event_type,
        source: state.source,
        medium: state.medium,
        campaign: state.campaign,
        landing_path: location.pathname.slice(0, 200),
        metadata: { site: 'ninobattaglia.com', ...metadata }
      });
      // text/plain keeps this a simple cross-site request (no preflight); the worker reads the body as JSON.
      fetch(ENDPOINT, { method: 'POST', mode: 'cors', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
    }

    function designView(id) {
      const design = /^\d{1,20}$/.test(String(id || '')) ? String(id) : '';
      if (!design || state.designs.includes(design) || state.designs.length >= 60) return;
      const first = state.designs.length === 0;
      state.designs.push(design); save();
      send('DESIGN_VIEW', { design, first });
    }

    if (!state.visit) { state.visit = true; save(); send('SITE_VISIT'); }
    else save();

    // A shirt page is a design view; so is the shop opening a design's preview (shop.html?product=<id> on load, or a
    // click, which site.js reports as a product_view).
    if (document.body?.dataset.page === 'shirt' || /\/shirts\//.test(location.pathname)) {
      const link = document.querySelector('a[href*="shop.html?product="]');
      if (link) designView(new URL(link.href, location.href).searchParams.get('product'));
    }
    const opened = new URLSearchParams(location.search).get('product');
    if (opened && /shop\.html$/.test(location.pathname)) designView(opened);

    document.addEventListener('nino:measure', event => {
      const step = event.detail?.event;
      if (step === 'product_view') designView(event.detail?.product_id);
      else if (step === 'add_to_cart' && !state.cart) { state.cart = true; save(); send('ADD_TO_CART'); }
      else if (step === 'checkout_attempt' && !state.checkout) { state.checkout = true; save(); send('CHECKOUT_CLICK'); }
    });
  } catch { /* counting must never break the page */ }
})();
