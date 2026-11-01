// Marketing plan v2 item 3: the Pinterest / Google Merchant product feed (scripts/product-feed.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {feedItems, feedXml, landingPage, previousShipping, countItems, quoteShipping, run, decode, typeOf} from '../scripts/product-feed.mjs';

const curated = [
  {id: '455597876', title: 'Skull Wave', slug: 'skull-wave', description: "Nino's original artwork: a blue ocean wave curling into a skull."},
  {id: '999', title: 'Brand Thing', slug: 'brand-thing', description: 'Built on a brand.'}
];
const config = {designs: ['455597876'], hold_types: ['apron']};
const v = (id, color, size, amount, extra = {}) => ({id, color, size, price: {amount, currency: 'USD'}, available: true, image: `https://api.example/api/mockups/x/${id}.jpg`, ...extra});
const live = (over = {}) => ({catalog_ready: true, catalog_complete: true, products: [
  {id: '482794926', external_id: '455597876', title: 'Skull Wave T', image: null, variants: [v(1, 'Black', 'M', 2500), v(2, 'Black', '2XL', 2700), v(3, 'Navy', 'M', 2500, {available: false})]},
  {id: '487799809', external_id: 'nx-hoodie-482794926', title: 'Skull Wave Hoodie', variants: [v(10, 'Black', 'L', 4500)]},
  {id: '487798971', external_id: 'nx-sticker-482794926', title: 'Skull Wave Sticker', variants: [v(20, null, '3″×3″', 400)]},
  {id: '487894999', external_id: 'nx-apron-482794926', title: 'Skull Wave Apron', variants: [v(30, 'Black', null, 3600)]},
  {id: '482799999', external_id: '999', title: 'Brand Thing T', variants: [v(40, 'Black', 'M', 2500)]},
  {id: '487000001', external_id: 'nx-hoodie-482799999', title: 'Brand Thing Hoodie', variants: [v(41, 'Black', 'M', 4500)]}
], ...over});

test('only reviewed original designs, on every product type except held ones, available variants only', () => {
  const items = feedItems(live(), curated, config);
  assert.deepEqual(items.map(i => i.id).sort(), ['nino-1', 'nino-10', 'nino-2', 'nino-20']);
  assert.ok(items.every(i => i.record.id === '455597876'));
  assert.equal(items.find(i => i.id === 'nino-10').type, 'hoodie');
  assert.equal(items.find(i => i.id === 'nino-10').group, 'nino-487799809');
});

test('item type comes from the expansion external id', () => {
  assert.deepEqual(typeOf({id: '5', external_id: 'nx-tote-77'}), {type: 'tote', design: '77'});
  assert.deepEqual(typeOf({id: '5', external_id: '455'}), {type: 'tshirt', design: '5'});
});

test('landing pages: shirts on their own page, other products open on the shop with that product chosen', () => {
  const items = feedItems(live(), curated, config);
  assert.equal(landingPage(items.find(i => i.type === 'tshirt'), 'google'), 'https://ninobattaglia.com/shirts/skull-wave.html?utm_source=google&utm_medium=shopping_feed');
  assert.equal(landingPage(items.find(i => i.type === 'hoodie'), 'pinterest'), 'https://ninobattaglia.com/shop.html?product=455597876&item=hoodie&utm_source=pinterest&utm_medium=product_pin');
});

test('feed XML carries the required Google / Pinterest fields', () => {
  const items = feedItems(live(), curated, config);
  const text = feedXml(items, 'google', {tshirt: 495, hoodie: 849});
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0" xmlns:g="http:\/\/base.google.com\/ns\/1.0">/);
  assert.equal(countItems(text), 4);
  const shirt = text.split('\n').find(line => line.includes('<g:id>nino-2</g:id>'));
  for (const part of ['<title>Skull Wave T-Shirt – Original Art by Nino Battaglia</title>', '<g:price>27.00 USD</g:price>', '<g:availability>in_stock</g:availability>',
    '<g:brand>Nino Battaglia</g:brand>', '<g:condition>new</g:condition>', '<g:identifier_exists>no</g:identifier_exists>', '<g:item_group_id>nino-482794926</g:item_group_id>',
    '<g:color>Black</g:color>', '<g:size>2XL</g:size>', '<g:gender>unisex</g:gender>', '<g:age_group>adult</g:age_group>',
    '<g:shipping><g:country>US</g:country><g:service>Standard</g:service><g:price>4.95 USD</g:price></g:shipping>']) assert.ok(shirt.includes(part), part);
  assert.ok(shirt.includes('Nino&#39;s') || shirt.includes("Nino's"));
  const sticker = text.split('\n').find(line => line.includes('<g:id>nino-20</g:id>'));
  assert.ok(!sticker.includes('<g:gender>'), 'no apparel fields on stickers');
  assert.ok(!sticker.includes('<g:shipping>'), 'no rate known for stickers');
  assert.ok(sticker.includes('<g:size>3″×3″</g:size>'));
});

