import test from 'node:test';
import assert from 'node:assert/strict';
import {etsyRoute, ensureEtsyLink, runEtsy, loadConnection, seal, updateKey, callbackUrl} from '../src/etsy.mjs';

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async first(sql, key) { if (!sql.includes('commerce_settings')) return null; return rows.has(key) ? {value: rows.get(key), ok: 1} : null; },
    async run(sql, key, value) { if (sql.startsWith('INSERT')) rows.set(key, value); return {meta: {changes: 1}}; },
    async all() { return []; }
  };
}
const env = {COMMERCE_API_ORIGIN: 'https://shop.example', ADMIN_API_TOKEN: 'admin-test', OWNER_EMAIL: 'owner@example.com'};
const NOW = 1_800_000_000;

test('first scheduled run emails the owner one private connect link', async () => {
  const store = fakeStore(); const sent = [];
  const e = {...env, MAILER: {send: async m => sent.push(m)}};
  assert.equal(await ensureEtsyLink(store, e), 'sent');
  assert.equal(await ensureEtsyLink(store, e), 'exists');
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /\/api\/etsy\/connect\?k=/);
  assert.match(sent[0].text, /etsy\.com\/developers\/your-apps/);
});

test('connect page refuses a wrong link and accepts the emailed one', async () => {
  const store = fakeStore(); store.rows.set('etsy_connect_link', 'goodkey');
  const bad = await etsyRoute(new Request('https://shop.example/api/etsy/connect?k=nope'), new URL('https://shop.example/api/etsy/connect?k=nope'), store, env, NOW);
  assert.equal(bad.status, 403);
  const ok = await etsyRoute(new Request('https://shop.example/api/etsy/connect?k=goodkey'), new URL('https://shop.example/api/etsy/connect?k=goodkey'), store, env, NOW);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Shared Secret/);
});

test('a checked Shared Secret sends the owner to Etsy with PKCE, and the callback saves NinosTs', async () => {
  const store = fakeStore(); store.rows.set('etsy_connect_link', 'goodkey');
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith('/openapi-ping')) return new Response('{"application_id":1}', {status: 200});
    if (String(url).endsWith('/public/oauth/token')) return Response.json({access_token: '42.abc', refresh_token: '42.ref', expires_in: 3600});
    if (String(url).includes('/users/42/shops')) return Response.json({shop_id: 777, shop_name: 'NinosTs'});
    return new Response('no', {status: 500});
  };
  const body = new URLSearchParams({k: 'goodkey', secret: 'abc123secret'});
  const post = new Request('https://shop.example/api/etsy/connect', {method: 'POST', body, headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
  const res = await etsyRoute(post, new URL(post.url), store, env, NOW, null, fetcher);
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), callbackUrl(env));
  assert.equal(calls[0].init.headers['x-api-key'], 'hgcsqkbul89zemdh6cscvc9y:abc123secret');
  const state = location.searchParams.get('state');
  const cbUrl = new URL(`https://shop.example/api/etsy/callback?code=c1&state=${state}`);
  const cb = await etsyRoute(new Request(cbUrl), cbUrl, store, env, NOW + 10, null, fetcher);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /NinosTs/);
  const conn = await loadConnection(store, env);
  assert.equal(conn.shop_id, '777'); assert.equal(conn.pending, undefined); assert.equal(conn.secret, 'abc123secret');
  const tokenCall = calls.find(c => c.url.endsWith('/public/oauth/token'));
  assert.match(tokenCall.init.body, /code_verifier=/);
  assert.ok(!store.rows.get('etsy_connection').includes('abc123secret'), 'stored sealed, not in plain text');
});

test('a wrong secret stays on the form and a wrong shop saves nothing', async () => {
  const store = fakeStore(); store.rows.set('etsy_connect_link', 'goodkey');
  const fetcher = async () => new Response('{"error":"Invalid API key"}', {status: 403});
  const post = new Request('https://shop.example/api/etsy/connect', {method: 'POST', body: new URLSearchParams({k: 'goodkey', secret: 'wrongsecret'})});
  const res = await etsyRoute(post, new URL(post.url), store, env, NOW, null, fetcher);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /didn’t accept/);
  assert.equal(await loadConnection(store, env), null);
});

test('scheduled run renews near expiry and applies listing changes once, checked by reading back', async () => {
  const store = fakeStore();
  store.rows.set('etsy_connection', await seal(env, {secret: 's3cret', access_token: '42.old', refresh_token: '42.ref', expires_at: NOW + 100, shop_id: '777', shop_name: 'NinosTs'}));
  const patches = [];
  const fetcher = async (url, init = {}) => {
    if (String(url).endsWith('/public/oauth/token')) return Response.json({access_token: '42.new', refresh_token: '42.ref2', expires_in: 3600});
    if (init.method === 'PATCH') {
      patches.push({url: String(url), auth: init.headers.Authorization, body: new URLSearchParams(init.body)});
      const b = new URLSearchParams(init.body);
      return Response.json({title: b.get('title'), tags: (b.get('tags') || '').split(',')});
    }
    return new Response('no', {status: 500});
  };
  const updates = [{listing_id: 11, title: 'Krampus Christmas T-Shirt', tags: ['krampus shirt', 'gothic christmas']}];
  const first = await runEtsy(store, env, NOW, fetcher, updates);
  assert.deepEqual(first, {state: 'ok', applied: 1, failed: 0});
  assert.equal(patches[0].auth, 'Bearer 42.new');
  assert.equal(patches[0].body.get('tags'), 'krampus shirt,gothic christmas');
  const again = await runEtsy(store, env, NOW + 60, fetcher, updates);
  assert.deepEqual(again, {state: 'ok', applied: 0, failed: 0});
  assert.equal(patches.length, 1);
  const conn = await loadConnection(store, env);
  assert.ok(conn.applied.includes(updateKey(updates[0])));
  assert.equal(conn.refresh_token, '42.ref2');
});

test('not connected: the scheduled step does nothing', async () => {
  assert.deepEqual(await runEtsy(fakeStore(), env, NOW, async () => { throw new Error('no calls'); }, []), {state: 'not_connected'});
});
