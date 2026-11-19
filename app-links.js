// "Get the app" buttons (owner, Nov 10, 2026). Asks menu-made.com which stores have the Nino app public and adds a
// button for each to the page footer. Before launch the answer is empty and nothing shows. Buttons are the stores'
// official badges (owner, Nov 18, 2026).
// Inside the Nino app (owner, Nov 13, 2026) nothing shows: the app adds ?app=<member key> to every page it opens, and
// the in-app browser remembers that for the rest of the visit (session storage, so a phone's normal browser is unaffected).
(() => {
  'use strict';
  try {
    const KEY = 'nino-in-app';
    let inApp = /^[A-Za-z0-9_-]{32,64}$/.test(new URLSearchParams(location.search).get('app') || '');
    try { if (inApp) sessionStorage.setItem(KEY, '1'); else inApp = sessionStorage.getItem(KEY) === '1'; } catch { /* storage off: this page only */ }
    if (inApp) return;
    const foot = document.querySelector('footer');
    if (!foot || !window.fetch) return;
    fetch('https://menu-made.com/api/app-links/nino').then(r => r.ok ? r.json() : null).then(links => {
      if (!links || (!links.apple && !links.google)) return;
      const box = document.createElement('div');
      box.className = 'app-links';
      box.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:center;margin:18px auto;padding:0 16px';
      const label = document.createElement('span');
      label.textContent = 'Get the Nino app, with new designs 24 hours early:';
      label.style.cssText = 'font-weight:700';
      box.appendChild(label);
      // The stores' official badges (owner, Nov 18, 2026), from assets/badges.
      for (const [url, file, label, ratio] of [[links.apple, 'app-store', 'Download on the App Store', 120 / 40], [links.google, 'google-play', 'Get it on Google Play', 180 / 53.333]]) {
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        a.setAttribute('aria-label', `${label} (opens in a new tab)`);
        a.style.cssText = 'display:inline-block;line-height:0;border-radius:8px';
        const img = document.createElement('img');
        img.src = `/assets/badges/${file}.svg`; img.alt = label; img.height = 44; img.width = Math.round(44 * ratio);
        img.style.cssText = 'height:44px;width:auto;display:block';
        a.appendChild(img);
        box.appendChild(a);
      }
      foot.insertBefore(box, foot.firstChild);
    }).catch(() => {});
  } catch { /* the buttons must never break the page */ }
})();
