// Etsy listing tools for the NinosTs shop (owner, Nov 24, 2026: optimize the Etsy listing titles and tags for search,
// using Etsy's own free API instead of a paid connector).
//
// Etsy app: "nino-shop-tools" (seller app, approved). Its keystring is public (ETSY_KEYSTRING below); its Shared Secret
// is pasted once by the owner on the private connect page, which then sends him to Etsy's Allow screen. Callback URL
// (added to the app Nov 24): <COMMERCE_API_ORIGIN>/api/etsy/callback.
//
// Owner setup, once: the first scheduled run emails the owner a private connect link. He opens it, pastes the Shared
// Secret from etsy.com/developers/your-apps, taps Connect, then Allow on Etsy. The shop renews the access by itself
// (Etsy access lasts an hour; the refresh lasts 90 days and the 5-minute cron renews hourly).
//
// Listing changes are not typed by anyone on a page: they ship in etsy-listing-updates.mjs with the code (GitHub is the
// master copy), and each scheduled run applies up to MAX_PER_RUN of the ones not applied yet. Each applied change is
// read back from Etsy; a mismatch is kept as an error and shown on /api/etsy/status.
//
// Public, read-only: /api/etsy/status (connected, counts, errors; no tokens) and /api/etsy/listings (the shop's
// active listings' titles and tags, the same data anyone sees on Etsy).
import {ETSY_LISTING_UPDATES} from './etsy-listing-updates.mjs';

export const ETSY_KEYSTRING = 'hgcsqkbul89zemdh6cscvc9y';
export const ETSY_SHOP_NAME = 'NinosTs';
const SCOPES = 'listings_r listings_w shops_r';
const CONN = 'etsy_connection';
const LINK = 'etsy_connect_link';
const RENEW_WHEN_SECONDS_LEFT = 1200;
const STATE_TTL = 1800;
const MAX_PER_RUN = 10;
const API = 'https://api.etsy.com/v3';

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4)), c => c.charCodeAt(0));
const randomKey = (n = 24) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const origin = env => String(env.COMMERCE_API_ORIGIN || '').replace(/\/+$/, '');
export const callbackUrl = env => `${origin(env)}/api/etsy/callback`;
const connectPageUrl = (env, key) => `${origin(env)}/api/etsy/connect?k=${encodeURIComponent(key)}`;
const keystring = env => String(env.ETSY_KEYSTRING || ETSY_KEYSTRING);

// Sealing key: a secret the worker already has (the owner never sets anything for Etsy).
const sealSource = env => env.ADMIN_API_TOKEN || env.STRIPE_WEBHOOK_SECRET || '';
async function aesKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`nino-etsy-v1:${sealSource(env)}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(env), enc.encode(JSON.stringify(value)));
  return `${b64u(iv)}.${b64u(data)}`;
}
export async function unseal(env, text) {
  try {
    const [iv, data] = String(text).split('.');
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64u(iv)}, await aesKey(env), unb64u(data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

const setSetting = (store, key, value) => store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
export async function loadConnection(store, env) {
  if (!sealSource(env)) return null;
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', CONN).catch(() => null);
  return row?.value ? await unseal(env, row.value) : null;
}
const saveConnection = async (store, env, value) => setSetting(store, CONN, await seal(env, value));

const apiKey = (env, secret) => `${keystring(env)}:${secret}`;
async function etsyFetch(fetcher, url, init = {}) {
  const response = await fetcher(url, {signal: AbortSignal.timeout(20000), ...init});
  const text = await response.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return {ok: response.ok, status: response.status, data, text};
}
const errorText = r => `${r.status}: ${String(r.data?.error_description || r.data?.error || r.text || '').slice(0, 200)}`;

async function tokenRequest(env, secret, params, fetcher) {
  const r = await etsyFetch(fetcher, `${API}/public/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'x-api-key': apiKey(env, secret)},
    body: new URLSearchParams({client_id: keystring(env), ...params}).toString()
  });
  if (!r.ok || !r.data?.access_token || !r.data?.refresh_token) throw new Error(`etsy_token ${errorText(r)}`);
  return {access_token: String(r.data.access_token), refresh_token: String(r.data.refresh_token), expires_in: Number(r.data.expires_in) || 3600};
}

// ---------------------------------------------------------------- the owner's private connect link
export async function ensureEtsyLink(store, env) {
  try {
    if (!env.MAILER || typeof env.MAILER.send !== 'function' || !env.OWNER_EMAIL || !sealSource(env)) return 'not_ready';
    const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', LINK);
    if (row?.value) return 'exists';
    const key = randomKey();
    await setSetting(store, LINK, key);
    await env.MAILER.send(linkMessage(env, connectPageUrl(env, key)));
    return 'sent';
  } catch { return 'failed'; }
}

