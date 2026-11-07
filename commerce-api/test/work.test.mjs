import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workRoute,ensureManagerLink,STATE_KEY,LINK_KEY,parseState} from '../src/work.mjs';

function fakeStore() {
  const settings = new Map();
  return {settings,
    first: async (_sql, key) => settings.has(key) ? {value: settings.get(key)} : null,
    run: async (sql, ...v) => {
      if (/^UPDATE commerce_settings SET value=\? WHERE key=\? AND value=\?/.test(sql)) {
        const [value, key, old] = v; if (settings.get(key) !== old) return {meta: {changes: 0}};
        settings.set(key, value); return {meta: {changes: 1}};
      }
      if (/DO NOTHING/.test(sql)) { if (settings.has(v[0])) return {meta: {changes: 0}}; settings.set(v[0], v[1]); return {meta: {changes: 1}}; }
      settings.set(v[0], v[1]); return {meta: {changes: 1}};
    }};
}
function fakeBucket() {
  const files = new Map();
  return {files,
    put: async (key, bytes, options) => { files.set(key, {bytes, type: options.httpMetadata.contentType}); },
    get: async key => files.has(key) ? {arrayBuffer: async () => files.get(key).bytes} : null,
    delete: async keys => { for (const key of [].concat(keys)) files.delete(key); }};
}
const env = (store) => ({OWNER_EMAIL: 'info@menu-made.com', STOREFRONT_ORIGIN: 'https://ninobattaglia.com', COMMERCE_API_ORIGIN: 'https://api.example',
  MOCKUPS_HD: fakeBucket(), MAILER: {sent: [], async send(m) { this.sent.push(m); }}});
const cors = {'Access-Control-Allow-Origin': 'https://ninobattaglia.com'};
const call = (store, e, path, {method = 'GET', key, body, form} = {}) => {
  const headers = {}; if (key) headers.Authorization = `Bearer ${key}`;
  if (body) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://api.example${path}`, {method, headers, body: form || (body ? JSON.stringify(body) : undefined)});
  return workRoute(request, new URL(request.url), store, e, 1000, null, cors).catch(error => ({error}));
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const WEBP = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0))));

test('the first scheduled run makes the private link once and emails it to the owner', async () => {
  const store = fakeStore(); const e = env(store);
  assert.equal(await ensureManagerLink(store, e), 'sent');
  assert.equal(await ensureManagerLink(store, e), 'exists');
  assert.equal(e.MAILER.sent.length, 1);
  const key = store.settings.get(LINK_KEY);
  assert.match(key, /^[a-f0-9]{48}$/);
  assert.equal(e.MAILER.sent[0].to, 'info@menu-made.com');
  assert.ok(e.MAILER.sent[0].text.includes(`https://ninobattaglia.com/work-manager.html#k=${key}`));
  assert.doesNotMatch(e.MAILER.sent[0].text + e.MAILER.sent[0].html, /[←-⇿]/, 'no arrows');
  assert.equal(await ensureManagerLink(store, {}), 'no_mailer');
});

test('changes need the private link; the public rotation needs nothing', async () => {
  const store = fakeStore(); const e = env(store); await ensureManagerLink(store, e);
  const denied = await call(store, e, '/api/work/manage');
  assert.equal(denied.error.status, 401);
  const wrong = await call(store, e, '/api/work/visibility', {method: 'POST', key: 'nope', body: {id: 'x', shown: false}});
  assert.equal(wrong.error.status, 401);
  const open = await call(store, e, '/api/work/rotation');
  assert.equal(open.status, 200);
  assert.deepEqual(await open.json(), {hidden: [], added: []});
  assert.equal(open.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await call(store, e, '/api/other'), null);
});

