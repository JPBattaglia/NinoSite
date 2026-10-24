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
      MAX(json_extract(snapshot_json,'$.files[0].hash')) AS hash
    FROM catalog_variants WHERE generation=(SELECT value FROM commerce_settings WHERE key='active_catalog') AND product_id=?
    GROUP BY color ORDER BY color`, productId);
  return rows.filter(row => row.color && row.catalog_variant_id);
}

// Printful requires the whole layer (including transparent margins) inside the 12x16in print area.
export function fitPrintArea({width, height, top, left}) {
  const scale = Math.min(1, 12 / width, 16 / height);
  const w = width * scale, h = height * scale;
  const cx = left + width / 2, cy = top + height / 2;
  const round = value => Math.round(value * 1000) / 1000;
  return { width: round(w), height: round(h), top: round(Math.min(Math.max(cy - h / 2, 0), 16 - h)), left: round(Math.min(Math.max(cx - w / 2, 0), 12 - w)) };
}

// Alternate men's and women's models across the colors so each shirt shows both.
export function styleForColor(index) { return index % 2 === 0 ? MEN_STYLE : WOMEN_STYLE; }

async function submit(store, env, job, now, fetcher) {
  const colors = await productColors(store, job.product_id);
  const hash = colors.find(row => row.hash)?.hash;
  if (!colors.length || !hash) throw new Error('no_variants_or_artwork');
  const layer = fitPrintArea(JSON.parse(job.layer_json));
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
  const colors = await productColors(store, job.product_id);
  const colorByVariant = new Map(colors.map(row => [Number(row.catalog_variant_id), row.color]));
  const parts = []; const header = { colors: {} }; let offset = 0;
  for (const task of tasks) for (const variant of task.catalog_variant_mockups || []) {
    const color = colorByVariant.get(Number(variant.catalog_variant_id));
    const mockup = (variant.mockups || []).find(item => item.placement === 'front') || variant.mockups?.[0];
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

// Called every minute: collect a submitted job if it's ready, otherwise submit the next pending one.
export async function processMockups(store, env, now, fetcher = (...args) => fetch(...args)) {
  if (!env.MOCKUPS || !env.PRINTFUL_ACCESS_TOKEN) return 'disabled';
  let submitted;
  try { submitted = await store.first("SELECT * FROM mockup_jobs WHERE status='submitted' ORDER BY updated_at LIMIT 1"); }
  catch { return 'no_table'; }
  if (submitted) {
    try { return (await collect(store, env, submitted, now, fetcher)) ? 'collected' : 'waiting'; }
    catch (error) {
      const retry = submitted.attempts < 3 ? 'pending' : 'error';
      await store.run('UPDATE mockup_jobs SET status=?,last_error=?,updated_at=? WHERE product_id=?', retry, String(error?.message || error).slice(0, 300), now, submitted.product_id);
      return 'collect_failed';
    }
  }
  const next = await store.first("SELECT * FROM mockup_jobs WHERE status='pending' ORDER BY priority DESC, product_id LIMIT 1");
  if (!next) return 'idle';
  try { await submit(store, env, next, now, fetcher); return 'submitted'; }
  catch (error) {
    await store.run("UPDATE mockup_jobs SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE product_id=?", next.attempts < 2 ? 'pending' : 'error', String(error?.message || error).slice(0, 300), now, next.product_id);
    return 'submit_failed';
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