export function linkMessage(env, link) {
  const steps = [
    'Open https://www.etsy.com/developers/your-apps in your browser (signed in to the NinosTs Etsy account).',
    'In the row for nino-shop-tools, click the copy button next to the dots under Shared Secret.',
    'Open the button below, paste it in the box and click Connect Etsy.',
    'Etsy shows an Allow screen for nino-shop-tools. Click Allow Access. You land back on a page that says Connected.'
  ];
  const intro = 'Nino’s shop can now improve the NinosTs Etsy listings (titles and tags) by itself. It needs a one-time connection to Etsy. Nothing to remember after this, and it costs nothing.';
  const button = 'display:inline-block;padding:12px 20px;background-color:#ff6a1f;border:2px solid #ff6a1f;border-radius:8px;color:#200705;font-weight:700;text-decoration:none';
  return {
    to: env.OWNER_EMAIL,
    subject: 'Nino shop: connect Etsy (one time, about 2 minutes)',
    html: `<p>${intro}</p><ol>${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol><p><a href="${esc(link)}" style="${button}">Open the Etsy connect page</a></p><p style="word-break:break-all">${esc(link)}</p><p>Keep this link private.</p>`,
    text: `${intro}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n${link}\n\nKeep this link private.`
  };
}

async function linkOk(store, key) {
  if (!key) return false;
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', LINK).catch(() => null);
  return Boolean(row?.value) && row.value === String(key);
}

