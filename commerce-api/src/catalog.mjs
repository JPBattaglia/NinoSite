import {fail,cents,hash,httpsImage} from './common.mjs';

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
    image:httpsImage(preview?.preview_url) || httpsImage(preview?.url) || httpsImage(product.thumbnail_url) || httpsImage(raw.product?.image),
    price_cents:amount,currency:'usd',catalog_variant_id:raw.variant_id,files,options:raw.options || []
  };
  variant.fingerprint = await hash({catalog_variant_id:variant.catalog_variant_id,price_cents:amount,currency:'usd',files:artworkKeys(files),options:variant.options});
  return variant;
}
export async function publicCatalog(store,env,now) {
  const generation = await store.activeGeneration();
  if (!generation) return {products:[],catalog_ready:false};
  const run = await store.first('SELECT * FROM catalog_sync_runs WHERE id=? AND status=\'complete\'',generation);
  const fresh = !!run && now - run.updated_at <= Number(env.CATALOG_MAX_AGE_SECONDS || 86400);
  const products = await store.all('SELECT * FROM catalog_products WHERE generation=? ORDER BY title',generation);
  const variants = await store.all('SELECT * FROM catalog_variants WHERE generation=? ORDER BY product_id,id',generation);
  return {catalog_ready:fresh,products:products.map(product => ({
    id:product.id,external_id:product.external_id,title:product.title,image:product.image,
    variants:variants.filter(v => v.product_id === product.id).map(row => {
      const v = JSON.parse(row.snapshot_json);
      return {id:v.id,name:v.name,size:v.size,color:v.color,image:v.image,price:{amount:v.price_cents,currency:v.currency},available:fresh,max_quantity:10};
    })
  })).filter(p => p.variants.length)};
}
export async function validatedLines(store,printful,env,items,now) {
  const generation = await store.activeGeneration();
  const run = generation && await store.first('SELECT * FROM catalog_sync_runs WHERE id=? AND status=\'complete\'',generation);
  if (!run || now - run.updated_at > Number(env.CATALOG_MAX_AGE_SECONDS || 86400)) fail(503,'catalog_not_ready','The product catalog is being updated.');
  const lines = [];
  for (const item of items) {
    const row = await store.first(`SELECT v.*,p.title,p.image FROM catalog_variants v JOIN catalog_products p ON p.generation=v.generation AND p.id=v.product_id WHERE v.generation=? AND v.id=? AND v.product_id=?`,generation,item.variant_id,item.product_id);
    if (!row) fail(422,'variant_unavailable','A selected variant is not synced and ready to order.');
    const snapshot = JSON.parse(row.snapshot_json);
    const current = await printful.getVariant(item.variant_id);
    const verified = await normalizeVariant(current,{id:item.product_id,thumbnail_url:row.image});
    if (!verified) fail(422,'variant_unavailable','A selected variant is no longer available.');
    if (verified.fingerprint !== snapshot.fingerprint) fail(409,'catalog_changed','A selected product has changed. Refresh the catalog before checkout.');
    lines.push({...item,title:row.title,image:row.image,variant:snapshot,unit_price_cents:row.price_cents,line_total_cents:row.price_cents * item.quantity});
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
export async function continueCatalogSync(store,printful,id,now) {
  const claim = crypto.randomUUID();
  const lock = await store.run("UPDATE catalog_sync_runs SET lease_until=?,claim_id=? WHERE id=? AND status='running' AND lease_until<=?",now+300,claim,id,now);
  if (!lock.meta.changes) return {sync_id:id,busy:true};
  const run = await store.first('SELECT * FROM catalog_sync_runs WHERE id=?',id);
  const ids = JSON.parse(run.product_ids_json); const next = Math.min(ids.length,run.cursor+10);
  try {
    for (const productId of ids.slice(run.cursor,next)) {
      const detail = await printful.getProduct(productId);
      if (!detail) continue;
      const product = detail.sync_product;
      if (!product || String(product.id) !== productId || product.is_ignored === true) continue;
      const variants = [];
      for (const raw of detail.sync_variants || []) {
        const v = await normalizeVariant(raw,product); if (v) variants.push(v);
      }
      await store.batch([
        ['INSERT OR REPLACE INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES(?,?,?,?,?,?)',id,productId,product.external_id == null ? null : String(product.external_id),String(product.name || '').slice(0,250),httpsImage(product.thumbnail_url),now],
        ['DELETE FROM catalog_variants WHERE generation=? AND product_id=?',id,productId],
        ...variants.map(v => ['INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES(?,?,?,?,?,?)',id,v.id,productId,v.price_cents,v.currency,JSON.stringify(v)])
      ]);
    }
    if (next === ids.length) {
      await store.batch([
        ["UPDATE catalog_sync_runs SET cursor=?,status='complete',claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?",next,now,id,claim],
        ["INSERT INTO commerce_settings(key,value) SELECT 'active_catalog',id FROM catalog_sync_runs WHERE id=? AND status='complete' ON CONFLICT(key) DO UPDATE SET value=excluded.value",id]
      ]);
    } else await store.run('UPDATE catalog_sync_runs SET cursor=?,claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?',next,now,id,claim);
    return {sync_id:id,processed:next,total:ids.length,complete:next===ids.length};
  } catch (error) {
    await store.run('UPDATE catalog_sync_runs SET claim_id=NULL,lease_until=0,last_error=?,updated_at=? WHERE id=? AND claim_id=?',String(error.code || 'provider_error'),now,id,claim);
    throw error;
  }
}
