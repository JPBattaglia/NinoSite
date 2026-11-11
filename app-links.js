// "Get the app" buttons (owner, Nov 10, 2026). Asks menu-made.com which stores have the Nino app public and adds a
// button for each to the page footer. Before launch the answer is empty and nothing shows.
(() => {
  'use strict';
  try {
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
      for (const [url, text] of [[links.apple, 'App Store'], [links.google, 'Google Play']]) {
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url; a.textContent = text; a.target = '_blank'; a.rel = 'noopener';
        a.style.cssText = 'display:inline-block;padding:10px 18px;border-radius:999px;background:#ff6a1f;color:#200705;font-weight:700;text-decoration:none';
        box.appendChild(a);
      }
      foot.insertBefore(box, foot.firstChild);
    }).catch(() => {});
  } catch { /* the buttons must never break the page */ }
})();
