(() => {
  'use strict';
  const key = 'nino-optional-measurement';
  const allowed = new Set(['page_view', 'product_view', 'add_to_cart', 'checkout_attempt', 'checkout_opened']);
  const privacySignal = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
  const consent = () => { try { return localStorage.getItem(key) === 'yes' && !privacySignal(); } catch { return false; } };
  let pageSent = false;
  let count = 0;
  function record(event, productId = '') {
    if (!consent() || !allowed.has(event) || count >= 100) return;
    const base = window.NINO_COMMERCE_CONFIG?.apiBase;
    if (!base) return;
    let endpoint; try { endpoint = new URL('/api/measurement', base); if (endpoint.protocol !== 'https:') return; } catch { return; }
    const product_id = /^\d{1,20}$/.test(String(productId)) ? String(productId) : '';
    count++;
    // No identifiers, URLs, search terms, form values, cart contents or payment data.
    fetch(endpoint.href, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, product_id }) }).catch(() => {});
  }
  const sendPage = () => { if (!pageSent && consent()) { record('page_view'); pageSent = true; } };
  document.addEventListener('nino:measure', event => record(event.detail?.event, event.detail?.product_id));
  document.querySelectorAll('[data-measurement-consent]').forEach(input => {
    const status = document.querySelector('[data-measurement-status]');
    const update = () => {
      input.checked = consent(); input.disabled = privacySignal();
      if (status) status.textContent = privacySignal() ? 'Your browser privacy signal keeps measurement off.' : input.checked ? 'Optional measurement is on. You can turn it off at any time.' : 'Optional measurement is off.';
    };
    input.addEventListener('change', () => {
      try { localStorage.setItem(key, input.checked ? 'yes' : 'no'); } catch { if (status) status.textContent = 'This browser cannot save your preference. Measurement stays off.'; input.checked = false; return; }
      update(); sendPage();
    });
    update();
    window.addEventListener('storage', update);
  });
  sendPage();
})();
