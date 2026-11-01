// Email signup for ninobattaglia.com (marketing plan v2, item 1: "an email signup on the site").
//
// Double opt-in. POST /api/subscribe (from the storefront only) stores the address as 'pending' and emails a
// confirm link through Menu-made's mailer (env.MAILER, the same NinoMail binding the order emails use). The
// address becomes 'active' only when its owner clicks GET /api/subscribe/confirm?t=<token>. Every later
// email carries GET/POST /api/unsubscribe?t=<token>; the GET shows a one-button page (so a mail scanner that
// opens links can't unsubscribe anyone) and the POST, also used for RFC 8058 one-click, does the work.
//
// Free-quota guard: Resend's free plan is shared with Menu-made, so confirmation emails are capped per day
// (SIGNUP_DAILY_CAP), per address (one resend a day) and per visitor IP (SIGNUP_IP_CAP, hashed, never stored raw).
// The answer to the form is the same whether or not the address was already on the list.
import {fail,hash,requestJson} from './common.mjs';

export const SIGNUP_DAILY_CAP = 30;
export const SIGNUP_IP_CAP = 5;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SOURCE = /^[a-z0-9][a-z0-9/_.-]{0,59}$/;
const LOGO = 'https://ninobattaglia.com/assets/email-nino-mark.png';

const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const dayOf = now => new Date(now * 1000).toISOString().slice(0, 10);
const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

// Adds one to a per-day counter and says whether it is still within the limit. Old days are cleared as it goes.
async function withinLimit(store, key, limit, day) {
  await store.run('DELETE FROM signup_limits WHERE day<>?', day);
  const row = await store.first('SELECT n FROM signup_limits WHERE k=?', key);
  if (row && row.n >= limit) return false;
  await store.run('INSERT INTO signup_limits(k,day,n) VALUES(?,?,1) ON CONFLICT(k) DO UPDATE SET n=n+1', key, day);
  return true;
}

