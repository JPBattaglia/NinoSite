// Copies new designs from the owner's source Printful store (the Etsy-linked "NinosTs" store, where designs are
// made) into the website's own Printful store, which is the only store the shop reads. The daily catalog sync then
// publishes them on the site. Nothing happens until the PRINTFUL_SOURCE_TOKEN secret exists.
//
// A design is "new" when no product with the same name exists in the website store and it has not been copied
// before (commerce_settings key `mirror:<source id>`). Prices, sizes, colors and artwork are copied as they are.
import {PrintfulClient} from './providers.mjs';

export const MIRROR_MAX_PER_RUN = 3;            // each product writes ~100 variants; keep D1 and Printful calls small
export const SOURCE_STORE_DEFAULT = '18583773'; // NinosTs
const PRINT_AREA = {width_in: 12, height_in: 16, dpi: 150};

const decode = text => String(text ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
export const nameKey = text => decode(text).toLowerCase().replace(/\s+/g, ' ').trim();

async function listAll(client) {
  const products = []; let offset = 0;
  do {
    const page = await client.listProducts(offset, 100);
    if (!page || !Array.isArray(page.result)) throw new Error('invalid_product_list');
    products.push(...page.result);
    offset += page.result.length;
    if (page.result.length < 100 || offset >= (page.paging?.total ?? Infinity)) break;
  } while (offset < 5000);
  return products;
}

// Where the artwork sits on the shirt: as large as the standard front allows (10.35in wide, 12in tall), centred
// and starting at the collar line, so the printed shirt matches the model photos generated for it.
export function placement(file) {
  const dpi = Number(file.dpi) > 0 ? Number(file.dpi) : 300;
  const nativeW = Number(file.width) / dpi, nativeH = Number(file.height) / dpi;
  if (!(nativeW > 0 && nativeH > 0)) return null;
  const scale = Math.min(10.352 / nativeW, 12 / nativeH);
  const width = Math.round(nativeW * scale * 1000) / 1000, height = Math.round(nativeH * scale * 1000) / 1000;
  const left = Math.round(((PRINT_AREA.width_in - width) / 2) * 1000) / 1000;
  const top = Math.round(Math.min(2.356, PRINT_AREA.height_in - height) * 1000) / 1000;
  return {width, height, top, left};
}

export function buildPayload(detail) {
  const product = detail?.sync_product; const variants = detail?.sync_variants;
  if (!product?.name || !Array.isArray(variants)) return null;
  let layer = null;
  const sync_variants = [];
  for (const raw of variants) {
    if (!raw || raw.is_ignored === true || raw.synced === false || !Number.isSafeInteger(raw.variant_id)) continue;
    const files = (raw.files || []).filter(file => file && !['preview', 'mockup'].includes(file.type) && file.status !== 'failed' && (file.id || file.url));
    if (!files.length) continue;
    const front = files.find(file => (file.type || 'default') === 'default');
    if (front && !layer) layer = placement(front);
    const price = Number(raw.retail_price);
    if (!(price > 0)) continue;
    const out = {variant_id: raw.variant_id, retail_price: Number(price).toFixed(2), files: files.map(file => {
      const base = file.url ? {type: file.type || 'default', url: file.url} : {type: file.type || 'default', id: file.id};
      if ((file.type || 'default') === 'default' && layer) {
        const px = PRINT_AREA.dpi;
        base.position = {area_width: PRINT_AREA.width_in * px, area_height: PRINT_AREA.height_in * px, width: Math.round(layer.width * px), height: Math.round(layer.height * px), top: Math.round(layer.top * px), left: Math.round(layer.left * px)};
      }
      return base;
    })};
    sync_variants.push(out);
  }
  if (!sync_variants.length) return null;
  return {payload: {sync_product: {name: decode(product.name)}, sync_variants}, layer};
}

async function createProduct(env, fetcher, payload) {
  const response = await fetcher('https://api.printful.com/store/products', {
    method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(25000),
    headers: {Authorization: `Bearer ${env.PRINTFUL_ACCESS_TOKEN}`, 'X-PF-Store-Id': env.PRINTFUL_STORE_ID, 'Content-Type': 'application/json'}
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`create ${response.status}: ${text.slice(0, 240)}`);
  const body = JSON.parse(text);
  const id = body?.result?.id;
  if (!id) throw new Error('create_no_id');
  return String(id);
}

const settingKey = id => `mirror:${id}`;
async function setSetting(store, key, value) {
  await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
}

// Returns {status, created:[names], errors:[...]} and records it in commerce_settings 'mirror_last'.
export async function runMirror(store, env, now, {destination, fetcher = (...args) => fetch(...args), max = MIRROR_MAX_PER_RUN} = {}) {
  if (!env.PRINTFUL_SOURCE_TOKEN || !env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) return {status: 'disabled', created: [], errors: []};
  const source = new PrintfulClient({PRINTFUL_ACCESS_TOKEN: env.PRINTFUL_SOURCE_TOKEN, PRINTFUL_STORE_ID: env.PRINTFUL_SOURCE_STORE_ID || SOURCE_STORE_DEFAULT, PRINTFUL_CATALOG_MODE: 'store'}, fetcher);
  const result = {status: 'ok', created: [], errors: [], source_total: 0, missing: 0};
  try {
    const [sourceProducts, destinationProducts] = await Promise.all([listAll(source), listAll(destination)]);
    result.source_total = sourceProducts.length;
    const have = new Set(destinationProducts.map(p => nameKey(p.name)));
    const copied = new Set((await store.all("SELECT key FROM commerce_settings WHERE key LIKE 'mirror:%'")).map(row => row.key));
    // The newest design has the highest ID; copy those first.
    const missing = sourceProducts.filter(p => p && p.is_ignored !== true && !have.has(nameKey(p.name)) && !copied.has(settingKey(p.id))).sort((a, b) => Number(b.id) - Number(a.id));
    result.missing = missing.length;
    for (const product of missing.slice(0, max)) {
      try {
        const built = buildPayload(await source.getProduct(product.id));
        if (!built) { result.errors.push(`${product.name}: no printable variants`); continue; }
        const created = await createProduct(env, fetcher, built.payload);
        await setSetting(store, settingKey(product.id), created);
        if (built.layer) await store.run("INSERT OR IGNORE INTO mockup_jobs(product_id,layer_json,status,priority,updated_at) VALUES(?,?,'pending',10,?)", created, JSON.stringify(built.layer), now);
        result.created.push(decode(product.name));
        have.add(nameKey(product.name));
      } catch (error) { result.errors.push(`${decode(product.name)}: ${String(error?.message || error).slice(0, 300)}`); }
    }
  } catch (error) { result.status = 'error'; result.errors.push(String(error?.message || error).slice(0, 300)); }
  await setSetting(store, 'mirror_last', JSON.stringify({at: now, ...result}));
  return result;
}
