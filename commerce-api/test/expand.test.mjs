// Stage 14 task 1: every design on more products.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCT_TYPES,pickVariants,position,buildProduct,designFromDetail,retailPrice,typeOf,runExpansion} from '../src/expand.mjs';
import {lineTaxCode} from '../src/checkout.mjs';
import {storefrontProducts} from '../../catalog-sync.mjs';

const spec = type => PRODUCT_TYPES.find(t => t.type === type);
const crewVariants = [];
let n = 1;
for (const color of ['Black', 'Navy', 'Maroon', 'White', 'Sport Grey', 'Gold']) for (const size of ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL']) crewVariants.push({id: n++, color, size, price: size === '2XL' ? 21.17 : 19.17, in_stock: true});

test('price is Printful cost x 1.5, rounded up to the dollar', () => {
  assert.equal(retailPrice(19.17), '29.00');
  assert.equal(retailPrice(20), '30.00', 'the owner example: $20 sells for $30');
  assert.equal(retailPrice(2.34), '4.00');
  assert.equal(retailPrice(15.87), '24.00');
});

test('garment colors follow the design: its dark shirt colors first, at most 3, sizes S to 5XL', () => {
  const picked = pickVariants(spec('crewneck'), crewVariants, ['Maroon', 'White', 'Black', 'Gold', 'Navy']);
  assert.deepEqual([...new Set(picked.map(v => v.color))], ['Black', 'Navy', 'Maroon']);
  assert.deepEqual([...new Set(picked.map(v => v.size))], ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']);
  assert.deepEqual([...new Set(pickVariants(spec('crewneck'), crewVariants, ['White', 'Sport Grey']).map(v => v.color))], ['White', 'Sport Grey'], 'a light-only design stays light');
  assert.deepEqual([...new Set(pickVariants(spec('crewneck'), crewVariants, ['Pink']).map(v => v.color))], ['Black'], 'nothing in common: black');
});

test('tote color follows the design; stickers come in three sizes plus the bumper size', () => {
  const tote = [{id: 10457, color: 'Black', size: 'One size', price: 15.87}, {id: 10458, color: 'Oyster', size: 'One size', price: 15.87}];
  assert.deepEqual(pickVariants(spec('tote'), tote, ['Black', 'Navy']).map(v => v.color), ['Black']);
  assert.deepEqual(pickVariants(spec('tote'), tote, ['White']).map(v => v.color), ['Oyster']);
  assert.deepEqual(pickVariants(spec('tote'), tote, ['Black', 'White']).map(v => v.color), ['Black', 'Oyster']);
  const stickers = [10163, 10164, 10165, 16362].map(id => ({id, color: 'White', size: String(id), price: 2.5}));
  assert.deepEqual(pickVariants(spec('sticker'), stickers, []).map(v => v.id), [10163, 10164, 10165, 16362], 'with the 15x3.75in bumper sticker (owner, Oct 31)');
  assert.deepEqual(position(spec('sticker'), spec('sticker').area[16362], {width: 1000, height: 1000}).height, Math.round(1125 * 0.92), 'art fits the bumper height');
});

test('artwork keeps its proportions inside the print area', () => {
  const art = {width: 1880, height: 1555};
  const chest = position(spec('crewneck'), [1800, 2400], art);
  assert.ok(chest.width <= 1800 * 0.8627 + 1 && chest.height <= 2400 * 0.75 + 1);
  assert.equal(chest.left, Math.round((1800 - chest.width) / 2));
  assert.equal(chest.top, Math.round(2400 * 0.1473), 'starts at the collar line like the shirts');
  assert.ok(Math.abs(chest.width / chest.height - 1880 / 1555) < 0.01);
  const hoodie = position(spec('hoodie'), [2100, 2100], art);
  assert.ok(hoodie.top + hoodie.height <= 2100 * 0.6714 + 1, 'clear of the pouch pocket');
  const sticker = position(spec('sticker'), [900, 900], art);
  assert.ok(sticker.width <= 900 && sticker.top > 0 && sticker.left >= 0);
  assert.equal(position(spec('tote'), [1500, 1500], {width: 0, height: 10}), null);
});

const detail = {sync_product: {id: 482794926, name: 'Skull Wave T'}, sync_variants: [
  {color: 'Maroon', files: [{type: 'default', id: 1035411289, width: 1880, height: 1555, status: 'ok'}, {type: 'preview', id: 9}]},
  {color: 'Black', files: [{type: 'default', id: 1035411289, width: 1880, height: 1555, status: 'ok'}]}]};

test('a Printful product per design and type, tagged with the design, using the design’s own file', () => {
  const design = designFromDetail(detail);
  assert.deepEqual(design, {id: '482794926', name: 'Skull Wave T', art: {id: 1035411289, width: 1880, height: 1555, thumb: null}, colors: ['Maroon', 'Black']});
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
    all: async sql => {
      if (/FROM catalog_products/.test(sql)) return products;
      const prefix = (sql.match(/LIKE '([^%']+)%'/) || [])[1] || 'expand:';
      const onlyValue = (sql.match(/AND value='([^']+)'/) || [])[1];
      return [...settings].filter(([k, v]) => k.startsWith(prefix) && (onlyValue === undefined || v === onlyValue)).map(([key, value]) => ({key, value}));
    },
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

test('each created product queues model photos with the placement the orders use (inches)', async () => {
  const {photoLayer} = await import('../src/expand.mjs');
  const design = designFromDetail(detail);
  const stickers = [10163, 10164, 10165].map(id => ({id, color: 'White', size: String(id), price: 2.5}));
  const sticker = photoLayer(spec('sticker'), design, buildProduct(spec('sticker'), design, stickers));
  assert.equal(sticker.catalog, 358); assert.equal(sticker.placement, 'default');
  assert.deepEqual(sticker.catalog_variant_ids, [10165], 'one photo, the 5.5in size');
  assert.ok(sticker.position_in.width <= 5.5 && sticker.position_in.width > 4.5);
  const hoodie = photoLayer(spec('hoodie'), design, buildProduct(spec('hoodie'), design, crewVariants));
  assert.equal(hoodie.catalog_variant_ids, null, 'one photo per color');
  assert.ok(hoodie.position_in.width <= 12.01 && Math.abs(hoodie.position_in.top - 1) < 0.01);
});

// Owner decision Oct 31: skip a garment color only when the whole design blends in, outline included.
import {summarize, blendsIn, decodePng} from '../src/artcolors.mjs';
import {deflateSync} from 'node:zlib';
function art(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(paint(x, y), (y * width + x) * 4);
  return {width, height, rgba};
}
const square = (fill, outline) => art(20, 20, (x, y) => {
  if (x < 3 || y < 3 || x > 16 || y > 16) return [0, 0, 0, 0];
  if (outline && (x < 5 || y < 5 || x > 14 || y > 14)) return [...outline, 255];
  return [...fill, 255];
});
const darkRed = [120, 30, 35], maroon = '#651d32';
const garments = [];
let gid = 100;
for (const [color, color_code] of [['Black', '#0b0b0b'], ['Navy', '#050c1d'], ['Maroon', maroon], ['Dark Heather', '#46484d'], ['White', '#ffffff']]) for (const size of ['S', 'M']) garments.push({id: gid++, color, color_code, size, price: 19.17, in_stock: true});

test('a garment color the whole design blends into is skipped', () => {
  const plain = summarize(square(darkRed));
  assert.equal(blendsIn(plain, maroon), true);
  assert.equal(blendsIn(plain, '#0b0b0b'), false);
  const colors = [...new Set(pickVariants(spec('hoodie'), garments, ['Maroon', 'Black', 'Navy'], plain).map(v => v.color))];
  assert.deepEqual(colors, ['Black', 'Navy', 'Dark Heather'], 'maroon skipped, the next dark color that shows the art fills in');
});

test('an outline that stands out keeps the color (Nino outlines designs on purpose)', () => {
  const outlined = summarize(square(darkRed, [250, 240, 220]));
  assert.equal(blendsIn(outlined, maroon), false);
  assert.deepEqual([...new Set(pickVariants(spec('hoodie'), garments, ['Maroon', 'Black'], outlined).map(v => v.color))], ['Black', 'Maroon']);
});

test('without a color summary nothing is skipped; totes switch to the color that shows the art', () => {
  assert.deepEqual([...new Set(pickVariants(spec('hoodie'), garments, ['Maroon', 'Black']).map(v => v.color))], ['Black', 'Maroon']);
  assert.equal(summarize(art(4, 4, () => [10, 10, 10, 255])), null, 'no transparency: no summary');
  const tote = [{id: 10457, color: 'Black', color_code: '#101010', size: 'One size', price: 15.87}, {id: 10458, color: 'Oyster', color_code: '#edcea5', size: 'One size', price: 15.87}];
  const black = summarize(square([16, 16, 16]));
  assert.deepEqual(pickVariants(spec('tote'), tote, ['Black'], black).map(v => v.color), ['Oyster']);
});

test('PNG thumbnails decode (RGBA, every filter type)', async () => {
  const w = 3, h = 5, rows = [];
  for (let y = 0; y < h; y++) { const row = [y]; for (let x = 0; x < w; x++) row.push(x * 40, y * 30, 7, 255); rows.push(...row); }
  // filters 0..4 with already-filtered bytes only for filter 0; the decoder must still accept every filter id
  const raw = Buffer.from(rows.map((v, i) => (i % (w * 4 + 1) === 0 ? 0 : v)));
  const chunk = (tag, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(tag, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const img = await decodePng(png);
  assert.equal(img.width, 3); assert.equal(img.height, 5);
  assert.deepEqual([...img.rgba.slice((4 * 3 + 2) * 4, (4 * 3 + 2) * 4 + 4)], [80, 120, 7, 255]);
  assert.equal(await decodePng(Buffer.from('not a png at all, definitely not 33 bytes long')), null);
});

test('listed sample designs are rebuilt in place with the new rules, and their photos are redone', async () => {
  const settings = new Map([['expand_designs', '482794926'], ['expand_rebuild', '482794926'],
    ['expand:482794926:sticker', '7001'], ['expand:482794926:tote', '7002'], ['expand:482794926:crewneck', '7003'], ['expand:482794926:hoodie', '7004']]);
  const puts = [], sqls = [];
  const store = fakeStore(settings, [{id: '482794926', external_id: '455', title: 'Skull Wave T'}]);
  const run = store.run; store.run = async (sql, ...args) => { sqls.push(sql); return run(sql, ...args); };
  const thumbDetail = structuredClone(detail);
  thumbDetail.sync_variants.forEach(v => { v.files[0].thumbnail_url = 'https://files.cdn.printful.com/files/abc/' + 'a'.repeat(32) + '_thumb.png'; });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'PUT') { puts.push([path, JSON.parse(init.body)]); return Response.json({code: 200, result: {}}); }
    if (path.endsWith('_thumb.png')) return new Response('not a png', {status: 200});
    if (path === '/store/products/482794926') return Response.json({code: 200, result: thumbDetail});
    if (path.startsWith('/products/')) return Response.json({code: 200, result: {variants: [
      ...crewVariants.map(v => ({...v, availability_status: [{region: 'US', status: 'in_stock'}]})),
      ...[10163, 10164, 10165, 16362].map(id => ({id, color: 'White', size: String(id), price: '2.34', availability_status: [{region: 'US', status: 'in_stock'}]})),
      {id: 10457, color: 'Black', color_code: '#101010', size: 'One size', price: '15.87', availability_status: [{region: 'US', status: 'in_stock'}]}]}});
    return new Response('{}', {status: 404});
  };
  const env = {PRINTFUL_ACCESS_TOKEN: 'k', PRINTFUL_STORE_ID: '1'};
  const first = await runExpansion(store, env, 1000, {fetcher});
  assert.deepEqual(first.created, ['Skull Wave Sticker (rebuilt)', 'Skull Wave Tote bag (rebuilt)'], 'two per run; the color summary is made once, on the first garment');
  assert.equal(settings.get('expand_art:482794926'), 'none', 'an unreadable thumbnail means no color filtering, recorded once');
  assert.deepEqual(puts[0][0], '/store/products/7001');
  assert.ok(puts[0][1].sync_variants.some(v => v.variant_id === 16362), 'bumper size added');
  assert.ok(sqls.some(sql => /INSERT INTO mockup_jobs.*ON CONFLICT\(product_id\) DO UPDATE SET layer_json/.test(sql)), 'photo redone');
  for (let t = 1001; t < 1003; t++) await runExpansion(store, env, t, {fetcher});
  assert.deepEqual(puts.map(p => p[0]), ['/store/products/7001', '/store/products/7002', '/store/products/7003', '/store/products/7004']);
  assert.ok(puts[3][1].sync_variants.some(v => crewVariants.find(c => c.id === v.variant_id)?.size === '5XL'), 'hoodie up to 5XL');
  assert.equal(settings.get('expand_v:482794926:hoodie'), '2');
  assert.deepEqual((await runExpansion(store, env, 1010, {fetcher})).created, [], 'each product rebuilt once');
});

test('aprons are made only for designs their gate lists, with every strap color, taxed as goods', async () => {
  const settings = new Map([['expand_designs', 'all'], ['expand_gate:apron', '482794926'],
    ...['sticker', 'tote', 'crewneck', 'hoodie'].map(t => [`expand:482794926:${t}`, '1']), ...['sticker', 'tote', 'crewneck', 'hoodie'].map(t => [`expand:999:${t}`, '1'])]);
  const posts = [];
  const apronVariants = [23723, 23724, 23725, 23726, 23727].map((id, i) => ({id, color: ['Black', 'White', 'Beige', 'Blue', 'Pink'][i], size: 'One size', price: '23.34', availability_status: [{region: 'US', status: 'in_stock'}]}));
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({code: 200, result: {id: 8000 + posts.length}}); }
    if (path.startsWith('/store/products/')) return Response.json({code: 200, result: detail});
    if (path === '/products/927') return Response.json({code: 200, result: {variants: apronVariants}});
    return new Response('{}', {status: 404});
  };
  const store = fakeStore(settings, [{id: '482794926', external_id: '455', title: 'Skull Wave T'}, {id: '999', external_id: '777', title: 'Other T'}]);
  const out = await runExpansion(store, {PRINTFUL_ACCESS_TOKEN: 'k', PRINTFUL_STORE_ID: '1'}, 1000, {fetcher});
  assert.deepEqual(out.created, ['Skull Wave Apron']);
  assert.equal(out.remaining, 0, 'the other design gets no apron while the gate lists only the sample');
  assert.deepEqual(posts[0].sync_variants.map(v => v.retail_price), Array(5).fill('36.00'), 'cost x 1.5 rounded up');
  const pos = posts[0].sync_variants[0].files[0].position;
  assert.ok(pos.top >= 4961 * 0.29 && pos.width <= 4075 * 0.43, 'on the bib and chest');
  assert.equal(lineTaxCode({kind: 'apron'}, {product_tax_code: 'txcd_30011000'}), 'txcd_99999999');
});

test('hats: only gated designs, threads from the design colors, hat colors that show it, $23, orders carry the threads', async () => {
  const {threadsFor} = await import('../src/expand.mjs');
  const {placedItems} = await import('../src/fulfillment.mjs');
  const green = summarize(square([1, 120, 78], [250, 250, 250]));
  assert.deepEqual(threadsFor(green), ['#01784E', '#FFFFFF']);
  assert.deepEqual(threadsFor(null), []);
  const hatVariants = [[7854, 'Black', '#181717'], [7855, 'Khaki', '#b49771'], [7857, 'Navy', '#182031'], [7853, 'White', '#ffffff'], [7859, 'Stone', '#d6bdad'], [12736, 'Dark Grey', '#39353a'], [7858, 'Pink', '#fab2ba']]
    .map(([id, color, color_code]) => ({id, color, color_code, size: 'One size', price: 14.94, in_stock: true}));
  assert.deepEqual(pickVariants(spec('hat'), hatVariants, [], green).map(v => v.color), ['Black', 'Khaki', 'Navy']);
  const whiteArt = summarize(square([250, 250, 250]));
  assert.ok(!pickVariants(spec('hat'), hatVariants, [], whiteArt).some(v => v.color === 'White'), 'a white design gets no white hat');
  const payload = buildProduct(spec('hat'), {id: '1', name: 'Grumpy Frog  T', art: {id: 9, width: 2000, height: 1000}, palette: green}, hatVariants);
  assert.equal(payload.sync_product.name, 'Grumpy Frog Dad hat');
  assert.equal(payload.sync_product.external_id, 'nx-hat-1');
  const v = payload.sync_variants[0];
  assert.equal(v.retail_price, '23.00');
  assert.deepEqual(v.options, [{id: 'thread_colors', value: ['#01784E', '#FFFFFF']}, {id: 'embroidery_type', value: 'flat'}]);
  assert.deepEqual(v.files[0], {type: 'embroidery_front', id: 9, position: {area_width: 1200, area_height: 525, width: 1050, height: 525, top: 0, left: 75, limit_to_print_area: true}});
  assert.equal(buildProduct(spec('hat'), {id: '1', name: 'X', art: {id: 9, width: 10, height: 10}, palette: null}, hatVariants), null, 'no colors known: no hat');
  assert.equal(lineTaxCode({kind: 'hat'}, {product_tax_code: 'txcd_30011000'}), 'txcd_99999999');
  const rows = new Map([['expand:1:hat', '5555'], ['expand_art:1', JSON.stringify(green)]]);
  const store = {first: async (sql, ...a) => sql.includes("LIKE 'expand:%'") ? ([...rows].find(([k, val]) => k.startsWith('expand:') && val === a[0]) ? {key: [...rows].find(([k, val]) => k.startsWith('expand:') && val === a[0])[0]} : null) : (sql.includes('free_sticker') ? {value: 'off'} : (rows.has(a[0]) ? {value: rows.get(a[0])} : null))};
  const items = await placedItems({lines: [{kind: 'hat', product_id: '5555', quantity: 1, unit_price_cents: 2300, title: 'Grumpy Frog Dad hat', variant: {catalog_variant_id: 7854, files: [{type: 'default', id: 9}]}}]}, store, {getFile: async () => ({width: 2000, height: 1000})});
  assert.deepEqual(items[0].options, [{id: 'thread_colors', value: ['#01784E', '#FFFFFF']}, {id: 'embroidery_type', value: 'flat'}]);
  assert.equal(items[0].files[0].position.area_width, 1200);
});
