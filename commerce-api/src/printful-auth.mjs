// Self-renewing Printful connection (owner request, Oct 31, 2026: "solve problems early"). Printful private keys
// always expire; a Printful app's access lasts an hour and the worker renews it itself, forever, as long as it renews
// at least once every 90 days (the 5-minute cron renews it every hour).
//
// One app, installed once on each store:
//   website  Nino's Website (PRINTFUL_STORE_ID, the shop)  replaces PRINTFUL_ACCESS_TOKEN
//   source   NinosTs (the Etsy-linked store designs are made in)  replaces PRINTFUL_SOURCE_TOKEN
// The private keys stay as the fallback: if the app isn't connected, or a renewal fails, the worker uses them.
//
// Owner setup: create the app in Printful's Developer Portal, put PRINTFUL_CLIENT_ID and PRINTFUL_CLIENT_SECRET on the
// worker, then open /api/printful/connect?store=website and ?store=source and click Allow. No key to copy after that.
// The connect link is safe to be public: only someone signed in to the owner's Printful account can approve it, and
// the callback only keeps a connection to one of the two known stores.
//
// Tokens are stored in commerce_settings, encrypted with a key derived from the client secret.
export const STORES = Object.freeze({website: 'Nino’s Website (the shop)', source: 'NinosTs (where designs are made)'});
const SETTING = kind => `printful_oauth:${kind}`;
const RENEW_WHEN_SECONDS_LEFT = 1200;   // renew when under 20 minutes remain; the cron runs every 5
const STATE_TTL = 1800;
const ALERT_HOURS = 6;

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4)), c => c.charCodeAt(0));

export const appConfigured = env => Boolean(env?.PRINTFUL_CLIENT_ID && env?.PRINTFUL_CLIENT_SECRET);
const callbackUrl = env => `${String(env.COMMERCE_API_ORIGIN || '').replace(/\/+$/, '')}/api/printful/callback`;
export const connectUrl = (env, kind) => `${String(env.COMMERCE_API_ORIGIN || '').replace(/\/+$/, '')}/api/printful/connect?store=${kind}`;

