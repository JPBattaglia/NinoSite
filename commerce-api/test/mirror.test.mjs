import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures.mjs';
import {runMirror,buildPayload,placement,nameKey,MIRROR_MAX_PER_RUN} from '../src/mirror.mjs';

const file = (extra = {}) => ({id: 9001, type: 'default', hash: 'abc123def', url: null, status: 'ok', width: 2347, height: 1362, dpi: 300, ...extra});
const variant = (id, extra = {}) => ({id: id + 1000, variant_id: id, synced: true, is_ignored: false, retail_price: '25.00', files: [file(), file({id: 9002, type: 'preview'})], options: [], ...extra});
const sourceProduct = (id, name, extra = {}) => ({sync_product: {id, name, is_ignored: false}, sync_variants: [variant(4011), variant(4012)], ...extra});

async function setup(sourceNames = ['Alpha T', 'Beta &amp; Co T', 'Gamma T'], destinationNames = ['Alpha T']) {
  const f = await fixture();
  f.db.db.exec(readFileSync(new URL('../migrations/0004_mockups.sql', import.meta.url), 'utf8'));
  f.env.PRINTFUL_SOURCE_TOKEN = 'source-token-fixture'; f.env.PRINTFUL_ACCESS_TOKEN = 'dest-token-fixture'; f.env.PRINTFUL_STORE_ID = '555';
  const sources = sourceNames.map((name, index) => sourceProduct(5000 + index, name));
  f.printful.products = new Map(destinationNames.map((name, index) => [String(9000 + index), {sync_product: {id: 9000 + index, name}}]));
  const calls = []; let createdId = 7000;
  const fetcher = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({url, method: init.method || 'GET', store: headers['X-PF-Store-Id'], auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null});
    if (url.includes('/store/products?')) return Response.json({code: 200, result: sources.map(p => p.sync_product), paging: {total: sources.length}});
    const m = url.match(/\/store\/products\/(\d+)$/);
    if (m && (init.method || 'GET') === 'GET') return Response.json({code: 200, result: sources.find(p => String(p.sync_product.id) === m[1])});
    if (url.endsWith('/store/products') && init.method === 'POST') return Response.json({code: 200, result: {id: ++createdId}});
    return new Response('{}', {status: 404});
  };
  return {f, calls, fetcher, sources};
}

test('stays off until the source token exists', async () => {
  const {f, calls, fetcher} = await setup();
  delete f.env.PRINTFUL_SOURCE_TOKEN;
  const result = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.equal(result.status, 'disabled'); assert.equal(calls.length, 0);
});

test('copies only designs the website store does not have, matching names despite HTML entities', async () => {
  const {f, calls, fetcher} = await setup();
  const result = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.created.sort(), ['Beta & Co T', 'Gamma T']);
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.ok(posts.every(c => c.store === '555' && c.auth === 'Bearer dest-token-fixture'));
  const reads = calls.filter(c => c.method === 'GET');
  assert.ok(reads.every(c => c.store === '18583773' && c.auth === 'Bearer source-token-fixture' || c.url.includes('/store/products?') ));
});

test('copies price, variants and print artwork, drops preview files, and queues model photos', async () => {
  const {f, calls, fetcher} = await setup(['Zed T'], []);
  await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  const post = calls.find(c => c.method === 'POST').body;
  assert.equal(post.sync_product.name, 'Zed T');
  assert.equal(post.sync_variants.length, 2);
  assert.equal(post.sync_variants[0].retail_price, '25.00');
  assert.equal(post.sync_variants[0].files.length, 1);
  assert.equal(post.sync_variants[0].files[0].id, 9001);
  assert.deepEqual(Object.keys(post.sync_variants[0].files[0].position).sort(), ['area_height', 'area_width', 'height', 'left', 'top', 'width']);
  const job = await f.store.first("SELECT * FROM mockup_jobs WHERE product_id='7001'");
  assert.equal(job.status, 'pending'); assert.equal(job.priority, 10);
  const layer = JSON.parse(job.layer_json);
  assert.ok(layer.width <= 10.353 && layer.height <= 12.001 && layer.left >= 0 && layer.left + layer.width <= 12.001);
});

test('does not copy the same design twice, even if its name later changes', async () => {
  const {f, calls, fetcher} = await setup(['Solo T'], []);
  await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  f.printful.products = new Map();
  const again = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.deepEqual(again.created, []);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('copies at most a few designs per run, newest first, and finishes the rest next run', async () => {
  const names = ['A T', 'B T', 'C T', 'D T', 'E T'];
  const {f, fetcher} = await setup(names, []);
  const first = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.equal(first.created.length, MIRROR_MAX_PER_RUN);
  assert.deepEqual(first.created, ['E T', 'D T', 'C T']);
  f.printful.products = new Map(first.created.map((name, i) => [String(i), {sync_product: {id: i, name}}]));
  const second = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.deepEqual(second.created, ['B T', 'A T']);
});

test('a failed copy is reported, not marked done, and does not stop the others', async () => {
  const {f, fetcher} = await setup(['Good T', 'Bad T'], []);
  const failing = async (url, init = {}) => init.method === 'POST' && JSON.parse(init.body).sync_product.name === 'Bad T' ? new Response('{"error":"nope"}', {status: 400}) : fetcher(url, init);
  const result = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher: failing});
  assert.deepEqual(result.created, ['Good T']);
  assert.equal(result.errors.length, 1); assert.match(result.errors[0], /Bad T: create 400/);
  const retry = await runMirror(f.store, f.env, f.now(), {destination: f.printful, fetcher});
  assert.deepEqual(retry.created, ['Bad T']);
  const last = JSON.parse((await f.store.first("SELECT value FROM commerce_settings WHERE key='mirror_last'")).value);
  assert.equal(last.status, 'ok');
});

test('helpers', () => {
  assert.equal(nameKey('  Dark  Mode&#39;s T '), "dark mode's t");
  assert.equal(buildPayload({sync_product: {name: 'X'}, sync_variants: [variant(1, {is_ignored: true}), variant(2, {retail_price: '0'}), variant(3, {files: [file({type: 'preview'})]})]}), null);
  const p = placement(file({width: 1000, height: 3000, dpi: 300}));
  assert.equal(p.height, 12); assert.ok(p.width < 10.352);
});
