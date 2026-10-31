// Self-renewing Printful connection: connect per store, renew hourly, fall back to the private keys, alert to reconnect.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signState,readState,withPrintfulTokens,connectRedirect,connectCallback,renewPrintfulTokens,connectionStatus,loadConnections} from '../src/printful-auth.mjs';

function fakeStore() {
  const rows = new Map();
  return {rows,
    first: async (sql, key) => rows.has(key) ? {value: rows.get(key)} : null,
    all: async (sql, ...keys) => keys.filter(k => rows.has(k)).map(key => ({key, value: rows.get(key)})),
    run: async (sql, key, value) => { if (/^DELETE/.test(sql)) rows.delete(key); else rows.set(key, value); }
  };
}
const NOW = 1_800_000_000;
const baseEnv = (extra = {}) => ({PRINTFUL_CLIENT_ID: 'app-1', PRINTFUL_CLIENT_SECRET: 'secret-1', COMMERCE_API_ORIGIN: 'https://shop-api.example', PRINTFUL_ACCESS_TOKEN: 'private-web', PRINTFUL_SOURCE_TOKEN: 'private-src', OWNER_EMAIL: 'info@menu-made.com', PRINTFUL_STORE_ID: '18919013', ...extra});

// A fake Printful: the token endpoint (JSON only, to prove the form-then-JSON fallback) and the store probes.
function fakePrintful({kindFor = {}, refreshFails = false} = {}) {
  const calls = []; let n = 0;
  const fetcher = async (url, init = {}) => {
    calls.push({url: String(url), init});
    if (String(url) === 'https://www.printful.com/oauth/token') {
      if (init.headers['Content-Type'] !== 'application/json') return new Response('{"error":"unsupported"}', {status: 415});
      const body = JSON.parse(init.body);
      if (body.grant_type === 'refresh_token' && refreshFails) return new Response('{"error":"invalid_grant"}', {status: 400});
      n++;
      return Response.json({access_token: `${body.code || 'r'}-access-${n}`, refresh_token: `refresh-${n}`, expires_at: String(NOW + 3600 * n), token_type: 'bearer'});
    }
    const token = init.headers.Authorization.slice(7);
    const kind = Object.entries(kindFor).find(([prefix]) => token.startsWith(prefix))?.[1];
    const ids = {website: 18919013, source: 18583773, blank: 99999999};
    if (String(url) === 'https://api.printful.com/store' && ids[kind]) return Response.json({code: 200, result: {id: ids[kind], name: kind === 'blank' ? 'Nino shop store' : kind}});
    return new Response('{}', {status: 404});
  };
  return {fetcher, calls};
}

test('signed state: right store, unexpired, untampered', async () => {
  const env = baseEnv();
  const state = await signState(env, 'website', NOW);
  assert.equal(await readState(env, state, NOW + 10), 'website');
  assert.equal(await readState(env, state, NOW + 4000), null, 'expired');
  assert.equal(await readState(env, state.replace('website', 'source'), NOW), null, 'tampered');
  assert.equal(await readState(baseEnv({PRINTFUL_CLIENT_SECRET: 'other'}), state, NOW), null, 'other secret');
});

test('connect link sends the owner to Printful with a signed state and the registered callback', async () => {
  const response = await connectRedirect(baseEnv(), 'website', NOW);
  assert.equal(response.status, 302);
  const to = new URL(response.headers.get('Location'));
  assert.equal(to.origin + to.pathname, 'https://www.printful.com/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'app-1');
  assert.equal(to.searchParams.get('redirect_url'), 'https://shop-api.example/api/printful/callback');
  assert.equal((await connectRedirect(baseEnv({PRINTFUL_CLIENT_ID: ''}), 'website', NOW)).status, 503);
  assert.equal((await connectRedirect(baseEnv(), 'mystery', NOW)).status, 400);
});

test('callback stores an encrypted connection for the right store only; requests then use the app token', async () => {
  const env = baseEnv(); const store = fakeStore();
  const {fetcher} = fakePrintful({kindFor: {web: 'website', src: 'source', other: 'website', blank: 'blank'}});
  const back = async (kind, code, success = '1') => connectCallback(env, store, new URL(`https://shop-api.example/api/printful/callback?state=${encodeURIComponent(await signState(env, kind, NOW))}&code=${code}&success=${success}`), NOW, fetcher);

  assert.equal((await back('website', 'web', '0')).status, 200, 'declined: nothing stored');
  assert.equal(store.rows.size, 0);
  const wrong = await back('source', 'other');   // approved for the shop store on the NinosTs link
  assert.equal(wrong.status, 409);
  assert.equal(store.rows.size, 0);
  const blank = await back('website', 'blank');   // a new empty API store Printful created during approval
  assert.equal(blank.status, 409);
  assert.match(await blank.text(), /Nino shop store.*99999999/);
  assert.equal(store.rows.size, 0, 'empty store never saved as the shop');

  const ok = await back('website', 'web');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Next: <a href="https:\/\/shop-api.example\/api\/printful\/connect\?store=source"/);
  assert.doesNotMatch(store.rows.get('printful_oauth:website'), /web-access/, 'stored encrypted');

  let used = await withPrintfulTokens(env, store, NOW);
  assert.match(used.PRINTFUL_ACCESS_TOKEN, /^web-access-/);
  assert.equal(used.PRINTFUL_SOURCE_TOKEN, 'private-src', 'NinosTs still on its key until connected');

  await back('source', 'src');
  used = await withPrintfulTokens(env, store, NOW);
  assert.match(used.PRINTFUL_SOURCE_TOKEN, /^src-access-/);
  assert.deepEqual(await connectionStatus(store, env, NOW), {website: 'app', source: 'app'});
  assert.equal(await withPrintfulTokens(baseEnv({PRINTFUL_CLIENT_SECRET: ''}), store, NOW).then(e => e.PRINTFUL_ACCESS_TOKEN), 'private-web', 'no app: private key');
});

test('renewal runs when under 20 minutes remain and keeps the new refresh token; a failed one falls back and alerts once', async () => {
  const sent = []; const env = baseEnv({MAILER: {send: async m => { sent.push(m); }}}); const store = fakeStore();
  const good = fakePrintful({kindFor: {web: 'website'}});
  await connectCallback(env, store, new URL(`https://x/api/printful/callback?state=${encodeURIComponent(await signState(env, 'website', NOW))}&code=web&success=1`), NOW, good.fetcher);
  const first = (await loadConnections(store, env)).website;

  assert.deepEqual(await renewPrintfulTokens(store, env, NOW, good.fetcher), {website: 'fresh'});
  const later = Number(first.expires_at) - 600;
  assert.deepEqual(await renewPrintfulTokens(store, env, later, good.fetcher), {website: 'renewed'});
  const renewed = (await loadConnections(store, env)).website;
  assert.notEqual(renewed.refresh_token, first.refresh_token);
  assert.ok(Number(renewed.expires_at) > Number(first.expires_at));

  const bad = fakePrintful({refreshFails: true});
  const past = Number(renewed.expires_at) + 60;
  const result = await renewPrintfulTokens(store, env, past, bad.fetcher);
  assert.match(result.website, /^failed/);
  assert.equal((await withPrintfulTokens(env, store, past)).PRINTFUL_ACCESS_TOKEN, 'private-web', 'expired app token: private key');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/shop-api.example\/api\/printful\/connect\?store=website/);
  await renewPrintfulTokens(store, env, past + 3600, bad.fetcher);
  assert.equal(sent.length, 1, 'once per 6 hours');
});
