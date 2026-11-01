// Product feeds for Pinterest (catalog → product pins) and Google Merchant Center (free Shopping listings).
// Marketing plan v2, item 3 (Nov 1, 2026). Run daily by .github/workflows/product-feed.yml, which commits the files
// to the site root: https://ninobattaglia.com/feed-google.xml and https://ninobattaglia.com/feed-pinterest.xml.
//
// - Reads only the public product list (GET /api/products, served from the stored snapshot: no extra D1 load).
// - Only the reviewed original designs in feed-designs.json, on every product made for them (shirt, hoodie,
//   crewneck, tote, sticker, ...), minus hold_types. Designs built on brands or characters never enter the feed.
// - One item per color and size, grouped by product (item_group_id), with the shop's own price and photo.
// - Shipping: the shop's real Printful rate to a U.S. address, asked once per product type (POST /api/shipping-quotes,
//   which only quotes: no order, no payment). If a quote fails, the rate in the previous feed is kept.
// - Refuses to write when the catalog isn't current, or when the item count falls by more than half (a broken
//   sync must not empty the listings).
//   node scripts/product-feed.mjs [outDir]       (API_BASE overrides the API address)
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const API = 'https://nino-printful-commerce-api.ijpbattaglia.workers.dev';
export const SITE = 'https://ninobattaglia.com';
export const CHANNELS = Object.freeze({
  google: {file: 'feed-google.xml', utm: 'utm_source=google&utm_medium=shopping_feed'},
  pinterest: {file: 'feed-pinterest.xml', utm: 'utm_source=pinterest&utm_medium=product_pin'}
});
export const TYPES = Object.freeze({
  tshirt: {label: 'T-Shirt', noun: 'a unisex tee', productType: 'Apparel > T-shirts', apparel: true},
  hoodie: {label: 'Hoodie', noun: 'a unisex pullover hoodie', productType: 'Apparel > Hoodies', apparel: true},
  crewneck: {label: 'Crewneck Sweatshirt', noun: 'a unisex crewneck sweatshirt', productType: 'Apparel > Sweatshirts', apparel: true},
  tote: {label: 'Tote Bag', noun: 'a tote bag', productType: 'Bags > Tote bags', apparel: false},
  sticker: {label: 'Sticker', noun: 'a vinyl sticker', productType: 'Stickers', apparel: false},
  apron: {label: 'Apron', noun: 'an apron with your pick of strap color', productType: 'Kitchen > Aprons', apparel: true},
  hat: {label: 'Dad Hat', noun: 'an embroidered dad hat', productType: 'Apparel > Hats', apparel: true}
});
// A real U.S. address for shipping quotes (San Francisco City Hall); quotes never create orders.
export const QUOTE_ADDRESS = Object.freeze({name: 'Shipping estimate', address1: '1 Dr Carlton B Goodlett Pl', city: 'San Francisco', state_code: 'CA', country_code: 'US', zip: '94102'});

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'"};
export const decode = text => String(text ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m));
export const xml = text => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const money = cents => `${(cents / 100).toFixed(2)} USD`;
const httpsUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };

// The type and design of a live product: "nx-<type>-<design live id>" for the extra products, else a shirt.
export function typeOf(product) {
  const match = /^nx-([a-z]+)-(\d+)$/.exec(String(product.external_id || ''));
  return match ? {type: match[1], design: match[2]} : {type: 'tshirt', design: String(product.id)};
}

// curated: catalog.json products; config: feed-designs.json; live: the /api/products body.
// Returns [{group, type, design, variant fields...}], sorted, for the reviewed designs only.
export function feedItems(live, curated, config) {
  const allowed = new Set(config.designs.map(String));
  const hold = new Set(config.hold_types || []);
  const byCurated = new Map(curated.map(p => [String(p.id), p]));
  // Live shirt id -> curated record (the live shirt's external_id is the curated id, or the ids are equal).
  const designs = new Map();
  for (const product of live.products || []) {
    if (typeOf(product).type !== 'tshirt') continue;
    const record = byCurated.get(String(product.external_id ?? '')) || byCurated.get(String(product.id));
    if (record && allowed.has(String(record.id))) designs.set(String(product.id), record);
  }
  const items = [];
  for (const product of live.products || []) {
    const {type, design} = typeOf(product);
    const record = designs.get(design);
    if (!record || !TYPES[type] || hold.has(type)) continue;
    for (const variant of product.variants || []) {
      const image = httpsUrl(variant.image) || httpsUrl(product.image);
      if (!variant.available || !image || !Number.isInteger(variant.price?.amount) || String(variant.price.currency).toUpperCase() !== 'USD') continue;
      items.push({id: `nino-${variant.id}`, group: `nino-${product.id}`, productId: String(product.id), type, record, image,
        color: decode(variant.color || ''), size: decode(variant.size || ''), cents: variant.price.amount});
    }
  }
  return items.sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}

export function landingPage(item, channel) {
  const utm = CHANNELS[channel].utm;
  if (item.type === 'tshirt') return `${SITE}/shirts/${item.record.slug}.html?${utm}`;
  return `${SITE}/shop.html?product=${item.record.id}&item=${item.type}&${utm}`;
}

