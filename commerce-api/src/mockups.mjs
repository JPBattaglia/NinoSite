// Model photos of every shirt in every color, generated with Printful's Mockup Generator.
//
// Jobs live in D1 (mockup_jobs). Each job carries the design's placement (inches inside the 12x16in front
// print area) so the photos show the artwork exactly where and how large it prints. The scheduled handler
// submits one shirt at a time and later collects the finished photos. Printful's result URLs are temporary,
// so the photos are stored as one bundle per shirt in Workers KV (env.MOCKUPS) and served from this API.
//
// Bundle format: 4-byte big-endian header length, JSON header {colors:{name:[offset,length]}}, JPEG bytes.

export const MEN_STYLE = 5559;    // Gildan 5000 "Men's" front
export const WOMEN_STYLE = 22019; // Gildan 5000 "Women's" front
const CATALOG_PRODUCT = 438;      // Gildan 5000 Unisex Classic Tee

const artworkUrl = hash => `https://files.cdn.printful.com/files/${hash.slice(0, 3)}/${hash}_preview.png`;
export const mockupKey = productId => `mockups/${productId}`;
export const colorSlug = color => String(color || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function printful(env, method, path, body, fetcher) {
  const response = await fetcher(`https://api.printful.com${path}`, {
    method, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${env.PRINTFUL_ACCESS_TOKEN}`, 'X-PF-Store-Id': env.PRINTFUL_STORE_ID, 'Content-Type': 'application/json' }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`printful ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// One representative catalog variant per color (sizes share the same photo), plus the design file hash.
async function productColors(store, productId) {
  const rows = await store.all(`SELECT json_extract(snapshot_json,'$.color') AS color,
      MIN(json_extract(snapshot_json,'$.catalog_variant_id')) AS catalog_variant_id,
      MAX(json_extract(snapshot_json,'$.files[0].hash')) AS hash,
      MAX(json_extract(snapshot_json,'$.files[0].id')) AS file_id
    FROM catalog_variants WHERE generation=(SELECT value FROM commerce_settings WHERE key='active_catalog') AND product_id=?
    GROUP BY color ORDER BY color`, productId);
  return rows.filter(row => row.color && row.catalog_variant_id);
}

// Catalog variant id -> color for every variant of a live product.
async function variantColors(store, productId) {
  const rows = await store.all(`SELECT DISTINCT json_extract(snapshot_json,'$.catalog_variant_id') AS catalog_variant_id,
      json_extract(snapshot_json,'$.color') AS color
    FROM catalog_variants WHERE generation=(SELECT value FROM commerce_settings WHERE key='active_catalog') AND product_id=?`, productId);
  return new Map(rows.filter(row => row.color && row.catalog_variant_id).map(row => [Number(row.catalog_variant_id), row.color]));
}

// Printful requires the whole layer (including transparent margins) inside the 12x16in print area.
// Nov 1, 2026: two designs whose art ended exactly on the area's edge (right edge 12.000in, bottom 16.000in) were
// refused as 'Invalid position' by Printful, so the art stays 0.01in inside every edge (rounding can't push it out).
const EDGE = 0.01;
export function fitPrintArea({width, height, top, left}) {
  const W = 12 - 2 * EDGE, H = 16 - 2 * EDGE;
  const scale = Math.min(1, W / width, H / height);
  const floor = value => Math.floor(value * 1000) / 1000, round = value => Math.round(value * 1000) / 1000;
  const w = floor(width * scale), h = floor(height * scale);
  const cx = left + width / 2, cy = top + height / 2;
  return { width: w, height: h, top: round(Math.min(Math.max(cy - h / 2, EDGE), 16 - EDGE - h)), left: round(Math.min(Math.max(cx - w / 2, EDGE), 12 - EDGE - w)) };
}

// Alternate men's and women's models across the colors so each shirt shows both.
export function styleForColor(index) { return index % 2 === 0 ? MEN_STYLE : WOMEN_STYLE; }

async function submit(store, env, job, now, fetcher) {
  const colors = await productColors(store, job.product_id);
  const hash = colors.find(row => row.hash)?.hash;
  if (!colors.length || !hash) throw new Error('no_variants_or_artwork');
  const raw = JSON.parse(job.layer_json);
  // Stage 14 products (expand.mjs) carry their own catalog product, placement and print area (inches); Printful's
  // default photo style is used for them.
  if (raw.catalog) {
    // Rebuilt products: wait (status 'hold', looked at again hourly) until the shop's catalog lists the new colors.
    if (Array.isArray(raw.colors) && raw.colors.length && JSON.stringify([...new Set(colors.map(row => row.color))].sort()) !== JSON.stringify(raw.colors)) {
      await store.run("UPDATE mockup_jobs SET status='hold',last_error='waiting_for_catalog_colors',updated_at=? WHERE product_id=?", now, job.product_id);
      return;
    }
    // Remade stickers: wait until the catalog shows the new artwork file.
    if (raw.file_id && !colors.some(row => String(row.file_id) === String(raw.file_id))) {
      await store.run("UPDATE mockup_jobs SET status='hold',last_error='waiting_for_catalog_file',updated_at=? WHERE product_id=?", now, job.product_id);
      return;
    }
    const p = raw.position_in;
    const placements = [{ placement: raw.placement, technique: raw.technique, layers: [{ type: 'file', url: artworkUrl(hash), position: { width: p.width, height: p.height, top: p.top, left: p.left } }] }];
    const ids = raw.catalog_variant_ids?.length ? raw.catalog_variant_ids : colors.map(row => row.catalog_variant_id);
    const result = await printful(env, 'POST', '/v2/mockup-tasks', { format: 'jpg', products: [{ source: 'catalog', catalog_product_id: raw.catalog, placements, catalog_variant_ids: ids }] }, fetcher);
    const taskIds = (result.data || []).map(task => task.id).filter(Boolean);
    if (!taskIds.length) throw new Error('no_task_id');
    await store.run("UPDATE mockup_jobs SET status='submitted',task_id=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE product_id=?", taskIds.join(','), now, job.product_id);
    return;
  }
  const layer = fitPrintArea(raw);
  const placements = [{ placement: 'front', technique: 'dtg', layers: [{ type: 'file', url: artworkUrl(hash), position: layer }] }];
  const groups = [MEN_STYLE, WOMEN_STYLE].map(style => ({
    source: 'catalog', catalog_product_id: CATALOG_PRODUCT, mockup_style_ids: [style], placements,
    catalog_variant_ids: colors.filter((_, index) => styleForColor(index) === style).map(row => row.catalog_variant_id)
  })).filter(group => group.catalog_variant_ids.length);
  const result = await printful(env, 'POST', '/v2/mockup-tasks', { format: 'jpg', products: groups }, fetcher);
  const taskIds = (result.data || []).map(task => task.id).filter(Boolean);
  if (!taskIds.length) throw new Error('no_task_id');
  await store.run("UPDATE mockup_jobs SET status='submitted',task_id=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE product_id=?", taskIds.join(','), now, job.product_id);
}

async function collect(store, env, job, now, fetcher) {
  const tasks = [];
  for (const id of String(job.task_id).split(',').filter(Boolean)) {
    const result = await printful(env, 'GET', `/v2/mockup-tasks?id=${encodeURIComponent(id)}`, null, fetcher);
    tasks.push(...(result.data || []));
  }
  if (tasks.some(task => task.status === 'failed')) throw new Error('task_failed: ' + JSON.stringify(tasks.map(task => task.failure_reasons)).slice(0, 200));
  if (!tasks.length || tasks.some(task => task.status !== 'completed')) return false;
  // Every catalog variant of the product maps to its color, not only the one productColors picks: a stage 14 photo
  // can be made on a chosen size (stickers use the 5.5in variant), which isn't the lowest id for its color.
  const colorByVariant = await variantColors(store, job.product_id);
  const parts = []; const header = { colors: {} }; let offset = 0;
  for (const task of tasks) for (const variant of task.catalog_variant_mockups || []) {
    const color = colorByVariant.get(Number(variant.catalog_variant_id));
    const mockup = (variant.mockups || []).find(item => item.placement === 'front' || item.placement === 'default') || variant.mockups?.[0];
    if (!color || !mockup?.mockup_url || header.colors[color]) continue;
    const image = await fetcher(mockup.mockup_url, { signal: AbortSignal.timeout(20000) });
    if (!image.ok) throw new Error(`download ${image.status}`);
    const bytes = new Uint8Array(await image.arrayBuffer());
    header.colors[color] = [offset, bytes.length]; offset += bytes.length; parts.push(bytes);
  }
  if (!parts.length) throw new Error('no_mockups');
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const bundle = new Uint8Array(4 + headerBytes.length + offset);
  new DataView(bundle.buffer).setUint32(0, headerBytes.length);
  bundle.set(headerBytes, 4); let position = 4 + headerBytes.length;
  for (const part of parts) { bundle.set(part, position); position += part.length; }
  await env.MOCKUPS.put(mockupKey(job.product_id), bundle);
  await store.run("UPDATE mockup_jobs SET status='done',colors_json=?,last_error=NULL,updated_at=? WHERE product_id=?", JSON.stringify(Object.keys(header.colors)), now, job.product_id);
  return true;
}

// Printful sometimes leaves a mockup task "pending" forever. A submitted job older than this is resubmitted
// (or parked after 3 attempts) so one stuck shirt can't hold up the rest of the queue.
export const STALL_SECONDS = 30 * 60;

// Called every 5 minutes: collect a submitted job if it's ready, then submit the next pending one in the same
// run (one job in flight at a time keeps each run well inside the free plan's CPU limit).
export async function processMockups(store, env, now, fetcher = (...args) => fetch(...args)) {
  if (!env.MOCKUPS || !env.PRINTFUL_ACCESS_TOKEN) return 'disabled';
  // Held jobs (see submit) get another look once an hour.
  try { await store.run("UPDATE mockup_jobs SET status='pending',updated_at=? WHERE status='hold' AND last_error IN ('waiting_for_catalog_colors','waiting_for_catalog_file') AND updated_at<?", now, now - 1800); } catch { /* table missing: handled below */ }
  let submitted;
  try { submitted = await store.first("SELECT * FROM mockup_jobs WHERE status='submitted' ORDER BY updated_at LIMIT 1"); }
  catch { return 'no_table'; }
  if (submitted && now - submitted.updated_at > STALL_SECONDS) {
    await store.run("UPDATE mockup_jobs SET status=?,task_id=NULL,last_error='printful_task_stalled',updated_at=? WHERE product_id=?", submitted.attempts < 3 ? 'pending' : 'error', now, submitted.product_id);
    submitted = null;
  }
  let collected = false;
  if (submitted) {
    try {
      if (!(await collect(store, env, submitted, now, fetcher))) return 'waiting';
      collected = true;
    } catch (error) {
      const retry = submitted.attempts < 3 ? 'pending' : 'error';
      await store.run('UPDATE mockup_jobs SET status=?,last_error=?,updated_at=? WHERE product_id=?', retry, String(error?.message || error).slice(0, 300), now, submitted.product_id);
      return 'collect_failed';
    }
  }
  // A job waits until its product is in the live catalog (new stage 14 products appear after the next sync).
  const next = await store.first("SELECT * FROM mockup_jobs WHERE status='pending' AND (layer_json NOT LIKE '%\"catalog\":%' OR product_id IN (SELECT id FROM catalog_products WHERE generation=(SELECT value FROM commerce_settings WHERE key='active_catalog'))) ORDER BY priority DESC, attempts, product_id LIMIT 1");
  if (!next) return collected ? 'collected' : 'idle';
  try { await submit(store, env, next, now, fetcher); return collected ? 'collected' : 'submitted'; }
  catch (error) {
    await store.run("UPDATE mockup_jobs SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE product_id=?", next.attempts < 2 ? 'pending' : 'error', String(error?.message || error).slice(0, 300), now, next.product_id);
    return collected ? 'collected' : 'submit_failed';
  }
}

// Map of product ID -> list of colors with a stored model photo.
export async function mockupColors(store) {
  try {
    const rows = await store.all("SELECT product_id,colors_json,updated_at FROM mockup_jobs WHERE status='done'");
    return { version: rows.length + ':' + rows.reduce((max, row) => Math.max(max, row.updated_at), 0), map: new Map(rows.map(row => [row.product_id, new Set(JSON.parse(row.colors_json || '[]'))])) };
  } catch { return { version: 'none', map: new Map() }; }
}

// GET /api/mockups/{productId}/{color-slug}.jpg
export async function serveMockup(env, productId, slug, ctx) {
  if (!env.MOCKUPS) return null;
  const bundle = await env.MOCKUPS.get(mockupKey(productId), 'arrayBuffer');
  if (!bundle) return null;
  const view = new DataView(bundle); const headerLength = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bundle, 4, headerLength)));
  const entry = Object.entries(header.colors).find(([color]) => colorSlug(color) === slug);
  if (!entry) return null;
  const [offset, length] = entry[1];
  return new Response(new Uint8Array(bundle, 4 + headerLength + offset, length), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }
  });
}
