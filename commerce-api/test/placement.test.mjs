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

test('other products use their own print area: a 4in sticker, a tote, a hoodie clear of the pocket', async () => {
  const items = await placedItems({lines: [line('sticker', 10164), line('tote', 10457), line('hoodie', 5530)]}, store(null), printful);
  assert.equal(items[0].files[0].position.area_width, 1200);
  assert.equal(items[1].files[0].position.area_width, 1500);
  assert.ok(items[1].files[0].position.width >= 1500 * 0.79);
  const h = items[2].files[0].position;
  assert.equal(h.area_width, 2100);
  assert.ok(h.top + h.height <= 2100 * 0.6714 + 1);
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