export function itemXml(item, channel, shipping) {
  const kind = TYPES[item.type];
  const name = decode(item.record.title);
  const title = `${name} ${kind.label} – Original Art by Nino Battaglia`.slice(0, 150);
  const about = decode(item.record.description || '').replace(/\s+/g, ' ').trim();
  const description = `${about ? about + ' ' : ''}Original artwork by San Francisco artist Nino Battaglia on ${kind.noun}, printed to order.`.slice(0, 5000);
  const lines = [
    ['g:id', item.id], ['title', title], ['description', description], ['link', landingPage(item, channel)],
    ['g:image_link', item.image], ['g:availability', 'in_stock'], ['g:price', money(item.cents)],
    ['g:brand', 'Nino Battaglia'], ['g:condition', 'new'], ['g:identifier_exists', 'no'],
    ['g:item_group_id', item.group], ['g:product_type', kind.productType]
  ];
  if (item.color) lines.push(['g:color', item.color]);
  if (item.size) lines.push(['g:size', item.size]);
  if (kind.apparel) lines.push(['g:gender', 'unisex'], ['g:age_group', 'adult']);
  let out = '<item>' + lines.map(([tag, value]) => `<${tag}>${xml(value)}</${tag}>`).join('');
  if (Number.isInteger(shipping[item.type])) out += `<g:shipping><g:country>US</g:country><g:service>Standard</g:service><g:price>${money(shipping[item.type])}</g:price></g:shipping>`;
  return out + '</item>';
}

export function feedXml(items, channel, shipping) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>'
    + '<title>Nino Battaglia original art shop</title><link>https://ninobattaglia.com/shop.html</link>'
    + '<description>Original designs by San Francisco artist Nino Battaglia on shirts, sweatshirts, totes and stickers.</description>\n'
    + items.map(item => itemXml(item, channel, shipping)).join('\n') + '\n</channel></rss>\n';
}

// Shipping rates kept from a previous feed: {type: cents}, read from its items' product_type and shipping price.
export function previousShipping(text) {
  const out = {};
  for (const block of String(text || '').split('<item>').slice(1)) {
    const type = Object.keys(TYPES).find(key => block.includes(`<g:product_type>${xml(TYPES[key].productType)}</g:product_type>`));
    const price = /<g:shipping>.*?<g:price>(\d+)\.(\d{2}) USD<\/g:price>/.exec(block);
    if (type && price && !(type in out)) out[type] = Number(price[1]) * 100 + Number(price[2]);
  }
  return out;
}

export const countItems = text => (String(text || '').match(/<item>/g) || []).length;

// The STANDARD rate for one item of each type, from the shop's own quote endpoint.
export async function quoteShipping(items, fetcher, api = API, kept = {}) {
  const out = {...kept};
  const firstOfType = new Map();
  for (const item of items) if (!firstOfType.has(item.type)) firstOfType.set(item.type, item);
  for (const [type, item] of firstOfType) {
    try {
      const response = await fetcher(`${api}/api/shipping-quotes`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: SITE},
        body: JSON.stringify({items: [{product_id: item.productId, variant_id: item.id.slice(5), quantity: 1}], recipient: QUOTE_ADDRESS})});
      if (!response.ok) throw new Error(`quote ${response.status}`);
      const rates = (await response.json()).rates || [];
      const standard = rates.find(rate => rate.id === 'STANDARD') || rates[0];
      if (Number.isInteger(standard?.amount)) out[type] = standard.amount;
    } catch (error) { console.warn(`shipping quote for ${type} failed (${error.message}); ${type in kept ? 'keeping the previous rate' : 'no rate'}`); }
  }
  return out;
}

export async function run({outDir, api = API, fetcher = fetch, root} = {}) {
  root ||= path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  outDir ||= root;
  const config = JSON.parse(await readFile(path.join(root, 'commerce-api/scripts/feed-designs.json'), 'utf8'));
  const curated = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8')).products;
  const response = await fetcher(`${api}/api/products`, {headers: {Accept: 'application/json'}});
  if (!response.ok) throw new Error(`product list answered ${response.status}`);
  const live = await response.json();
  if (!live.catalog_ready || !live.catalog_complete) return {written: false, reason: 'catalog_not_current'};
  const items = feedItems(live, curated, config);
  const previous = await readFile(path.join(outDir, CHANNELS.google.file), 'utf8').catch(() => '');
  const before = countItems(previous);
  if (!items.length || (before && items.length < before / 2)) throw new Error(`refusing to write: ${items.length} items (previous feed had ${before})`);
  const shipping = await quoteShipping(items, fetcher, api, previousShipping(previous));
  for (const [channel, {file}] of Object.entries(CHANNELS)) await writeFile(path.join(outDir, file), feedXml(items, channel, shipping));
  const designs = new Set(items.map(item => item.record.id)).size;
  const types = [...new Set(items.map(item => item.type))];
  return {written: true, items: items.length, designs, types, shipping};
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run({outDir: process.argv[2] ? path.resolve(process.argv[2]) : undefined, api: process.env.API_BASE || API})
    .then(result => { console.log(JSON.stringify(result)); if (!result.written) console.log('Feed left unchanged.'); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
