import {fail,cents,hash,httpsImage} from './common.mjs';
import {mockupColors,colorSlug} from './mockups.mjs';
import {loadPalette} from './colors.mjs';
import {typeOf} from './expand.mjs';

// The catalog syncs once a day; allow two days so one missed or slow sync doesn't close checkout.
// Checkout still re-verifies every variant against Printful before charging.
export const CATALOG_MAX_AGE_DEFAULT = 172800;
function catalogMaxAge(env) { return Number(env.CATALOG_MAX_AGE_SECONDS || CATALOG_MAX_AGE_DEFAULT); }

function independentImage(value) {
  const image = httpsImage(value);
  if (!image) return null;
  // Printful sends a bare CDN origin as the thumbnail of products it has no thumbnail for.
  const url = new URL(image);
  return url.pathname.length > 1 && !/(^|\.)(etsy|etsystatic)\.com$/i.test(url.hostname) ? image : null;
}

export function printFiles(files) {
  return (Array.isArray(files) ? files : []).filter(file => file && !['preview','mockup'].includes(file.type) && file.status === 'ok' && (Number.isSafeInteger(file.id) && file.id > 0 || httpsImage(file.url))).map(file => ({
    type:file.type || 'default', id:Number.isSafeInteger(file.id) ? file.id : null,
    hash:typeof file.hash === 'string' ? file.hash : null, url:httpsImage(file.url), options:file.options || []
  }));
}
export function artworkKeys(files) {
  return files.map(file => `${file.type || 'default'}:${file.hash || file.id || file.url}`).sort();
}
export async function normalizeVariant(raw, product) {
  if (!raw || raw.synced !== true || raw.is_ignored === true || raw.availability_status !== 'active') return null;
  if (!Number.isSafeInteger(raw.id) || raw.id < 1 || !Number.isSafeInteger(raw.variant_id) || raw.variant_id < 1) return null;
  if (raw.sync_product_id != null && String(raw.sync_product_id) !== String(product.id)) return null;
  const amount = cents(raw.retail_price); const files = printFiles(raw.files);
  if (amount === null || String(raw.currency).toUpperCase() !== 'USD' || !files.length) return null;
  const preview = (raw.files || []).find(f => f.type === 'preview');
  const variant = {
    id:String(raw.id),product_id:String(product.id),external_id:raw.external_id == null ? null : String(raw.external_id),
    name:typeof raw.name === 'string' ? raw.name.slice(0,250) : '',
    size:typeof raw.size === 'string' ? raw.size.slice(0,100) : '',
    color:typeof raw.color === 'string' ? raw.color.slice(0,100) : '',
    image:[preview?.preview_url,preview?.url,raw.product?.image,product.thumbnail_url].map(independentImage).find(Boolean) || null,
    price_cents:amount,currency:'usd',catalog_variant_id:raw.variant_id,files,options:raw.options || []
  };
  variant.fingerprint = await hash({catalog_variant_id:variant.catalog_variant_id,price_cents:amount,currency:'usd',files:artworkKeys(files),options:variant.options});
  return variant;
}
const catalogMemos = new WeakMap();
export async function publicCatalog(store,env,now,origin='') {
  const generation = await store.activeGeneration();
  if (!generation) return {products:[],catalog_ready:false,catalog_complete:false};
  const run = await store.first('SELECT * FROM catalog_sync_runs WHERE id=? AND status=\'complete\'',generation);
  if (!run) return {products:[],catalog_ready:false,catalog_complete:false};
  const fresh = !!run && now - run.updated_at <= catalogMaxAge(env);
  // The catalog only changes when a sync completes, so a warm worker reuses the last build.
  const version = await store.first('SELECT COUNT(*) AS n,MAX(synced_at) AS changed FROM catalog_products WHERE generation=?',generation);
  // Generated model photos replace Printful's flat color previews as soon as each shirt's bundle is stored.
  const mockups = origin ? await mockupColors(store) : {version:'none',map:new Map()};
  // Swatch colors for designs that are not in the curated catalog.json (one settings row).
  const palette = await loadPalette(store);
  const paletteVersion = Object.keys(palette).length;
  const memoKey = `${generation}:${run.updated_at}:${fresh}:${version?.n}:${version?.changed}:${mockups.version}:${paletteVersion}:${origin}`;
  const memo = catalogMemos.get(store.db);
  if (memo?.key === memoKey) return memo.value;
  // Workers on the free plan get about 10ms of CPU per request, so the database extracts only the
  // public fields and each variant is visited once (the catalog has ~13,500 variants).
  const products = await store.all('SELECT id,external_id,title,image FROM catalog_products WHERE generation=? ORDER BY title',generation);
  const rows = await store.all("SELECT product_id,json_extract(snapshot_json,'$.id') AS variant_id,json_extract(snapshot_json,'$.name') AS name,json_extract(snapshot_json,'$.size') AS size,json_extract(snapshot_json,'$.color') AS color,json_extract(snapshot_json,'$.image') AS image,price_cents,currency FROM catalog_variants WHERE generation=? ORDER BY product_id,id",generation);
  const images = new Map();
  const safeImage = value => { if (!images.has(value)) images.set(value,independentImage(value)); return images.get(value); };
  const byProduct = new Map();
  for (const row of rows) {
    let list = byProduct.get(row.product_id);
    if (!list) byProduct.set(row.product_id,list = []);
    const modelPhoto = mockups.map.get(row.product_id)?.has(row.color) ? `${origin}/api/mockups/${row.product_id}/${colorSlug(row.color)}.jpg` : null;
    list.push({id:row.variant_id,name:row.name,size:row.size,color:row.color,color_hex:row.color ? palette[row.color] || null : null,image:modelPhoto || safeImage(row.image),price:{amount:row.price_cents,currency:row.currency},available:fresh,max_quantity:10});
  }
  const value = {catalog_ready:fresh,catalog_complete:true,products:products.map(product => {
    const variants = byProduct.get(product.id) || [];
    return {id:product.id,external_id:product.external_id,title:product.title,image:independentImage(product.image) || variants.map(v => v.image).find(Boolean) || null,variants};
  })};
  if (store.db && typeof store.db === 'object') catalogMemos.set(store.db,{key:memoKey,value});
  return value;
}
export async function validatedLines(store,printful,env,items,now) {
  const generation = await store.activeGeneration();
  const run = generation && await store.first('SELECT * FROM catalog_sync_runs WHERE id=? AND status=\'complete\'',generation);
  if (!run || now - run.updated_at > catalogMaxAge(env)) fail(503,'catalog_not_ready','The product catalog is being updated.');
  const lines = [];
  for (const item of items) {
    const row = await store.first(`SELECT v.*,p.title,p.image,p.external_id AS product_external_id FROM catalog_variants v JOIN catalog_products p ON p.generation=v.generation AND p.id=v.product_id WHERE v.generation=? AND v.id=? AND v.product_id=?`,generation,item.variant_id,item.product_id);
    if (!row) fail(422,'variant_unavailable','A selected variant is not synced and ready to order.');
    const snapshot = JSON.parse(row.snapshot_json);
    const current = await printful.getVariant(item.variant_id);
    const verified = await normalizeVariant(current,{id:item.product_id,thumbnail_url:row.image});
    if (!verified) fail(422,'variant_unavailable','A selected variant is no longer available.');
    if (verified.fingerprint !== snapshot.fingerprint) fail(409,'catalog_changed','A selected product has changed. Refresh the catalog before checkout.');
    lines.push({...item,kind:typeOf(row.product_external_id)?.type || 'tshirt',title:row.title,image:independentImage(snapshot.image) || independentImage(row.image),variant:snapshot,unit_price_cents:row.price_cents,line_total_cents:row.price_cents * item.quantity});
  }
  return lines;
}
export async function startCatalogSync(store,printful,now) {
  const running = await store.first("SELECT * FROM catalog_sync_runs WHERE status='running'");
  if (running) return running;
  const ids = []; let offset = 0;
  do {
    const page = await printful.listProducts(offset,100);
    if (!Array.isArray(page.result)) fail(502,'invalid_printful_catalog');
    for (const product of page.result) if (Number.isSafeInteger(product.id) && product.id > 0) ids.push(String(product.id));
    offset += page.result.length;
    if (page.result.length < 100 || offset >= (page.paging?.total ?? Infinity)) break;
    if (offset >= 5000) fail(502,'catalog_limit','Sync supports up to 5000 products per store.');
  } while (true);
  const id = crypto.randomUUID();
  await store.run('INSERT OR IGNORE INTO catalog_sync_runs(id,product_ids_json,status,created_at,updated_at) VALUES(?,?,\'running\',?,?)',id,JSON.stringify([...new Set(ids)]),now,now);
  return await store.first("SELECT * FROM catalog_sync_runs WHERE status='running'");
}
// Keep the real cause of a failed batch so it can be diagnosed from the database.
// Messages come from Printful responses, D1 or the runtime; credentials are never part of them.
function syncErrorLabel(error) {
  const detail = error?.code ? String(error.code) : `${error?.name || 'Error'}: ${error?.message || 'unknown'}`;
  return detail.replace(/Bearer\s+\S+/gi,'Bearer [hidden]').slice(0,300) || 'provider_error';
}
async function productUnchanged(store,generation,productId,row,variants) {
  const stored = await store.first('SELECT external_id,title,image FROM catalog_products WHERE generation=? AND id=?',generation,productId);
  if (!stored || stored.external_id !== row.external_id || stored.title !== row.title || stored.image !== row.image) return false;
  const current = (await store.all('SELECT id,price_cents,currency,snapshot_json FROM catalog_variants WHERE generation=? AND product_id=? ORDER BY id',generation,productId))
    .map(v => `${v.id}|${v.price_cents}|${v.currency}|${v.snapshot_json}`);
  const fetched = variants.map(v => `${v.id}|${v.price_cents}|${v.currency}|${JSON.stringify(v)}`).sort();
  return current.length === fetched.length && current.every((value,i) => value === fetched[i]);
}
// Older catalog generations are deleted gradually: deleting rows also counts against D1's daily write quota,
// so each scheduled run removes at most `limit` variant rows. Sync records are kept for a week for diagnosis.
export const CATALOG_PRUNE_ROWS_PER_RUN = 5000;
export async function pruneCatalogHistory(store,now,limit = CATALOG_PRUNE_ROWS_PER_RUN) {
  const active = await store.activeGeneration();
  if (!active) return {variants_deleted:0};
  const variants = await store.run('DELETE FROM catalog_variants WHERE rowid IN (SELECT rowid FROM catalog_variants WHERE generation<>? LIMIT ?)',active,limit);
  await store.run('DELETE FROM catalog_products WHERE generation<>? AND NOT EXISTS (SELECT 1 FROM catalog_variants v WHERE v.generation=catalog_products.generation AND v.product_id=catalog_products.id)',active);
  await store.run("DELETE FROM catalog_sync_runs WHERE id<>? AND status<>'running' AND updated_at<? AND NOT EXISTS (SELECT 1 FROM catalog_products p WHERE p.generation=catalog_sync_runs.id)",active,now - 7 * 86400);
  return {variants_deleted:variants.meta.changes};
}
export async function continueCatalogSync(store,printful,id,now) {
  const claim = crypto.randomUUID();
  const lock = await store.run("UPDATE catalog_sync_runs SET lease_until=?,claim_id=? WHERE id=? AND status='running' AND lease_until<=?",now+300,claim,id,now);
  if (!lock.meta.changes) return {sync_id:id,busy:true};
  const run = await store.first('SELECT * FROM catalog_sync_runs WHERE id=?',id);
  const ids = JSON.parse(run.product_ids_json); const next = Math.min(ids.length,run.cursor+10);
  // D1 bills every row written (index entries included), so a full re-copy of the catalog on each sync
  // exhausts the free daily quota. Once a catalog is live, a sync updates it in place and only writes
  // products whose data actually changed. Each product is replaced in one atomic batch, and products that
  // left the store are removed only when the whole sync completes, so a partial sync never erases stock.
  // The very first sync still stages a full generation and activates it when complete.
  const active = await store.activeGeneration();
  const target = active && active !== id && await store.first('SELECT id FROM catalog_sync_runs WHERE id=?',active) ? active : id;
  try {
    for (const productId of ids.slice(run.cursor,next)) {
      const detail = await printful.getProduct(productId);
      const product = detail?.sync_product;
      if (!product || String(product.id) !== productId || product.is_ignored === true) {
        if (target !== id) await store.batch([
          ['DELETE FROM catalog_variants WHERE generation=? AND product_id=?',target,productId],
          ['DELETE FROM catalog_products WHERE generation=? AND id=?',target,productId]
        ]);
        continue;
      }
      const variants = [];
      for (const raw of detail.sync_variants || []) {
        const v = await normalizeVariant(raw,product); if (v) variants.push(v);
      }
      const row = {external_id:product.external_id == null ? null : String(product.external_id),title:String(product.name || '').slice(0,250),image:httpsImage(product.thumbnail_url)};
      if (await productUnchanged(store,target,productId,row,variants)) continue;
      await store.batch([
        ['INSERT OR REPLACE INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES(?,?,?,?,?,?)',target,productId,row.external_id,row.title,row.image,now],
        ['DELETE FROM catalog_variants WHERE generation=? AND product_id=?',target,productId],
        ...variants.map(v => ['INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES(?,?,?,?,?,?)',target,v.id,productId,v.price_cents,v.currency,JSON.stringify(v)])
      ]);
    }
    if (next === ids.length && target !== id) {
      await store.batch([
        ['DELETE FROM catalog_variants WHERE generation=? AND product_id NOT IN (SELECT value FROM json_each(?))',target,run.product_ids_json],
        ['DELETE FROM catalog_products WHERE generation=? AND id NOT IN (SELECT value FROM json_each(?))',target,run.product_ids_json],
        ["UPDATE catalog_sync_runs SET cursor=?,status='complete',claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?",next,now,id,claim],
        // The live catalog was just verified against Printful, so it counts as fresh again.
        ['UPDATE catalog_sync_runs SET updated_at=? WHERE id=?',now,target]
      ]);
    } else if (next === ids.length) {
      await store.batch([
        ["UPDATE catalog_sync_runs SET cursor=?,status='complete',claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?",next,now,id,claim],
        ["INSERT INTO commerce_settings(key,value) SELECT 'active_catalog',id FROM catalog_sync_runs WHERE id=? AND status='complete' ON CONFLICT(key) DO UPDATE SET value=excluded.value",id]
      ]);
    } else await store.run('UPDATE catalog_sync_runs SET cursor=?,claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?',next,now,id,claim);
    return {sync_id:id,processed:next,total:ids.length,complete:next===ids.length};
  } catch (error) {
    await store.run('UPDATE catalog_sync_runs SET claim_id=NULL,lease_until=0,last_error=?,updated_at=? WHERE id=? AND claim_id=?',syncErrorLabel(error),now,id,claim);
    throw error;
  }
}