export function confirmEmail(to, confirmUrl) {
  const heading = 'Confirm your email';
  const lines = [
    'Thanks for signing up for news from Nino Battaglia: new designs and shop news.',
    'Tap the button to confirm. If you didn’t sign up, ignore this email and you won’t hear from us again.'
  ];
  return {
    to,
    subject: 'Confirm your email for Nino Battaglia',
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background-color:#140403;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#140403;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#200705;border:1px solid #3a2a26;border-radius:10px;">
<tr><td style="padding:26px 32px;border-bottom:3px solid #ff6a1f;"><a href="https://ninobattaglia.com" style="text-decoration:none;"><img src="${LOGO}" width="44" height="44" alt="Nino Battaglia" style="display:inline-block;vertical-align:middle;border:0;"> <span style="font-size:20px;font-weight:bold;letter-spacing:.04em;color:#f2efe8;vertical-align:middle;">NINO BATTAGLIA</span></a></td></tr>
<tr><td style="padding:30px 32px 10px;"><h1 style="margin:0 0 16px;font-size:26px;color:#f2efe8;">${heading}</h1>${lines.map(line => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#c9bdb4;">${esc(line)}</p>`).join('')}</td></tr>
<tr><td style="padding:10px 32px 34px;"><a href="${esc(confirmUrl)}" style="display:inline-block;padding:14px 24px;border:2px solid #ff6a1f;border-radius:10px;color:#f2efe8;font-size:15px;font-weight:bold;text-decoration:none;">Yes, sign me up</a></td></tr>
</table></td></tr></table></body></html>`,
    text: `${lines.join('\n\n')}\n\nConfirm: ${confirmUrl}`
  };
}

export async function subscribe(request, store, env, now) {
  if (request.headers.get('Origin') !== env.STOREFRONT_ORIGIN) fail(403, 'origin_not_allowed');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'json_required');
  const body = await requestJson(request, 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_signup');
  // Honeypot: a hidden field people never fill. Bots get the normal answer and nothing happens.
  if (body.website) return {ok: true};
  const email = normalizeEmail(body.email);
  if (!email) fail(400, 'invalid_email');
  const source = SOURCE.test(String(body.source || '')) ? String(body.source) : null;
  const day = dayOf(now);

  const row = await store.first('SELECT status,token,confirm_sent_at FROM subscribers WHERE email=?', email);
  if (row?.status === 'active') return {ok: true};
  if (row?.confirm_sent_at && now - row.confirm_sent_at < 86400) return {ok: true};

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip && !await withinLimit(store, `ip:${await hash(`${day}:${ip}`)}`, SIGNUP_IP_CAP, day)) return {ok: true};
  if (!await withinLimit(store, 'daily', SIGNUP_DAILY_CAP, day)) return {ok: true};

  const token = newToken();
  if (row) await store.run("UPDATE subscribers SET status='pending',token=?,source=COALESCE(?,source),unsubscribed_at=NULL WHERE email=?", token, source, email);
  else await store.run("INSERT INTO subscribers(email,status,token,source,created_at) VALUES(?, 'pending', ?, ?, ?)", email, token, source, now);

  if (!env.MAILER || typeof env.MAILER.send !== 'function') fail(503, 'mail_unavailable');
  const confirmUrl = `${env.COMMERCE_API_ORIGIN}/api/subscribe/confirm?t=${token}`;
  await env.MAILER.send(confirmEmail(email, confirmUrl));
  await store.run('UPDATE subscribers SET confirm_sent_at=? WHERE email=?', now, email);
  return {ok: true};
}

const tokenOf = url => { const t = url.searchParams.get('t') || ''; return /^[a-f0-9]{48}$/.test(t) ? t : null; };
const back = (env, state) => Response.redirect(`${env.STOREFRONT_ORIGIN}/?signup=${state}`, 303);

export async function confirmSubscription(url, store, env, now) {
  const token = tokenOf(url);
  const row = token && await store.first('SELECT email,status FROM subscribers WHERE token=?', token);
  if (!row || row.status === 'unsubscribed') return back(env, 'expired');
  if (row.status === 'pending') await store.run("UPDATE subscribers SET status='active',confirmed_at=? WHERE email=?", now, row.email);
  return back(env, 'confirmed');
}

export function unsubscribeLink(env, token) { return `${env.COMMERCE_API_ORIGIN}/api/unsubscribe?t=${token}`; }

// GET: a page with one button, so link scanners don't unsubscribe people. POST: does it (button or RFC 8058).
export async function unsubscribe(request, url, store, env, now) {
  const token = tokenOf(url);
  if (request.method === 'GET') {
    const action = token ? esc(unsubscribeLink(env, token)) : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe — Nino Battaglia</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#140403;color:#f2efe8;font:16px/1.6 Arial,Helvetica,sans-serif;"><main style="max-width:420px;padding:32px;text-align:center;">
<h1 style="font-size:26px;margin:0 0 12px;">Unsubscribe</h1>${action ? `<p style="color:#c9bdb4;">Stop getting news emails from Nino Battaglia? Order emails for anything you buy still arrive.</p>
<form method="post" action="${action}"><button type="submit" style="margin-top:12px;padding:14px 24px;background:transparent;color:#f2efe8;border:2px solid #ff6a1f;border-radius:10px;font:bold 15px Arial,Helvetica,sans-serif;cursor:pointer;">Unsubscribe</button></form>` : '<p style="color:#c9bdb4;">This link isn’t valid. Email hello@ninobattaglia.com and we’ll take you off the list.</p>'}
</main></body></html>`;
    return new Response(html, {status: token ? 200 : 400, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});
  }
  const row = token && await store.first('SELECT email,status FROM subscribers WHERE token=?', token);
  if (row && row.status !== 'unsubscribed') await store.run("UPDATE subscribers SET status='unsubscribed',unsubscribed_at=? WHERE email=?", now, row.email);
  return back(env, row ? 'unsubscribed' : 'expired');
}

export async function subscriberCounts(store) {
  const rows = await store.all('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status');
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}