function page(status, title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Nino shop</title><style>body{font:17px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#1d1d1d}a{color:#b5462b}input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:2px solid #b5462b;border-radius:8px}button{margin-top:14px;font:inherit;font-weight:700;padding:12px 20px;border:2px solid #ff6a1f;background:#ff6a1f;color:#200705;border-radius:8px;cursor:pointer}ol li{margin-bottom:6px}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'}});
}

function connectForm(env, key, connection, note = '') {
  const status = connection?.shop_name ? `<p><strong>Connected to ${esc(connection.shop_name)}.</strong> You only need this page again if Etsy ever asks for a new connection.</p>` : '';
  return page(200, 'Connect Etsy', `${status}${note}<ol><li>Open <a href="https://www.etsy.com/developers/your-apps" target="_blank" rel="noopener">etsy.com/developers/your-apps</a> (signed in to the NinosTs account).</li><li>In the <strong>nino-shop-tools</strong> row, click the copy button next to the dots under <strong>Shared Secret</strong>.</li><li>Paste it below and click <strong>Connect Etsy</strong>, then click <strong>Allow Access</strong> on Etsy’s screen.</li></ol><form method="post" action="${esc(origin(env))}/api/etsy/connect"><input type="hidden" name="k" value="${esc(key)}"><label for="secret">Shared Secret</label><input id="secret" name="secret" type="password" autocomplete="off" required><button type="submit">Connect Etsy</button></form>`);
}

async function pkce() {
  const verifier = randomKey(48);
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return {verifier, challenge};
}

// GET shows the form; POST checks the Shared Secret with Etsy and sends the owner to Etsy's Allow screen.
export async function connectRoute(request, url, store, env, now, fetcher) {
  if (!sealSource(env)) return page(503, 'Not ready', '<p>The shop worker is missing its admin key, so it can’t store the Etsy connection safely. Tell Claude “Etsy connect: no admin key”.</p>');
  if (request.method === 'GET') {
    const key = url.searchParams.get('k');
    if (!await linkOk(store, key)) return page(403, 'Link not valid', '<p>This connect link isn’t valid. Use the newest “connect Etsy” email.</p>');
    return connectForm(env, key, await loadConnection(store, env));
  }
  const form = await request.formData().catch(() => null);
  const key = form?.get('k'); const secret = String(form?.get('secret') || '').trim();
  if (!await linkOk(store, key)) return page(403, 'Link not valid', '<p>This connect link isn’t valid. Use the newest “connect Etsy” email.</p>');
  if (!/^[A-Za-z0-9]{6,64}$/.test(secret)) return connectForm(env, key, null, '<p style="color:#b5462b"><strong>That doesn’t look like the Shared Secret.</strong> Copy it again with the copy button and paste it below.</p>');
  const ping = await etsyFetch(fetcher, `${API}/application/openapi-ping`, {headers: {'x-api-key': apiKey(env, secret)}}).catch(e => ({ok: false, status: 0, text: e.message}));
  if (!ping.ok) return connectForm(env, key, null, `<p style="color:#b5462b"><strong>Etsy didn’t accept that Shared Secret</strong> (${esc(errorText(ping))}). Copy it again from the nino-shop-tools row and paste it below.</p>`);
  const {verifier, challenge} = await pkce();
  const state = randomKey(18);
  const previous = await loadConnection(store, env);
  await saveConnection(store, env, {...(previous || {}), secret, pending: {state, verifier, expires_at: now + STATE_TTL}});
  const auth = new URL('https://www.etsy.com/oauth/connect');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('redirect_uri', callbackUrl(env));
  auth.searchParams.set('scope', SCOPES);
  auth.searchParams.set('client_id', keystring(env));
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  return new Response(null, {status: 303, headers: {Location: auth.toString(), 'Cache-Control': 'no-store'}});
}

export async function callbackRoute(url, store, env, now, fetcher) {
  const connection = await loadConnection(store, env);
  const pending = connection?.pending;
  if (!pending || pending.state !== url.searchParams.get('state') || !(pending.expires_at > now)) return page(400, 'Link expired', '<p>This approval has expired or didn’t come from the connect page. Open the connect link from the email again.</p>');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return page(200, 'Not connected', '<p>Etsy didn’t grant access, so nothing changed. You can open the connect link again any time.</p>');
  let tokens;
  try { tokens = await tokenRequest(env, connection.secret, {grant_type: 'authorization_code', redirect_uri: callbackUrl(env), code: url.searchParams.get('code'), code_verifier: pending.verifier}, fetcher); }
  catch (error) { return page(502, 'Etsy refused', `<p>Etsy didn’t complete the connection (${esc(error.message)}). Tell Claude “Etsy connect failed”.</p>`); }
  const userId = tokens.access_token.split('.')[0];
  const shops = await etsyFetch(fetcher, `${API}/application/users/${encodeURIComponent(userId)}/shops`, {headers: {'x-api-key': apiKey(env, connection.secret), Authorization: `Bearer ${tokens.access_token}`}}).catch(() => null);
  const shop = shops?.ok ? (Array.isArray(shops.data?.results) ? shops.data.results[0] : shops.data) : null;
  if (!shop?.shop_id) return page(409, 'No shop found', `<p>Nothing was saved. The Etsy account you approved with doesn’t have a shop (${esc(shops ? errorText(shops) : 'no answer')}). Sign in to Etsy as the NinosTs account and open the connect link again.</p>`);
  if (String(shop.shop_name || '').toLowerCase() !== ETSY_SHOP_NAME.toLowerCase()) return page(409, 'Wrong shop', `<p>Nothing was saved. That approval was for the shop “${esc(shop.shop_name)}”, not ${ETSY_SHOP_NAME}. Sign in to Etsy as the NinosTs account and open the connect link again.</p>`);
  const {pending: _drop, ...rest} = connection;
  await saveConnection(store, env, {...rest, ...tokens, expires_at: now + tokens.expires_in, user_id: userId, shop_id: String(shop.shop_id), shop_name: String(shop.shop_name), connected_at: now, renewed_at: now});
  return page(200, 'Connected', `<p><strong>${esc(shop.shop_name)}</strong> is connected to Nino’s shop. It renews by itself; there’s nothing else to do.</p>`);
}

// ---------------------------------------------------------------- scheduled: renew, then apply listing changes
export const updateKey = u => `${u.listing_id}:${u.title || ''}|${(u.tags || []).join(',')}`;

export async function runEtsy(store, env, now, fetcher = (...a) => fetch(...a), updates = ETSY_LISTING_UPDATES) {
  let connection = await loadConnection(store, env);
  if (!connection?.refresh_token || !connection.secret) return {state: 'not_connected'};
  let changed = false;
  if (Number(connection.expires_at) - now <= RENEW_WHEN_SECONDS_LEFT) {
    try {
      const tokens = await tokenRequest(env, connection.secret, {grant_type: 'refresh_token', refresh_token: connection.refresh_token}, fetcher);
      connection = {...connection, ...tokens, expires_at: now + tokens.expires_in, renewed_at: now, renew_error: null};
    } catch (error) {
      connection = {...connection, renew_error: String(error.message).slice(0, 200)};
      await saveConnection(store, env, connection);
      return {state: 'renew_failed'};
    }
    changed = true;
  }
  const applied = new Set(connection.applied || []);
  const todo = (updates || []).filter(u => u?.listing_id && (u.title || u.tags?.length) && !applied.has(updateKey(u))).slice(0, MAX_PER_RUN);
  const errors = {...(connection.errors || {})};
  for (const u of todo) {
    const body = new URLSearchParams();
    if (u.title) body.set('title', u.title);
    if (u.tags?.length) body.set('tags', u.tags.join(','));
    const headers = {'Content-Type': 'application/x-www-form-urlencoded', 'x-api-key': apiKey(env, connection.secret), Authorization: `Bearer ${connection.access_token}`};
    const r = await etsyFetch(fetcher, `${API}/application/shops/${connection.shop_id}/listings/${u.listing_id}`, {method: 'PATCH', headers, body: body.toString()}).catch(e => ({ok: false, status: 0, text: e.message}));
    const listing = r.ok ? r.data : null;
    const tagsMatch = !u.tags?.length || JSON.stringify((listing?.tags || []).map(t => String(t).toLowerCase())) === JSON.stringify(u.tags.map(t => String(t).toLowerCase()));
    const titleMatch = !u.title || String(listing?.title || '') === u.title;
    if (r.ok && tagsMatch && titleMatch) { applied.add(updateKey(u)); delete errors[u.listing_id]; }
    else errors[u.listing_id] = r.ok ? `saved but read back differently (title ${titleMatch ? 'ok' : 'differs'}, tags ${tagsMatch ? 'ok' : 'differ'})` : errorText(r);
    changed = true;
  }
  if (changed) await saveConnection(store, env, {...connection, applied: [...applied], errors, last_run: now});
  return {state: 'ok', applied: todo.filter(u => applied.has(updateKey(u))).length, failed: todo.filter(u => !applied.has(updateKey(u))).length};
}

// ---------------------------------------------------------------- public read-only
export async function statusRoute(store, env, updates = ETSY_LISTING_UPDATES) {
  const c = await loadConnection(store, env);
  const applied = new Set(c?.applied || []);
  return {
    connected: Boolean(c?.refresh_token), shop_name: c?.shop_name || null, renewed_at: c?.renewed_at || null, renew_error: c?.renew_error || null,
    link_sent: Boolean(await store.first('SELECT 1 AS ok FROM commerce_settings WHERE key=?', LINK).catch(() => null)),
    updates_total: (updates || []).length, updates_applied: (updates || []).filter(u => applied.has(updateKey(u))).length,
    errors: c?.errors || {}, last_run: c?.last_run || null
  };
}

export async function listingsRoute(store, env, fetcher = (...a) => fetch(...a)) {
  const c = await loadConnection(store, env);
  if (!c?.shop_id || !c.secret) return {connected: false, listings: []};
  const listings = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const headers = {'x-api-key': apiKey(env, c.secret), ...(c.access_token ? {Authorization: `Bearer ${c.access_token}`} : {})};
    // The signed-in listings endpoint (getListingsByShop); the public /listings/active one stops at offset 100.
    const r = await etsyFetch(fetcher, `${API}/application/shops/${c.shop_id}/listings?state=active&limit=100&offset=${offset}`, {headers});
    if (!r.ok) return {connected: true, error: errorText(r), listings};
    for (const l of r.data?.results || []) listings.push({listing_id: l.listing_id, title: l.title, tags: l.tags || [], url: l.url, views: l.views ?? null, num_favorers: l.num_favorers ?? null});
    if (!(r.data?.results?.length === 100)) break;
  }
  return {connected: true, shop_name: c.shop_name, count: listings.length, listings};
}

// Routes under /api/etsy/. Returns a Response, or null when the path is not one of these.
export async function etsyRoute(request, url, store, env, now, ctx, fetcher = (...a) => fetch(...a)) {
  const path = url.pathname;
  if (!path.startsWith('/api/etsy/')) return null;
  const json = (value, status = 200, extra = {}) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', ...extra}});
  if (path === '/api/etsy/connect' && ['GET', 'POST'].includes(request.method)) return connectRoute(request, url, store, env, now, fetcher);
  if (path === '/api/etsy/callback' && request.method === 'GET') return callbackRoute(url, store, env, now, fetcher);
  if (path === '/api/etsy/status' && request.method === 'GET') return json(await statusRoute(store, env));
  if (path === '/api/etsy/listings' && request.method === 'GET') {
    const cache = globalThis.caches?.default; const cached = cache && await cache.match(request);
    if (cached) return cached;
    const response = json(await listingsRoute(store, env, fetcher), 200, {'Cache-Control': 'public, max-age=600'});
    if (cache && response.ok) ctx?.waitUntil?.(cache.put(request, response.clone()));
    return response;
  }
  return json({error: 'not_found'}, 404);
}
