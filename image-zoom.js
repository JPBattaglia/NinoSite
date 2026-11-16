// Every picture on ninobattaglia.com zooms (owner, Nov 15, 2026: "Need to be able to zoom all images in the Nino app
// and site"). A tap or click on any content picture opens it full screen: pinch, drag and double-tap on a phone;
// click, the mouse wheel and drag on a computer; Esc, the close button or a tap on the dark area closes it.
// Pictures that are links (product cards, work tiles) keep opening their page; the picture there zooms.
// Model photos open in their sharp 2000px copy (/api/mockups-hd/) when there is one. Same viewer as the Nino app's.
(() => {
  'use strict';
  const SKIP = 'a, button, [role=button], header, footer, nav, .brand, .site-header, .nz-zoom, label, .swatch';
  const zoomable = (img) => img && img.tagName === 'IMG' && !img.closest(SKIP) && (img.naturalWidth || 0) >= 160 && img.getBoundingClientRect().width >= 60;

  const style = document.createElement('style');
  style.textContent = `
    main img:not(a img):not(button img), .dialog-image img { cursor: zoom-in; }
    .nz-zoom { position: fixed; inset: 0; z-index: 2147483000; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; touch-action: none; }
    .nz-zoom img { max-width: 100vw; max-height: 100vh; object-fit: contain; transform-origin: center center; will-change: transform; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: zoom-in; }
    .nz-zoom.is-zoomed img { cursor: grab; }
    .nz-zoom-close { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px); right: 12px; width: 46px; height: 46px; border-radius: 999px; border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.14); color: #fff; font: 700 28px/1 system-ui, sans-serif; cursor: pointer; }
    .nz-zoom-hint { position: absolute; left: 0; right: 0; bottom: calc(env(safe-area-inset-bottom, 0px) + 18px); margin: 0; text-align: center; color: rgba(255,255,255,.75); font: 14px system-ui, sans-serif; pointer-events: none; transition: opacity .2s; }
    .nz-zoom.is-zoomed .nz-zoom-hint { opacity: 0; }`;
  document.head.appendChild(style);

  function sharpSource(src) {
    return /\/api\/mockups\/\d+\/[a-z0-9-]+\.jpg$/.test(src) ? src.replace('/api/mockups/', '/api/mockups-hd/') : src;
  }

  function open(img) {
    const box = document.createElement('div');
    box.className = 'nz-zoom'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', img.alt || 'Picture');
    const pic = document.createElement('img');
    pic.src = img.currentSrc || img.src; pic.alt = img.alt || '';
    const sharp = sharpSource(pic.src);
    if (sharp !== pic.src) { const l = new Image(); l.onload = () => { if (pic.isConnected) pic.src = sharp; }; l.src = sharp; }
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'nz-zoom-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
    const hint = document.createElement('p');
    hint.className = 'nz-zoom-hint';
    hint.textContent = matchMedia('(hover: hover)').matches ? 'Click or scroll to zoom' : 'Pinch or double-tap to zoom';
    box.append(pic, close, hint);
    // An open design sits in a modal <dialog> (the top layer): the viewer goes inside it so it shows above it.
    (img.closest('dialog[open]') || document.body).appendChild(box);
    const lastFocus = document.activeElement;
    // Esc closes the viewer only, not the open design behind it.
    const dialog = img.closest('dialog[open]');
    const keepDialog = (e) => e.preventDefault();
    if (dialog) dialog.addEventListener('cancel', keepDialog);
    close.focus();

    let scale = 1, tx = 0, ty = 0, start = null, lastTap = 0, dragged = false;
    const clamp = () => {
      if (scale <= 1) { scale = 1; tx = 0; ty = 0; return; }
      const mx = Math.max(0, (pic.offsetWidth * scale - box.clientWidth) / 2), my = Math.max(0, (pic.offsetHeight * scale - box.clientHeight) / 2);
      tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
    };
    const apply = (animate) => { pic.style.transition = animate ? 'transform .2s' : 'none'; pic.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; box.classList.toggle('is-zoomed', scale > 1); };
    // Zoom toward a point (x, y on screen) to the new scale.
    const zoomAt = (ns, x, y) => {
      ns = Math.max(1, Math.min(5, ns));
      const cx = box.clientWidth / 2, cy = box.clientHeight / 2, k = ns / scale;
      tx = (x - cx) * (1 - k) + tx * k; ty = (y - cy) * (1 - k) + ty * k; scale = ns; clamp();
    };
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    box.addEventListener('touchstart', (e) => {
      const t = e.touches;
      if (t.length === 2) start = { d: dist(t), scale, tx, ty, mx: (t[0].clientX + t[1].clientX) / 2, my: (t[0].clientY + t[1].clientY) / 2 };
      else if (t.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300 && e.target === pic) { e.preventDefault(); if (scale > 1) { scale = 1; tx = 0; ty = 0; } else zoomAt(2.5, t[0].clientX, t[0].clientY); apply(true); lastTap = 0; return; }
        lastTap = now; start = { x: t[0].clientX, y: t[0].clientY, tx, ty };
      }
    }, { passive: false });
    box.addEventListener('touchmove', (e) => {
      const t = e.touches; if (!start) return; e.preventDefault();
      if (t.length === 2 && start.d) {
        const cx = box.clientWidth / 2, cy = box.clientHeight / 2;
        const ns = Math.max(1, Math.min(5, start.scale * dist(t) / start.d)), k = ns / start.scale;
        const mx = (t[0].clientX + t[1].clientX) / 2, my = (t[0].clientY + t[1].clientY) / 2;
        scale = ns; tx = (start.mx - cx) * (1 - k) + start.tx * k + (mx - start.mx); ty = (start.my - cy) * (1 - k) + start.ty * k + (my - start.my);
      } else if (t.length === 1 && start.x != null && scale > 1) { tx = start.tx + t[0].clientX - start.x; ty = start.ty + t[0].clientY - start.y; }
      clamp(); apply(false);
    }, { passive: false });
    box.addEventListener('touchend', (e) => { if (!e.touches.length) start = null; else if (e.touches.length === 1) start = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx, ty }; });

    // Computer: wheel zooms at the pointer, click toggles 2.5x, drag moves a zoomed picture.
    box.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); apply(false); }, { passive: false });
    let mouse = null;
    pic.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); mouse = { x: e.clientX, y: e.clientY, tx, ty }; dragged = false; });
    addEventListener('mousemove', onMove);
    addEventListener('mouseup', onUp);
    function onMove(e) {
      if (!mouse) return;
      if (Math.abs(e.clientX - mouse.x) + Math.abs(e.clientY - mouse.y) > 4) dragged = true;
      if (scale > 1) { tx = mouse.tx + e.clientX - mouse.x; ty = mouse.ty + e.clientY - mouse.y; clamp(); apply(false); }
    }
    function onUp(e) {
      if (!mouse) return;
      const wasDrag = dragged; mouse = null;
      if (!wasDrag && e.target === pic && matchMedia('(hover: hover)').matches) { if (scale > 1) { scale = 1; tx = 0; ty = 0; } else zoomAt(2.5, e.clientX, e.clientY); apply(true); }
    }

    function shut() {
      removeEventListener('mousemove', onMove); removeEventListener('mouseup', onUp); removeEventListener('keydown', onKey, true);
      box.remove();
      if (dialog) setTimeout(() => dialog.removeEventListener('cancel', keepDialog), 0);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(); } }
    addEventListener('keydown', onKey, true);
    close.addEventListener('click', shut);
    box.addEventListener('click', (e) => { if (e.target === box && scale === 1) shut(); });
  }

  // One listener for the whole page, so pictures added later (the shop, the open design, the Work page) zoom too.
  document.addEventListener('click', (e) => {
    const img = e.target;
    if (!zoomable(img)) return;
    e.preventDefault();
    open(img);
  });
})();
