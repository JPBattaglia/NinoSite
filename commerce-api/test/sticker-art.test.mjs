// One-piece stickers (owner, Nov 1, 2026): published sticker artwork replaces the loose-parts artwork on stickers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyStickerArt, stickerFile, stickerManifest, STICKER_SITE} from '../src/sticker-art.mjs';
import {api, remakeSticker, runExpansion, photoLayer, PRODUCT_TYPES} from '../src/expand.mjs';

const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const detail = {sync_product: {id: 482794926, name: 'Dark Mode T'}, sync_variants: [{color: 'Black', files: [{id: 1035411289, type: 'default', width: 4000, height: 3800, status: 'ok'}]}]};
const stickerCatalog = [10163, 10164, 10165, 16362].map((id, i) => ({id, color: 'White', size: String(i), price: '2.50', availability_status: [{region: 'US', status: 'in_stock'}]}));

function fakeStore(settings, products = []) {
  const key = sql => (sql.match(/key='([^']+)'/) || [])[1];
  return {settings,
    first: async (sql, k) => /active_catalog/.test(sql) ? {value: 'gen'} : settings.has(k ?? key(sql)) ? {value: settings.get(k ?? key(sql))} : null,
    all: async sql => {
      if (/FROM catalog_products/.test(sql)) return products;
      const prefix = (sql.match(/LIKE '([^%']+)%'/) || [])[1] || 'expand:';
      return [...settings].filter(([k]) => k.startsWith(prefix)).map(([k, value]) => ({key: k, value}));
    },
    run: async (sql, a, b) => { if (/mockup_jobs/.test(sql)) settings.set(`job:${a}`, b); else settings.set(a, b); },
    activeGeneration: async () => 'gen'
  };
}

function printful(manifest) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if (url.startsWith(STICKER_SITE)) return Response.json(manifest);
    calls.push({method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null});
    if (init.method === 'POST' && u.pathname === '/files') return Response.json({code: 200, result: {id: 7000 + calls.length, status: 'waiting'}});
    if (init.method === 'PUT') return Response.json({code: 200, result: {}});
    if (u.pathname === '/store/products/482794926') return Response.json({code: 200, result: detail});
    if (u.pathname === '/products/358') return Response.json({code: 200, result: {variants: stickerCatalog}});
    return new Response('{}', {status: 404});
  };
  return {calls, fetcher};
}
const env = {PRINTFUL_ACCESS_TOKEN: 'k', PRINTFUL_STORE_ID: '1'};
const deps = {api, remake: remakeSticker};

test('published one-piece art is added to Printful and the existing sticker is remade with it', async () => {
  const settings = new Map([['expand:482794926:sticker', '487877435']]);
  const {calls, fetcher} = printful({'482794926': {sha: SHA, w: 2000, h: 1900}, 'bad id': {sha: SHA, w: 1, h: 1}});
  const out = await applyStickerArt(fakeStore(settings), env, 1000, deps, {fetcher});
  assert.deepEqual(out.applied, ['482794926']);
  assert.deepEqual(out.errors, []);
  const upload = calls.find(c => c.path === '/files');
  assert.equal(upload.body.url, `${STICKER_SITE}482794926.png?v=${SHA}`);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.path, '/store/products/487877435');
  const fileId = put.body.sync_variants[0].files[0].id;
  assert.ok(fileId > 7000, 'the uploaded file');
  assert.ok(put.body.sync_variants.length === 4 && put.body.sync_variants.every(v => v.files[0].id === fileId), 'every size uses the new file');
  assert.equal(put.body.sync_product.name, 'Dark Mode Sticker');
  assert.deepEqual(await stickerFile(fakeStore(settings), '482794926'), {id: put.body.sync_variants[0].files[0].id, width: 2000, height: 1900});
  const job = JSON.parse(settings.get('job:487877435'));
  assert.equal(job.file_id, put.body.sync_variants[0].files[0].id, 'the photo waits for the new file');
  // Same artwork again: nothing to do. New artwork (new sha): done again.
  assert.deepEqual((await applyStickerArt(fakeStore(settings), env, 1001, deps, {fetcher})).applied, []);
  settings.set('sticker_manifest', JSON.stringify({at: 0, designs: {}}));
  const again = printful({'482794926': {sha: SHA2, w: 2000, h: 1900}});
  assert.deepEqual((await applyStickerArt(fakeStore(settings), env, 5000, deps, {fetcher: again.fetcher})).applied, ['482794926']);
});

test('a design with no sticker product yet only records the art; the next sticker made uses it', async () => {
  const settings = new Map();
  const {calls, fetcher} = printful({'482794926': {sha: SHA, w: 2000, h: 1900}});
  assert.deepEqual((await applyStickerArt(fakeStore(settings), env, 1000, deps, {fetcher})).applied, ['482794926']);
  assert.ok(!calls.some(c => c.method === 'PUT'));
  const art = await stickerFile(fakeStore(settings), '482794926');
  settings.set('expand_designs', '482794926');
  const posts = [];
  const create = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({code: 200, result: {id: 9000 + posts.length}}); }
    return fetcher(url, init);
  };
  await runExpansion(fakeStore(settings, [{id: '482794926', external_id: '455', title: 'Dark Mode T'}]), env, 2000, {fetcher: create, max: 1});
  const sticker = posts.find(p => p.sync_product.external_id === 'nx-sticker-482794926');
  assert.ok(sticker.sync_variants.every(v => v.files[0].id === art.id));
});

