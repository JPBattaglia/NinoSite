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


// Nov 2, 2026: Printful's photo of a store mug ignores the placement, so the mug gets a full-wrap file with the
// design already on the face seen with the handle on the right; the file is fitted to each size's wrap.
test('mug artwork goes on both mug sizes, fitted to each wrap', async () => {
  const {KINDS, MUG_SITE, mugFile} = await import('../src/sticker-art.mjs');
  const {remakeMug} = await import('../src/expand.mjs');
  const mugCatalog = [{id: 1320, size: '11 oz', price: '6.07'}, {id: 4830, size: '15 oz', price: '8.11'}].map(v => ({...v, color: 'White', availability_status: [{region: 'US', status: 'in_stock'}]}));
  const settings = new Map([['expand:482794926:mug', '488500000']]);
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if (url.startsWith(MUG_SITE)) return Response.json({'482794926': {sha: SHA, w: 2700, h: 1140}});
    calls.push({method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null});
    if (init.method === 'POST' && u.pathname === '/files') return Response.json({code: 200, result: {id: 9100}});
    if (init.method === 'PUT') return Response.json({code: 200, result: {}});
    if (u.pathname === '/store/products/482794926') return Response.json({code: 200, result: detail});
    if (u.pathname === '/products/19') return Response.json({code: 200, result: {variants: mugCatalog}});
    return new Response('{}', {status: 404});
  };
  const out = await applyStickerArt(fakeStore(settings), env, 1000, {api, remake: remakeMug}, {fetcher, max: 2, kind: KINDS.mug});
  assert.deepEqual(out.applied, ['482794926']);
  assert.equal(calls.find(c => c.path === '/files').body.url, `${MUG_SITE}482794926.png?v=${SHA}`);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.path, '/store/products/488500000');
  const [small, large] = put.body.sync_variants;
  assert.deepEqual(large.files[0].position, {area_width: 2700, area_height: 1140, width: 2700, height: 1140, top: 0, left: 0, limit_to_print_area: true}, '15 oz: the whole wrap');
  assert.deepEqual(small.files[0].position, {area_width: 2700, area_height: 1050, width: 2487, height: 1050, top: 0, left: 107, limit_to_print_area: true}, '11 oz: fitted to its height');
  assert.deepEqual(await mugFile(fakeStore(settings), '482794926'), {id: 9100, width: 2700, height: 1140});
});

// Nov 3, 2026: the mug artwork goes on the black mug too, when the design has one.
test('new mug artwork remakes the white and the black mug', async () => {
  const {KINDS} = await import('../src/sticker-art.mjs');
  const settings = new Map([['expand:482794926:mug', '488500000'], ['expand:482794926:mugblack', '489900000'],
    ['mug_manifest', JSON.stringify({at: 1000, designs: {482794926: {sha: 'abcdefabcdef12', w: 2700, h: 1140}}})]]);
  const remade = [];
  const deps = {api: async () => ({result: {id: 9200}}), remake: async (store, env, now, design, product, art, fetcher, type) => { remade.push([product, type]); }};
  const out = await applyStickerArt(fakeStore(settings), {PRINTFUL_ACCESS_TOKEN: 'k', PRINTFUL_STORE_ID: '1'}, 1001, deps, {fetcher: async () => new Response('{}'), max: 2, kind: KINDS.mug});
  assert.deepEqual(out.errors, []);
  assert.deepEqual(remade, [['488500000', 'mug'], ['489900000', 'mugblack']]);
});