test('hide and show a catalog piece; quick repeated taps never duplicate', async () => {
  const store = fakeStore(); const e = env(store); await ensureManagerLink(store, e); const key = store.settings.get(LINK_KEY);
  await call(store, e, '/api/work/visibility', {method: 'POST', key, body: {id: 'pool-molinari-logo', shown: false}});
  await call(store, e, '/api/work/visibility', {method: 'POST', key, body: {id: 'pool-molinari-logo', shown: false}});
  assert.deepEqual(parseState(store.settings.get(STATE_KEY)).hidden, ['pool-molinari-logo']);
  const res = await call(store, e, '/api/work/visibility', {method: 'POST', key, body: {id: 'pool-molinari-logo', shown: true}});
  assert.deepEqual((await res.json()).hidden, []);
  const bad = await call(store, e, '/api/work/visibility', {method: 'POST', key, body: {id: '../x', shown: false}});
  assert.equal(bad.error.status, 400);
});

test('add a picture, it is served from storage, then delete it for good', async () => {
  const store = fakeStore(); const e = env(store); await ensureManagerLink(store, e); const key = store.settings.get(LINK_KEY);
  const form = new FormData();
  form.set('title', '  Sunset   poster '); form.set('category', 'Illustration'); form.set('description', 'A poster.');
  form.set('full', new Blob([WEBP], {type: 'image/webp'}), 'full.webp'); form.set('thumb', new Blob([JPEG], {type: 'image/jpeg'}), 'thumb.jpg');
  const res = await call(store, e, '/api/work/add', {method: 'POST', key, form});
  assert.equal(res.status, 200, JSON.stringify(res.error));
  const state = await res.json();
  const piece = state.added[0];
  assert.equal(piece.title, 'Sunset poster');
  assert.equal(piece.category, 'Illustration');
  assert.match(piece.image, /^https:\/\/api\.example\/api\/work\/img\/work-[a-f0-9]{12}-640\.jpg$/);
  assert.match(piece.gallery[0], /\/api\/work\/img\/work-[a-f0-9]{12}\.webp$/);
  assert.equal(e.MOCKUPS_HD.files.size, 2);
  const img = await call(store, e, new URL(piece.image).pathname);
  assert.equal(img.status, 200); assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  const pub = await (await call(store, e, '/api/work/rotation')).json();
  assert.equal(pub.added[0].id, piece.id);
  const del = await call(store, e, '/api/work/delete', {method: 'POST', key, body: {id: piece.id}});
  assert.equal(del.status, 200);
  assert.equal(e.MOCKUPS_HD.files.size, 0);
  assert.deepEqual(parseState(store.settings.get(STATE_KEY)).added, []);
});

test('uploads that are not pictures, or have no name, are refused in plain words', async () => {
  const store = fakeStore(); const e = env(store); await ensureManagerLink(store, e); const key = store.settings.get(LINK_KEY);
  const form = new FormData(); form.set('title', 'X'); form.set('full', new Blob(['<svg>']), 'a.svg'); form.set('thumb', new Blob(['<svg>']), 'a.svg');
  const res = await call(store, e, '/api/work/add', {method: 'POST', key, form});
  assert.equal(res.error.status, 400); assert.match(res.error.message, /JPG or PNG/);
  const noName = new FormData(); noName.set('full', new Blob([JPEG]), 'a.jpg'); noName.set('thumb', new Blob([JPEG]), 'a.jpg');
  assert.match((await call(store, e, '/api/work/add', {method: 'POST', key, form: noName})).error.message, /name/);
  assert.equal(e.MOCKUPS_HD.files.size, 0);
});

test('a new private link replaces the old one and is emailed to the owner', async () => {
  const store = fakeStore(); const e = env(store); await ensureManagerLink(store, e); const old = store.settings.get(LINK_KEY);
  const res = await call(store, e, '/api/work/new-link', {method: 'POST', key: old});
  assert.equal(res.status, 200);
  assert.notEqual(store.settings.get(LINK_KEY), old);
  assert.equal(e.MAILER.sent.length, 2); assert.match(e.MAILER.sent[1].subject, /new private link/);
  assert.equal((await call(store, e, '/api/work/manage', {key: old})).error.status, 401);
  assert.equal((await call(store, e, '/api/work/manage', {key: store.settings.get(LINK_KEY)})).status, 200);
});
