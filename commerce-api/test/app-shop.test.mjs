// Nino's Mobile App buying inside the app (src/app-shop.mjs): one design's choices, and the app's access to checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {designOptions} from '../src/app-shop.mjs';

const APP = 'capacitor://localhost';
async function seed(f) {
  const add = async (id, externalId, title, variants) => {
    await f.store.run("INSERT INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES('initial',?,?,?,?,1)", id, externalId, title, 'https://example.com/p.png');
    for (const [vid, color, size, price] of variants) {
      await f.store.run("INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES('initial',?,?,?,'usd',?)", vid, id, price, JSON.stringify({id: vid, color, size, image: `https://example.com/${vid}.png`}));
    }
  };
  await add('201', 'nx-hoodie-101', 'Fixture graphic shirt Hoodie', [['601', 'Navy', 'XL', 4500], ['602', 'Navy', 'S', 4500], ['603', 'Black', '2XL', 4700]]);
  await add('202', 'nx-mug-101', 'Fixture graphic shirt Mug', [['611', '', '11 oz', 1000]]);
  await add('203', 'nx-mugblack-101', 'Fixture graphic shirt Mug', [['621', '', '11 oz', 1300]]);
  await add('204', 'nx-hoodie-999', 'Another design Hoodie', [['631', 'Navy', 'M', 4500]]);
  await f.store.run("INSERT INTO mockup_jobs(product_id,layer_json,status,colors_json,created_at,updated_at) VALUES('101','{}','done','[\"Black\"]',1,1)").catch(() => {});
}

test('one design comes back with its products, colors, sizes and prices', async () => {
  const f = await fixture(); await seed(f);
  const colors = async () => ({ok: true, json: async () => ({})});
  const d = await designOptions(f.store, f.env, f.now(), 'https://api.example.com', '101', colors);
  assert.equal(d.title, 'Fixture graphic shirt');
  assert.deepEqual(d.options.map(o => o.type), ['tshirt', 'hoodie', 'mug']);
  const hoodie = d.options[1];
  assert.deepEqual(hoodie.sizes, ['S', 'XL', '2XL'], 'sizes in wearing order');
  assert.deepEqual(hoodie.colors.map(c => c.name), ['Navy', 'Black']);
  assert.equal(hoodie.from_cents, 4500);
  assert.ok(hoodie.variants.every(v => v.product_id === '201'), 'another design\'s hoodie is not mixed in');
  const mug = d.options[2];
  assert.deepEqual(mug.colors.map(c => c.name), ['Black', 'White'], 'black mug first unless the design reads better on white');
  assert.deepEqual(mug.variants.map(v => [v.id, v.product_id, v.color]), [['621', '203', 'Black'], ['611', '202', 'White']], 'each mug keeps its own product for the cart');
  const white = await designOptions(f.store, f.env, f.now(), 'https://api.example.com', '101', async () => ({ok: true, json: async () => ({101: 'white'})}));
  assert.deepEqual(white.options[2].colors.map(c => c.name), ['White', 'Black']);
});

test('the route is public and says so when a design is not in the shop', async () => {
  const f = await fixture(); await seed(f);
  const get = path => f.app.fetch(new Request(`https://api.example.com${path}`, {headers: {Origin: APP}}), f.env);
  const ok = await get('/api/app/design/101');
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await ok.json()).options[0].variants[0].id, '501');
  const missing = await get('/api/app/design/424242');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error, 'design_not_found');
  assert.equal((await get('/api/app/design/201')).status, 404, 'an extra product is not a design');
});

test('the app can check out: its origin is let in and Stripe returns to the app pages', async () => {
  const f = await fixture();
  const post = (origin) => f.app.fetch(new Request('https://api.example.com/api/checkout', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({items: f.items, request_id: crypto.randomUUID(), app_member: 'k'.repeat(40)})}), f.env);
  const response = await post(APP);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), APP);
  const body = await response.json();
  assert.match(body.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
  const session = [...f.stripe.sessions.values()][0];
  assert.equal(session.params.success_url, 'https://shop.example.com/app-order-thanks.html');
  assert.equal(session.params.cancel_url, 'https://shop.example.com/app-order-back.html');
  const receipt = await f.app.fetch(new Request(`https://api.example.com/api/orders/${body.order_id}?token=${body.receipt_token}`, {headers: {Origin: APP}}), f.env);
  assert.equal(receipt.status, 200); assert.equal(receipt.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal((await post('https://untrusted.example')).status, 403);
  const web = await post('https://shop.example.com');
  assert.equal(web.status, 200);
  assert.match([...f.stripe.sessions.values()][1].params.success_url, /shop\.html\?checkout=success/);
  const preflight = await f.app.fetch(new Request('https://api.example.com/api/checkout', {method: 'OPTIONS', headers: {Origin: APP}}), f.env);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), APP);
});
