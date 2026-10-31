// Stage 14 task 1: every design on more products.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCT_TYPES,pickVariants,position,buildProduct,designFromDetail,retailPrice,typeOf,runExpansion} from '../src/expand.mjs';
import {lineTaxCode} from '../src/checkout.mjs';
import {storefrontProducts} from '../../catalog-sync.mjs';

const spec = type => PRODUCT_TYPES.find(t => t.type === type);
const crewVariants = [];
let n = 1;
for (const color of ['Black', 'Navy', 'Maroon', 'White', 'Sport Grey', 'Gold']) for (const size of ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']) crewVariants.push({id: n++, color, size, price: size === '2XL' ? 21.17 : 19.17, in_stock: true});

test('price is Printful cost x 1.5, rounded up to the dollar', () => {
  assert.equal(retailPrice(19.17), '29.00');
  assert.equal(retailPrice(20), '30.00', 'the owner example: $20 sells for $30');
  assert.equal(retailPrice(2.34), '4.00');
  assert.equal(retailPrice(15.87), '24.00');
});

test('garment colors follow the design: its dark shirt colors first, at most 3, sizes S to 3XL', () => {
  const picked = pickVariants(spec('crewneck'), crewVariants, ['Maroon', 'White', 'Black', 'Gold', 'Navy']);
  assert.deepEqual([...new Set(picked.map(v => v.color))], ['Black', 'Navy', 'Maroon']);
  assert.deepEqual([...new Set(picked.map(v => v.size))], ['S', 'M', 'L', 'XL', '2XL', '3XL']);
  assert.deepEqual([...new Set(pickVariants(spec('crewneck'), crewVariants, ['White', 'Sport Grey']).map(v => v.color))], ['White', 'Sport Grey'], 'a light-only design stays light');
  assert.deepEqual([...new Set(pickVariants(spec('crewneck'), crewVariants, ['Pink']).map(v => v.color))], ['Black'], 'nothing in common: black');
});

test('tote color follows the design; stickers come in three sizes', () => {
  const tote = [{id: 10457, color: 'Black', size: 'One size', price: 15.87}, {id: 10458, color: 'Oyster', size: 'One size', price: 15.87}];
  assert.deepEqual(pickVariants(spec('tote'), tote, ['Black', 'Navy']).map(v => v.color), ['Black']);
  assert.deepEqual(pickVariants(spec('tote'), tote, ['White']).map(v => v.color), ['Oyster']);
  assert.deepEqual(pickVariants(spec('tote'), tote, ['Black', 'White']).map(v => v.color), ['Black', 'Oyster']);
  const stickers = [10163, 10164, 10165, 16362].map(id => ({id, color: 'White', size: String(id), price: 2.5}));
  assert.deepEqual(pickVariants(spec('sticker'), stickers, []).map(v => v.id), [10163, 10164, 10165], 'no bumper sticker');
});

test('artwork keeps its proportions inside the print area', () => {
  const art = {width: 1880, height: 1555};
  const chest = position(spec('crewneck'), [1800, 2400], art);
  assert.ok(chest.width <= 1800 * 0.8627 + 1 && chest.height <= 2400 * 0.75 + 1);
  assert.equal(chest.left, Math.round((1800 - chest.width) / 2));
  assert.equal(chest.top, Math.round(2400 * 0.1473), 'starts at the collar line like the shirts');
  assert.ok(Math.abs(chest.width / chest.height - 1880 / 1555) < 0.01);
  const sticker = position(spec('sticker'), [900, 900], art);
  assert.ok(sticker.width <= 900 && sticker.top > 0 && sticker.left >= 0);
  assert.equal(position(spec('tote'), [1500, 1500], {width: 0, height: 10}), null);
});

const detail = {sync_product: {id: 482794926, name: 'Skull Wave T'}, sync_variants: [
  {color: 'Maroon', files: [{type: 'default', id: 1035411289, width: 1880, height: 1555, status: 'ok'}, {type: 'preview', id: 9}]},
  {color: 'Black', files: [{type: 'default', id: 1035411289, width: 1880, height: 1555, status: 'ok'}]}]};

test('a Printful product per design and type, tagged with the design, using the design’s own file', () => {
  const design = designFromDetail(detail);
  assert.deepEqual(design, {id: '482794926', name: 'Skull Wave T', art: {id: 1035411289, width: 1880, height: 1555}, colors: ['Maroon', 'Black']});
  const hoodie = buildProduct(spec('hoodie'), design, crewVariants);
  assert.equal(hoodie.sync_product.name, 'Skull Wave Hoodie');
  assert.equal(hoodie.sync_product.external_id, 'nx-hoodie-482794926');
  assert.deepEqual(typeOf('nx-hoodie-482794926'), {type: 'hoodie', design: '482794926'});
  assert.equal(typeOf('455597876'), null);
  assert.equal(hoodie.sync_variants[0].files[0].id, 1035411289);
  assert.equal(hoodie.sync_variants.find(v => v.variant_id === crewVariants.find(c => c.size === '2XL').id).retail_price, '32.00');
});

test('stickers and totes are taxed as goods, garments as clothing', () => {
  const snapshot = {product_tax_code: 'txcd_30011000'};
  assert.equal(lineTaxCode({kind: 'sticker'}, snapshot), 'txcd_99999999');
  assert.equal(lineTaxCode({kind: 'tote'}, snapshot), 'txcd_99999999');
  assert.equal(lineTaxCode({kind: 'hoodie'}, snapshot), 'txcd_30011000');
  assert.equal(lineTaxCode({}, snapshot), 'txcd_30011000', 'older orders');
});

test('the shop shows one card per design; the design lists its other products', () => {
  const live = new Map([
    ['1', {id: '1', external_id: '455', title: 'Skull Wave T', image: 'https://x/1.jpg', variants: new Map()}],
    ['2', {id: '2', external_id: 'nx-tote-1', title: 'Skull Wave Tote bag', image: 'https://x/2.jpg', variants: new Map()}],
    ['3', {id: '3', external_id: 'nx-sticker-1', title: 'Skull Wave Sticker', image: 'https://x/3.jpg', variants: new Map()}]
  ]);
  const cards = storefrontProducts([{id: '455', title: 'Skull Wave', image: 'assets/p.webp'}], live, true);
  assert.deepEqual(cards.map(c => c.id), ['1']);
  assert.deepEqual(cards[0].extras.sort(), ['sticker', 'tote']);
});

function fakeStore(settings, products) {
  return {settings,
    first: async (sql, key) => /active_catalog/.test(sql) ? {value: 'gen'} : settings.has(key ?? (sql.match(/key='([^']+)'/) || [])[1]) ? {value: settings.get(key ?? sql.match(/key='([^']+)'/)[1])} : null,
    all: async sql => /FROM catalog_products/.test(sql) ? products : [...settings.keys()].filter(k => k.startsWith('expand:')).map(key => ({key})),
    run: async (sql, key, value) => { settings.set(key, value); },
    activeGeneration: async () => 'gen'
  };
}

test('runs in steps: off by default, then the sample designs only, two products per run, errors recorded once', async () => {
  const settings = new Map();
  const products = [{id: '482794926', external_id: '455', title: 'Skull Wave T'}, {id: '999', external_id: '777', title: 'Other T'}];
  const posts = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({code: 200, result: {id: 5000 + posts.length}}); }
    if (path === '/store/products/482794926') return Response.json({code: 200, result: detail});
    if (path.startsWith('/products/')) return Response.json({code: 200, result: {variants: [
      ...crewVariants.map(v => ({...v, availability_status: [{region: 'US', status: 'in_stock'}]})),
      {id: 10163, color: 'White', size: '3', price: '2.34', availability_status: [{region: 'US', status: 'in_stock'}]},
      {id: 10164, color: 'White', size: '4', price: '2.54', availability_status: [{region: 'US', status: 'in_stock'}]},
      {id: 10165, color: 'White', size: '5.5', price: '2.74', availability_status: [{region: 'US', status: 'in_stock'}]},
      {id: 10457, color: 'Black', size: 'One size', price: '15.87', availability_status: [{region: 'US', status: 'in_stock'}]}]}});
    return new Response('{}', {status: 404});
  };
  const env = {PRINTFUL_ACCESS_TOKEN: 'k', PRINTFUL_STORE_ID: '1'};
  const store = fakeStore(settings, products);
  assert.deepEqual((await runExpansion(store, env, 1000, {fetcher})).created, [], 'off until expand_designs is set');
  settings.set('expand_designs', '482794926');
  const first = await runExpansion(store, env, 1000, {fetcher});
  assert.deepEqual(first.created, ['Skull Wave Sticker', 'Skull Wave Tote bag']);
  assert.equal(first.remaining, 2);
  const second = await runExpansion(store, env, 1001, {fetcher});
  assert.deepEqual(second.created, ['Skull Wave Crewneck sweatshirt', 'Skull Wave Hoodie']);
  assert.equal(second.remaining, 0);
  assert.equal(posts.length, 4);
  assert.ok(posts.every(p => p.sync_product.external_id.endsWith('-482794926')), 'only the sample design');
  assert.equal(settings.get('expand:482794926:hoodie'), '5004');
  assert.deepEqual((await runExpansion(store, env, 1002, {fetcher})).created, [], 'nothing left');
});
