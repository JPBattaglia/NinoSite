// Email signup in the footer of every page (marketing plan v2, item 1). Double opt-in: the order service
// (commerce-api/src/subscribers.mjs) emails a confirm link; nobody is added until they click it.
// Also shows the result when someone comes back from a confirm or unsubscribe link (?signup=...).
(() => {
  'use strict';
  const API = 'https://nino-printful-commerce-api.ijpbattaglia.workers.dev/api/subscribe';
  const footer = document.querySelector('.site-footer');
  if (!footer || footer.querySelector('.footer-signup')) return;
  const page = (location.pathname.replace(/^\/+|\.html$/g, '') || 'index').toLowerCase().replace(/[^a-z0-9/_.-]/g, '').slice(0, 50);

  const box = document.createElement('div');
  box.className = 'shell footer-signup';
  box.innerHTML = `<div class="footer-signup-copy"><span class="eyebrow">Nino news</span><p>New designs and shop news by email. Unsubscribe any time.</p></div>
<form class="footer-signup-form" novalidate>
<label class="sr-only" for="footer-signup-email">Email address</label>
<input id="footer-signup-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="Your email" required maxlength="254">
<span class="footer-signup-trap" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></span>
<button type="submit">Sign up</button>
<p class="footer-signup-status" role="status" aria-live="polite"></p>
</form>`;
  const grid = footer.querySelector('.footer-grid');
  grid ? grid.after(box) : footer.prepend(box);

  const form = box.querySelector('form');
  const input = form.elements.email;
  const status = box.querySelector('.footer-signup-status');
  const button = form.querySelector('button');
  const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('is-error', bad); };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Enter a full email address, like name@example.com.', true); input.focus(); return; }
    button.disabled = true; say('Sending…');
    try {
      const response = await fetch(API, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, source: `footer/${page}`, website: form.elements.website.value }) });
      if (response.ok) { form.reset(); say('Almost done: check your inbox and tap the confirm link.'); }
      else if (response.status === 400) say('That email address doesn’t look right. Check it and try again.', true);
      else say('Signup isn’t working right now. Please try again later.', true);
    } catch { say('Signup isn’t working right now. Please try again later.', true); }
    button.disabled = false;
  });

  // Coming back from an emailed link.
  const params = new URLSearchParams(location.search);
  const result = { confirmed: 'You’re on the list. Thanks for signing up!', unsubscribed: 'You’re unsubscribed. You won’t get news emails from Nino.', expired: 'That link has expired. Sign up again below if you’d like.' }[params.get('signup')];
  if (result) {
    const note = document.createElement('div');
    note.className = 'signup-notice'; note.setAttribute('role', 'status');
    note.innerHTML = '<p></p><button type="button" aria-label="Close">×</button>';
    note.querySelector('p').textContent = result;
    note.querySelector('button').addEventListener('click', () => note.remove());
    document.body.append(note);
    params.delete('signup');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    setTimeout(() => note.remove(), 9000);
  }
})();