test('at most 3 designs per run; failures are recorded and retried', async () => {
  const manifest = Object.fromEntries([1, 2, 3, 4, 5].map(n => [`48279490${n}`, {sha: SHA, w: 100, h: 100}]));
  const settings = new Map();
  const {fetcher} = printful(manifest);
  const first = await applyStickerArt(fakeStore(settings), env, 1000, deps, {fetcher});
  assert.equal(first.applied.length, 3); assert.equal(first.remaining, 2);
  const broken = async (url, init = {}) => init.method === 'POST' ? new Response('nope', {status: 500}) : fetcher(url, init);
  const second = await applyStickerArt(fakeStore(settings), env, 1001, deps, {fetcher: broken});
  assert.equal(second.applied.length, 0); assert.equal(second.errors.length, 2);
  assert.equal((await applyStickerArt(fakeStore(settings), env, 1002, deps, {fetcher})).applied.length, 2);
});

test('manifest entries that are not design ids with a hash and size are ignored', async () => {
  const settings = new Map();
  const {fetcher} = printful({'1': {sha: SHA, w: 10, h: 10}, '2': {sha: 'nothex', w: 10, h: 10}, '3': {sha: SHA, w: 0, h: 10}, '../x': {sha: SHA, w: 1, h: 1}});
  assert.deepEqual(Object.keys(await stickerManifest(fakeStore(settings), 1, fetcher)), ['1']);
});

test('photo layers name the artwork file so a remade sticker waits for the new catalog copy', () => {
  const spec = PRODUCT_TYPES.find(t => t.type === 'sticker');
  const payload = {sync_variants: [{variant_id: 10165, files: [{id: 42, position: {width: 300, height: 300, top: 0, left: 0}}]}]};
  assert.equal(photoLayer(spec, {}, payload, []).file_id, 42);
});

// Nov 2, 2026: the shop shows a sticker's own one-piece artwork, not Printful's lagging preview.
test('a sticker shows its one-piece artwork once that artwork is on the product', async () => {
  const {stickerPictures, stickerPicture} = await import('../src/catalog.mjs');
  const sha = 'b171de1c9728fff62074f4205dac346cf78a0e77';
  const store = {first: async () => ({value: JSON.stringify({'482794901': sha})})};
  const pictures = await stickerPictures(store);
  assert.equal(stickerPicture(pictures, 'nx-sticker-482794901'), `https://ninobattaglia.com/assets/stickers/preview/482794901.webp?v=${sha.slice(0, 12)}`);
  assert.equal(stickerPicture(pictures, 'nx-hoodie-482794901'), null, 'other products keep their own pictures');
  assert.equal(stickerPicture(pictures, 'nx-sticker-999'), null, 'a sticker not remade yet keeps Printful\'s preview');
  assert.equal(stickerPicture(await stickerPictures({first: async () => null}), 'nx-sticker-482794901'), null);
  assert.equal(stickerPicture(await stickerPictures({first: async () => { throw new Error('d1'); }}), 'nx-sticker-482794901'), null, 'never breaks the catalog');
});

// Nov 2, 2026: the apron prints its file over the whole apron, so the small, top-centered design is drawn on a
// full-size apron file and that file covers the whole print area.
test('apron artwork goes on the apron product covering the whole apron, every strap color', async () => {
  const {KINDS, APRON_SITE, apronFile} = await import('../src/sticker-art.mjs');
  const {remakeApron} = await import('../src/expand.mjs');
  const apronCatalog = [23723, 23724, 23725, 23726, 23727].map(id => ({id, color: String(id), size: 'One size', price: '24', availability_status: [{region: 'US', status: 'in_stock'}]}));
  const settings = new Map([['expand:482794926:apron', '487894999']]);
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if (url.startsWith(APRON_SITE)) return Response.json({'482794926': {sha: SHA, w: 4075, h: 4961}});
    calls.push({method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null});
    if (init.method === 'POST' && u.pathname === '/files') return Response.json({code: 200, result: {id: 9001}});
    if (init.method === 'PUT') return Response.json({code: 200, result: {}});
    if (u.pathname === '/store/products/482794926') return Response.json({code: 200, result: detail});
    if (u.pathname === '/products/927') return Response.json({code: 200, result: {variants: apronCatalog}});
    return new Response('{}', {status: 404});
  };
  const out = await applyStickerArt(fakeStore(settings), env, 1000, {api, remake: remakeApron}, {fetcher, max: 2, kind: KINDS.apron});
  assert.deepEqual(out.applied, ['482794926']);
  assert.equal(calls.find(c => c.path === '/files').body.url, `${APRON_SITE}482794926.png?v=${SHA}`);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.path, '/store/products/487894999');
  assert.equal(put.body.sync_variants.length, 5);
  for (const v of put.body.sync_variants) assert.deepEqual(v.files[0], {type: 'default', id: 9001, position: {area_width: 4075, area_height: 4961, width: 4075, height: 4961, top: 0, left: 0, limit_to_print_area: true}});
  assert.deepEqual(await apronFile(fakeStore(settings), '482794926'), {id: 9001, width: 4075, height: 4961});
  assert.equal(settings.get('expand:482794926:sticker'), undefined, 'stickers untouched');
});