async function aesKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`nino-printful-oauth-v1:${env.PRINTFUL_CLIENT_SECRET}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(env), enc.encode(JSON.stringify(value)));
  return `${b64u(iv)}.${b64u(data)}`;
}
async function unseal(env, text) {
  try {
    const [iv, data] = String(text).split('.');
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64u(iv)}, await aesKey(env), unb64u(data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`nino-printful-state-v1:${env.PRINTFUL_CLIENT_SECRET}`), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export async function signState(env, kind, now) {
  const body = `${kind}.${now + STATE_TTL}.${b64u(crypto.getRandomValues(new Uint8Array(9)))}`;
  return `${body}.${await hmac(env, body)}`;
}
export async function readState(env, state, now) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join('.');
  if (await hmac(env, body) !== parts[3]) return null;
  if (!(Number(parts[1]) > now) || !STORES[parts[0]]) return null;
  return parts[0];
}

export async function loadConnections(store, env) {
  if (!appConfigured(env)) return {};
  const rows = await store.all('SELECT key,value FROM commerce_settings WHERE key IN (?,?)', SETTING('website'), SETTING('source')).catch(() => []);
  const out = {};
  for (const row of rows || []) {
    const value = await unseal(env, row.value);
    if (value?.access_token) out[row.key.slice('printful_oauth:'.length)] = value;
  }
  return out;
}
async function saveConnection(store, env, kind, value) {
  await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', SETTING(kind), await seal(env, value));
}

// The env every handler uses: the app's live access token in place of each private key it covers.
export async function withPrintfulTokens(env, store, now) {
  if (!appConfigured(env) || !store) return env;
  const connections = await loadConnections(store, env);
  const live = kind => connections[kind] && Number(connections[kind].expires_at) - now > 60 ? connections[kind].access_token : null;
  const website = live('website'), source = live('source');
  if (!website && !source) return env;
  return {...env, ...(website ? {PRINTFUL_ACCESS_TOKEN: website} : {}), ...(source ? {PRINTFUL_SOURCE_TOKEN: source} : {})};
}

// Printful's token endpoint. The docs list the parameters without a content type, so form encoding is tried first
// and JSON second.
async function tokenRequest(env, params, fetcher) {
  const body = {client_id: env.PRINTFUL_CLIENT_ID, client_secret: env.PRINTFUL_CLIENT_SECRET, ...params};
  let last = '';
  for (const json of [false, true]) {
    const response = await fetcher('https://www.printful.com/oauth/token', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: {'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString()
    });
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (response.ok && data?.access_token && data?.refresh_token) {
      return {access_token: String(data.access_token), refresh_token: String(data.refresh_token), expires_at: Number(data.expires_at) || 0};
    }
    last = `${response.status}: ${String(data?.error_description || data?.error?.message || data?.error || data?.result || text).slice(0, 200)}`;
  }
  throw new Error(`printful_token ${last}`);
}

// Which of the two stores a fresh token belongs to, by Printful's store number. Matching on store type alone let a
// brand-new empty API store pass as the shop (Oct 31, 2026: Printful's approval screen can create a new store).
const SOURCE_STORE_DEFAULT = '18583773'; // NinosTs (same default as mirror.mjs)
export const expectedStoreId = (env, kind) => String(kind === 'website' ? env.PRINTFUL_STORE_ID || '' : env.PRINTFUL_SOURCE_STORE_ID || SOURCE_STORE_DEFAULT);
async function storeKind(token, fetcher, env) {
  const response = await fetcher('https://api.printful.com/store', {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)});
  const data = response.ok ? await response.json().catch(() => null) : null;
  const id = String(data?.result?.id ?? '');
  if (!id) return {kind: null, id: null, name: null};
  const kind = Object.keys(STORES).find(k => expectedStoreId(env, k) === id) || null;
  return {kind, id, name: data?.result?.name ? String(data.result.name) : null};
}

export async function connectRedirect(env, kind, now) {
  if (!appConfigured(env)) return page(503, 'Not set up yet', '<p>The Printful app’s Client ID and Client secret aren’t on the shop worker yet.</p>');
  if (!STORES[kind]) return page(400, 'Which store?', `<p>Use <a href="${connectUrl(env, 'website')}">the shop</a> or <a href="${connectUrl(env, 'source')}">NinosTs</a>.</p>`);
  const url = new URL('https://www.printful.com/oauth/authorize');
  url.searchParams.set('client_id', env.PRINTFUL_CLIENT_ID);
  url.searchParams.set('state', await signState(env, kind, now));
  url.searchParams.set('redirect_url', callbackUrl(env));
  return new Response(null, {status: 302, headers: {Location: url.toString(), 'Cache-Control': 'no-store'}});
}

export async function connectCallback(env, store, url, now, fetcher = (...a) => fetch(...a)) {
  if (!appConfigured(env)) return page(503, 'Not set up yet', '<p>The Printful app isn’t configured on the shop worker.</p>');
  const kind = await readState(env, url.searchParams.get('state'), now);
  if (!kind) return page(400, 'Link expired', '<p>This link has expired. Open the connect link again.</p>');
  if (url.searchParams.get('success') !== '1' || !url.searchParams.get('code')) return page(200, 'Not connected', '<p>Printful didn’t grant access, so nothing changed. The shop keeps using its key.</p>');
  let tokens;
  try { tokens = await tokenRequest(env, {grant_type: 'authorization_code', code: url.searchParams.get('code')}, fetcher); }
  catch (error) { return page(502, 'Printful refused', `<p>Printful didn’t complete the connection (${esc(error.message)}). Tell Claude “Printful connect failed”.</p>`); }
  const found = await storeKind(tokens.access_token, fetcher, env).catch(() => ({kind: null, id: null, name: null}));
  const actual = found.kind;
  if (actual !== kind) {
    const which = actual ? esc(STORES[actual]) : found.id ? `a different store (“${esc(found.name || 'unnamed')}”, number ${esc(found.id)}), not one this shop uses` : 'a store this shop doesn’t use';
    return page(409, 'Wrong store', `<p>Nothing was saved. That approval was for ${which}, but this link connects <strong>${esc(STORES[kind])}</strong>. Printful approves whichever store is selected in your Printful dashboard. Go to <a href="https://www.printful.com/dashboard">printful.com/dashboard</a>, click the store name at the top left, pick ${esc(STORES[kind])}, then open <a href="${connectUrl(env, kind)}">this link</a> again.</p>`);
  }
  await saveConnection(store, env, kind, {...tokens, connected_at: now, renewed_at: now});
  await store.run('DELETE FROM commerce_settings WHERE key=?', `printful_oauth_alert:${kind}`).catch(() => {});
  const other = kind === 'website' ? 'source' : 'website';
  const connected = await loadConnections(store, env);
  const next = connected[other] ? '<p>Both stores are connected. Nothing else to do; the shop renews this by itself.</p>'
    : `<p>Next: <a href="${connectUrl(env, other)}">connect ${esc(STORES[other])}</a>.</p>`;
  return page(200, 'Connected', `<p><strong>${esc(STORES[kind])}</strong> is connected to the shop and renews itself.</p>${next}`);
}

// Every 5 minutes: renew any connection with under 20 minutes left. A failed renewal falls back to the private key
// (withPrintfulTokens ignores expired tokens) and, once its access has run out, emails the owner the connect link.
export async function renewPrintfulTokens(store, env, now, fetcher = (...a) => fetch(...a)) {
  if (!appConfigured(env)) return {};
  const connections = await loadConnections(store, env);
  const result = {};
  for (const [kind, value] of Object.entries(connections)) {
    if (Number(value.expires_at) - now > RENEW_WHEN_SECONDS_LEFT) { result[kind] = 'fresh'; continue; }
    try {
      const tokens = await tokenRequest(env, {grant_type: 'refresh_token', refresh_token: value.refresh_token}, fetcher);
      await saveConnection(store, env, kind, {...value, ...tokens, renewed_at: now});
      result[kind] = 'renewed';
    } catch (error) {
      result[kind] = `failed: ${error.message}`;
      if (Number(value.expires_at) <= now) await alertReconnect(store, env, kind, now, error.message);
    }
  }
  return result;
}

async function alertReconnect(store, env, kind, now, reason) {
  try {
    if (!env.MAILER || typeof env.MAILER.send !== 'function' || !env.OWNER_EMAIL) return;
    const key = `printful_oauth_alert:${kind}`;
    const last = await store.first('SELECT value FROM commerce_settings WHERE key=?', key);
    if (last && now - Number(last.value) < ALERT_HOURS * 3600) return;
    const link = connectUrl(env, kind);
    const fallback = kind === 'website' ? 'The shop is using its backup Printful key meanwhile.' : 'Copying new designs uses the backup key meanwhile.';
    await env.MAILER.send({
      to: env.OWNER_EMAIL, subject: 'Nino shop: reconnect Printful (one click)',
      html: `<p>The shop’s Printful connection for ${esc(STORES[kind])} stopped renewing (${esc(String(reason).slice(0, 160))}). ${fallback}</p><p>To fix it: open <a href="${link}">${link}</a>, sign in to Printful if asked, choose ${esc(STORES[kind])} and click Allow.</p>`,
      text: `The shop's Printful connection for ${STORES[kind]} stopped renewing (${String(reason).slice(0, 160)}). ${fallback}\n\nTo fix it: open ${link}, sign in to Printful if asked, choose ${STORES[kind]} and click Allow.`
    });
    await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(now));
  } catch { /* the next run tries again */ }
}

// For /api/health: which stores run on the self-renewing app. No tokens.
export async function connectionStatus(store, env, now) {
  if (!appConfigured(env)) return {app: 'not_set_up'};
  const connections = await loadConnections(store, env);
  return Object.fromEntries(Object.keys(STORES).map(kind => [kind, connections[kind] ? (Number(connections[kind].expires_at) > now ? 'app' : 'app_expired_using_key') : 'key']));
}

const esc = text => String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function page(status, title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Nino shop</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#1d1d1d}a{color:#b5462b}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
}
