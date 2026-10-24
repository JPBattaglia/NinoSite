/* Back-to-top button. On phones (980px and narrower) it floats on every page once the visitor has
   scrolled down a little; on larger screens it appears on long pages after the first screen. */
(() => {
  'use strict';
  if (window.__backToTop) return;
  window.__backToTop = true;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 980px)');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'back-to-top';
  button.setAttribute('aria-label', 'Back to top');
  button.title = 'Back to top';
  button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">'
    + '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.appendChild(button);

  let ticking = false;
  function update() {
    ticking = false;
    const viewport = window.innerHeight;
    const show = mobile.matches
      ? window.scrollY > Math.min(200, viewport * 0.3)
      : document.documentElement.scrollHeight > viewport * 2 && window.scrollY > viewport * 0.9;
    button.classList.toggle('is-visible', show);
  }
  function schedule() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    const target = document.getElementById('main') || document.querySelector('main');
    if (target) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  });

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  mobile.addEventListener?.('change', schedule);
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(document.body);
  update();
})();