test('text is decoded from the shop and escaped for XML', () => {
  assert.equal(decode('All Hallow&#39;s Eve &amp; more'), "All Hallow's Eve & more");
  const items = feedItems(live(), [{...curated[0], title: 'Fish & <Chips>'}], config);
  const text = feedXml(items, 'google', {});
  assert.ok(text.includes('<title>Fish &amp; &lt;Chips&gt; T-Shirt'));
});

test('previous shipping rates are read back from an earlier feed', () => {
  const items = feedItems(live(), curated, config);
  assert.deepEqual(previousShipping(feedXml(items, 'google', {tshirt: 495, hoodie: 849})), {tshirt: 495, hoodie: 849});
});

test('shipping: one quote per product type, STANDARD rate; a failed quote keeps the previous rate', async () => {
  const items = feedItems(live(), curated, config);
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.headers.Origin, 'https://ninobattaglia.com');
    assert.equal(body.recipient.country_code, 'US');
    if (body.items[0].variant_id === '20') return new Response('{}', {status: 502});
    return Response.json({rates: [{id: 'STANDARD_CARBON_OFFSET', amount: 504}, {id: 'STANDARD', amount: body.items[0].variant_id === '10' ? 849 : 495}]});
  };
  const rates = await quoteShipping(items, fetcher, 'https://api.example', {sticker: 469});
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].items, [{product_id: '482794926', variant_id: '1', quantity: 1}]);
  assert.deepEqual(rates, {tshirt: 495, hoodie: 849, sticker: 469});
});

async function site(previous) {
  const root = await mkdtemp(path.join(tmpdir(), 'feed-'));
  await mkdir(path.join(root, 'commerce-api/scripts'), {recursive: true});
  await writeFile(path.join(root, 'commerce-api/scripts/feed-designs.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify({products: curated}));
  if (previous) await writeFile(path.join(root, 'feed-google.xml'), previous);
  return root;
}
const apiFetcher = body => async (url) => url.endsWith('/api/products') ? Response.json(body) : Response.json({rates: [{id: 'STANDARD', amount: 495}]});

test('run writes both feeds with channel-tagged links', async () => {
  const root = await site();
  const result = await run({root, api: 'https://api.example', fetcher: apiFetcher(live())});
  assert.equal(result.written, true); assert.equal(result.items, 4); assert.equal(result.designs, 1);
  const google = await readFile(path.join(root, 'feed-google.xml'), 'utf8');
  const pinterest = await readFile(path.join(root, 'feed-pinterest.xml'), 'utf8');
  assert.ok(google.includes('utm_source=google') && !google.includes('utm_source=pinterest'));
  assert.ok(pinterest.includes('utm_source=pinterest'));
  assert.equal(countItems(pinterest), 4);
});

test('run leaves the feed alone when the catalog is not current', async () => {
  const root = await site('<item>old</item>');
  const result = await run({root, api: 'https://api.example', fetcher: apiFetcher(live({catalog_ready: false}))});
  assert.equal(result.written, false);
  assert.equal(await readFile(path.join(root, 'feed-google.xml'), 'utf8'), '<item>old</item>');
});

test('run refuses to shrink the feed by more than half', async () => {
  const root = await site('<item>a</item>'.repeat(20));
  await assert.rejects(run({root, api: 'https://api.example', fetcher: apiFetcher(live())}), /refusing to write: 4 items \(previous feed had 20\)/);
});

test('the reviewed design list names real curated designs', async () => {
  const listed = JSON.parse(await readFile(new URL('../scripts/feed-designs.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url), 'utf8'));
  const ids = new Set(catalog.products.map(p => p.id));
  assert.equal(listed.designs.length, 20);
  for (const id of listed.designs) assert.ok(ids.has(id), id);
  assert.deepEqual(listed.hold_types, ['apron', 'hat']);
});
