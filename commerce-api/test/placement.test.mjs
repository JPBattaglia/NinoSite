// Oct 31, 2026: Printful ignores placement stored on products; orders carry it explicitly.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {placedItems} from '../src/fulfillment.mjs';

const store = layer => ({first: async () => layer ? {layer_json: JSON.stringify(layer)} : null});
const printful = {getFile: async id => ({id, width: 1880, height: 1555})};
const line = (kind, catalog, extra = {}) => ({product_id: '482794926', variant_id: '5581063392', quantity: 2, unit_price_cents: 2500, title: 'Skull Wave T', kind,
  variant: {catalog_variant_id: catalog, files: [{type: 'default', id: 1035411289, hash: 'af62'}]}, ...extra});

test('a shirt line is sent as its catalog variant with the artwork and the model photos’ placement', async () => {
  const [item] = await placedItems({lines: [line(undefined, 12634)]}, store({width: 10.352, height: 8.563, top: 2.356, left: 0.824}), printful);
  assert.equal(item.variant_id, 12634);
  assert.equal(item.sync_variant_id, undefined, 'not the stored product, which loses placement');
  assert.equal(item.external_id, 'item_1');
  assert.equal(item.retail_price, '25.00');
  assert.deepEqual(item.files, [{type: 'default', id: 1035411289, position: {area_width: 1800, area_height: 2400, width: 1553, height: 1284, top: 353, left: 124, limit_to_print_area: true}}]);
});

test('without a mockup layer the shirt gets the standard placement: about 10.35in wide, from the collar line', async () => {
  const [item] = await placedItems({lines: [line('tshirt', 12634)]}, store(null), printful);
  const p = item.files[0].position;
  assert.equal(p.width, Math.round(1800 * 0.8627));
  assert.equal(p.top, Math.round(2400 * 0.1473));
  assert.ok(p.width > 1500, 'not the file’s own 5in size');
});

test('other products use their own print area: a 4in sticker, a tote, a hoodie at the size of the shirt', async () => {
  const items = await placedItems({lines: [line('sticker', 10164), line('tote', 10457), line('hoodie', 5530)]}, store(null), printful);
  assert.equal(items[0].files[0].position.area_width, 1200);
  assert.equal(items[1].files[0].position.area_width, 1500);
  assert.ok(items[1].files[0].position.width >= 1500 * 0.79);
  const h = items[2].files[0].position;
  assert.equal(h.area_width, 2100);
  assert.equal(h.width, Math.round(1800 * 0.8627), 'the hoodie prints as wide as the shirt: 10.35in');
  assert.ok(h.top + h.height <= 2100);
  assert.deepEqual(items.map(i => i.external_id), ['item_1', 'item_2', 'item_3', 'gift_sticker']);
});

test('every site order gets one free 3in sticker of its first design, at $0, unless switched off', async () => {
  const items = await placedItems({lines: [line('tshirt', 12634), line('hoodie', 5530)]}, store(null), printful);
  const gift = items.at(-1);
  assert.deepEqual({id: gift.external_id, variant: gift.variant_id, qty: gift.quantity, price: gift.retail_price, name: gift.name},
    {id: 'gift_sticker', variant: 10163, qty: 1, price: '0.00', name: 'Free sticker: Skull Wave'});
  assert.equal(gift.files[0].id, 1035411289, 'the order\u2019s first design');
  assert.equal(gift.files[0].position.area_width, 900);
  const off = {first: async sql => /free_sticker/.test(sql) ? {value: 'off'} : null};
  const without = await placedItems({lines: [line('tshirt', 12634)]}, off, printful);
  assert.deepEqual(without.map(i => i.external_id), ['item_1'], 'free_sticker = off: no gift');
});

// Owner, Nov 3, 2026: the free sticker must work for every design and every future design.
const settingsStore = (rows, variants = {}) => ({
  first: async (sql, ...a) => {
    if (/free_sticker/.test(sql)) return null;
    if (/LIKE 'expand:%' AND value=\?/.test(sql)) { const k = Object.keys(rows).find(k => k.startsWith('expand:') && rows[k] === a[0]); return k ? {key: k} : null; }
    if (/FROM catalog_variants/.test(sql)) return variants[a[0]] ? {snapshot_json: JSON.stringify(variants[a[0]])} : null;
    if (/WHERE key=\?/.test(sql)) return a[0] in rows ? {value: rows[a[0]]} : null;
    return null;
  }});
const mugLine = {product_id: '900', variant_id: '1', quantity: 1, unit_price_cents: 1500, title: 'Skull Wave Mug', kind: 'mug',
  variant: {catalog_variant_id: 1320, files: [{type: 'default', id: 555, hash: 'wrap'}]}};

test('free sticker: the design\u2019s one-piece sticker artwork is used, whatever product comes first', async () => {
  const store = settingsStore({'expand:482794926:mug': '900', 'sticker_file:482794926': JSON.stringify({id: 777, w: 1000, h: 800})});
  const gift = (await placedItems({lines: [mugLine]}, store, printful)).at(-1);
  assert.equal(gift.external_id, 'gift_sticker');
  assert.equal(gift.files[0].id, 777, 'one-piece sticker art, not the mug wrap');
});

test('free sticker: a brand-new design without sticker art uses its shirt artwork, never a mug wrap or hat embroidery', async () => {
  const store = settingsStore({'expand:482794926:mug': '900'}, {'482794926': {files: [{type: 'default', id: 1035411289}]}});
  const gift = (await placedItems({lines: [mugLine]}, store, printful)).at(-1);
  assert.equal(gift.files[0].id, 1035411289, 'the design\u2019s shirt file');
  assert.notEqual(gift.files[0].id, 555);
});

test('free sticker: when no artwork can be found the order goes to review instead of shipping without it', async () => {
  const store = settingsStore({});
  await assert.rejects(placedItems({lines: [mugLine]}, store, printful), e => e.status === 409 && e.code === 'free_sticker_art_missing');
});
