// Campaign visit counting (Nov 4, 2026; the file was missing from that commit and added Nov 5). One anonymous
// SITE_VISIT to menu-made.com/api/funnel-event, only when the address carries a utm_campaign label (an ad or email
// link), so the Friday numbers can show visits per campaign. Nothing is sent when the browser asks not to be tracked
// (Global Privacy Control or Do Not Track). No cookies, no storage, no identifiers: each labelled page load counts once.
(() => {
  'use strict';
  try {
    const n = navigator;
    if (n.globalPrivacyControl === true || n.doNotTrack === '1' || window.doNotTrack === '1') return;
    const q = new URLSearchParams(location.search);
    const campaign = (q.get('utm_campaign') || '').trim().slice(0, 100);
    if (!campaign) return;
    const body = JSON.stringify({
      event_type: 'SITE_VISIT',
      source: (q.get('utm_source') || '').slice(0, 100) || null,
      medium: (q.get('utm_medium') || '').slice(0, 100) || null,
      campaign,
      landing_path: location.pathname.slice(0, 200),
      metadata: { site: 'ninobattaglia.com' }
    });
    // text/plain keeps this a simple cross-site request (no preflight); the worker reads the body as JSON.
    fetch('https://menu-made.com/api/funnel-event', { method: 'POST', mode: 'cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
  } catch { /* counting must never break the page */ }
})();
