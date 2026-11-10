// Nino's Mobile App: buying inside the app (owner, Nov 10, 2026: "when you tap a color nothing happens ... the cart is
// only on the site so buyers have to go back and forth"). The app now picks the product, color and size on its own
// screen, keeps its own cart, asks this shop for delivery prices and opens only Stripe's payment page in its browser.
//
//   GET /api/app/design/<design id>   one design's choices: T-shirt first, then the same design on the other products
//                                     (hoodie, crewneck, tote, mug, hat, sticker), each with its colors, sizes,
//                                     variants, prices and pictures. Public, like /api/products, but one design only
//                                     (the full catalog is far too big for a phone to load per tap).
//
// The app then uses the shop's own /api/shipping-quotes, /api/checkout and /api/orders/<id> (worker.mjs lets the
// app's origins in). Prices here are for display: checkout re-reads every variant, as it does for the website.
import {fail} from './common.mjs';
import {typeOf} from './expand.mjs';
import {loadPalette} from './colors.mjs';
import {colorSlug} from './mockups.mjs';
import {catalogMaxAge,independentImage,stickerPictures,stickerPicture} from './catalog.mjs';

// The same order and names as the website's product picker (commerce.js EXTRA_LABELS). mugblack is the Black color
// of the one Mug choice.
const LABELS = {tshirt: 'T-shirt', hoodie: 'Hoodie', crewneck: 'Crewneck', tote: 'Tote bag', mug: 'Mug', hat: 'Dad hat', sticker: 'Sticker'};
const ORDER = Object.keys(LABELS);
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const sizeRank = size => { const i = SIZES.indexOf(String(size).toUpperCase()); return i < 0 ? SIZES.length : i; };

// Which mug color shows first (owner, Nov 3: black first, white where the design reads better on white):
// the site's assets/mugs/colors.json. Missing or unreachable = black.
async function mugFirst(env, designId, fetcher) {
  if (!fetcher || !env.STOREFRONT_ORIGIN) return 'Black';
  try {
    const response = await fetcher(`${env.STOREFRONT_ORIGIN}/assets/mugs/colors.json`, {cf: {cacheTtl: 3600, cacheEverything: true}});
    const map = response.ok ? await response.json() : {};
    return map?.[String(designId)] === 'white' ? 'White' : 'Black';
  } catch { return 'Black'; }
}

export async function designOptions(store, env, now, origin, designId, fetcher = null) {
  const generation = await store.activeGeneration();
  const run = generation && await store.first("SELECT updated_at FROM catalog_sync_runs WHERE id=? AND status='complete'", generation);
  if (!run) fail(503, 'catalog_not_ready', 'The shop is being updated. Please try again in a moment.');
  const available = now - run.updated_at <= catalogMaxAge(env);
  const products = (await store.all('SELECT id,external_id,title,image FROM catalog_products WHERE generation=? AND (id=? OR external_id LIKE ?)', generation, designId, `nx-%-${designId}`))
    .map(p => ({...p, id: String(p.id), type: String(p.id) === designId ? (typeOf(p.external_id) ? null : 'tshirt') : (typeOf(p.external_id)?.design === designId ? typeOf(p.external_id).type : null)}))
    .filter(p => p.type);
  const design = products.find(p => p.type === 'tshirt');
  if (!design) fail(404, 'design_not_found', 'That design is not in the shop right now.');
  const ids = products.map(p => p.id);
  const marks = ids.map(() => '?').join(',');
  const rows = await store.all(`SELECT product_id,json_extract(snapshot_json,'$.id') AS variant_id,json_extract(snapshot_json,'$.size') AS size,json_extract(snapshot_json,'$.color') AS color,json_extract(snapshot_json,'$.image') AS image,price_cents FROM catalog_variants WHERE generation=? AND product_id IN (${marks}) ORDER BY product_id,id`, generation, ...ids);
  // Model photos (mockups.mjs) replace Printful's flat previews for the colors that have one.
  const photos = new Map();
  try {
    for (const row of await store.all(`SELECT product_id,colors_json FROM mockup_jobs WHERE status='done' AND product_id IN (${marks})`, ...ids)) photos.set(String(row.product_id), new Set(JSON.parse(row.colors_json || '[]')));
  } catch { /* no model photos yet */ }
  const palette = await loadPalette(store);
  const stickers = products.some(p => p.type === 'sticker') ? await stickerPictures(store) : null;
  const first = products.some(p => p.type === 'mugblack') ? await mugFirst(env, designId, fetcher) : 'White';

  const byType = new Map();
  for (const product of products) {
    const type = product.type === 'mugblack' ? 'mug' : product.type;
    if (!LABELS[type]) continue;
    const sticker = product.type === 'sticker' ? stickerPicture(stickers, product.external_id) : null;
    const mugColor = product.type === 'mug' ? ['White', '#ffffff'] : product.type === 'mugblack' ? ['Black', '#111111'] : null;
    let option = byType.get(type);
    if (!option) byType.set(type, option = {type, label: LABELS[type], variants: []});
    for (const row of rows) {
      if (String(row.product_id) !== product.id) continue;
      const color = String(row.color || '') || (mugColor ? mugColor[0] : '');
      const model = photos.get(product.id)?.has(row.color) ? `${origin}/api/mockups/${product.id}/${colorSlug(row.color)}.jpg` : null;
      option.variants.push({
        id: String(row.variant_id), product_id: product.id, color, size: String(row.size || ''),
        hex: (row.color && palette[row.color]) || (mugColor ? mugColor[1] : null),
        image: sticker || model || independentImage(row.image) || independentImage(product.image) || null,
        price_cents: row.price_cents
      });
    }
  }
  const options = [...byType.values()].filter(option => option.variants.length).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)).map(option => {
    if (option.type === 'mug' && first === 'Black') option.variants.sort((a, b) => (a.color === 'Black' ? 0 : 1) - (b.color === 'Black' ? 0 : 1));
    const colors = []; const sizes = [];
    for (const v of option.variants) {
      if (v.color && !colors.some(c => c.name === v.color)) colors.push({name: v.color, hex: v.hex, image: v.image});
      if (v.size && !sizes.includes(v.size)) sizes.push(v.size);
    }
    sizes.sort((a, b) => sizeRank(a) - sizeRank(b));
    return {
      type: option.type, label: option.label, colors, sizes,
      from_cents: Math.min(...option.variants.map(v => v.price_cents)),
      image: option.variants.map(v => v.image).find(Boolean) || null,
      variants: option.variants.map(({hex, ...rest}) => rest)
    };
  });
  return {ok: true, id: designId, title: String(design.title || '').replace(/\s+T$/, ''), available, max_quantity: 10, max_cart_quantity: 50, max_variants: 20, options};
}

// Returns a Response for the route above, or null.
export async function appShopRoute(request, url, store, env, now, headers, fetcher = null) {
  const match = /^\/api\/app\/design\/(\d{1,20})$/.exec(url.pathname);
  if (!match) return null;
  const open = {...headers, 'Access-Control-Allow-Origin': '*'};
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: {...open, 'Access-Control-Allow-Methods': 'GET, OPTIONS'}});
  if (request.method !== 'GET') fail(405, 'method_not_allowed');
  return Response.json(await designOptions(store, env, now, url.origin, match[1], fetcher), {headers: {...open, 'Cache-Control': 'public, max-age=300'}});
}
