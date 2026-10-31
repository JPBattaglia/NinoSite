// Stage 14, task 1 (owner decision Oct 30, 2026): every Nino design on more products than the shirt. For each design
// the worker creates one Printful store product per product type, with the design's own artwork file placed on it,
// at Printful's cost x 1.5 rounded up to the dollar. The daily catalog sync then publishes them; the site shows them
// as options on the design's own page (external_id "nx-<type>-<design id>"), never as separate shop cards.
//
// Turned on in steps through commerce_settings 'expand_designs': empty/absent = off, a comma list of design product
// ids = only those (the sample batch the owner looks at first), 'all' = every design. Progress per design and type
// is kept in commerce_settings 'expand:<design id>:<type>' = the created product id, or 'error:<reason>'.
// Hats are not here yet: embroidery loses fine detail, so each design needs checking first (owner: no hat for
// designs that don't embroider well).

import {decodePng, summarize, blendsIn} from './artcolors.mjs';

export const EXPAND_PER_RUN = 2;          // each creation is one Printful call plus a few D1 writes
export const MARKUP = 1.5;

// variants: Printful catalog variant ids to sell, or a rule picking them from the catalog by the design's shirt colors.
// area: the print file size (px) per catalog variant, from Printful's printfiles for the product.
// fit: how the artwork sits in the area. 'contain' = as large as fits, centered; 'chest' = like the shirts (up to
// 86% of the width, from the collar line).
export const PRODUCT_TYPES = Object.freeze([
  {type: 'sticker', label: 'Sticker', catalog: 358, file: 'default', fit: 'contain', margin: 0.04, placement: 'default', technique: 'digital', dpi: 300, photoVariant: 10165,
    // 16362 = the 15x3.75in bumper size (owner yes, Oct 31): the art fits the 3.75in height, centered.
    variants: [10163, 10164, 10165, 16362], area: {10163: [900, 900], 10164: [1200, 1200], 10165: [1650, 1650], 16362: [4500, 1125]}},
  {type: 'tote', label: 'Tote bag', catalog: 367, file: 'default', fit: 'contain', margin: 0.1, placement: 'front', technique: 'dtg', dpi: 150,
    variants: [10457, 10458], area: {default: [1500, 1500]}, colorRule: 'tote'},
  {type: 'crewneck', label: 'Crewneck sweatshirt', catalog: 145, file: 'default', fit: 'chest', placement: 'front', technique: 'dtg', dpi: 150,
    area: {default: [1800, 2400]}, colorRule: 'match', maxColors: 3, sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']},
  // The hoodie's front area is a 14in square (Printful printfile 139) that runs down to the pouch pocket, so the art
  // stays in the top 60%: up to 12in wide, from 1in below the top.
  {type: 'hoodie', label: 'Hoodie', catalog: 146, file: 'default', fit: 'chest', placement: 'front', technique: 'dtg', dpi: 150, chest: {w: 0.8571, h: 0.6, top: 0.0714},
    area: {default: [2100, 2100]}, colorRule: 'match', maxColors: 3, sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']}
]);
const TYPES = new Map(PRODUCT_TYPES.map(t => [t.type, t]));
export const typeOf = externalId => { const m = /^nx-([a-z]+)-(\d+)$/.exec(String(externalId || '')); return m && TYPES.has(m[1]) ? {type: m[1], design: m[2]} : null; };
export const externalIdFor = (type, designId) => `nx-${type}-${designId}`;
export const retailPrice = cost => (Math.ceil(Number(cost) * MARKUP - 1e-9)).toFixed(2);

// Dark garments first, in this order, when the design's shirt comes in them; light ones only if it has nothing dark.
const DARK = ['Black', 'Navy', 'Dark Heather', 'Maroon', 'Forest Green', 'Charcoal', 'Military Green', 'Dark Chocolate', 'Purple', 'Royal'];
const LIGHT = ['White', 'Sport Grey', 'Ash', 'Sand', 'Light Blue', 'Light Pink'];

// The catalog variants for one type and design, from the catalog product's variants and the design's shirt colors.
// art: the design's color summary (artcolors.mjs); a garment color the whole design would blend into is skipped
// (owner, Oct 31: only when both the design and its outline blend in; Nino's outlines are meant to carry most colors).
export function pickVariants(spec, catalogVariants, shirtColors, art = null) {
  const usable = catalogVariants.filter(v => v && Number.isSafeInteger(v.id) && Number(v.price) > 0 && v.in_stock !== false);
  if (spec.variants && !spec.colorRule) return usable.filter(v => spec.variants.includes(v.id));
  const code = new Map(usable.map(v => [v.color, v.color_code]));
  const shows = color => !art || !blendsIn(art, code.get(color));
  if (spec.colorRule === 'tote') {
    const dark = shirtColors.some(c => DARK.includes(c)), light = shirtColors.some(c => LIGHT.includes(c));
    let want = [...(dark || !light ? ['Black'] : []), ...(light ? ['Oyster'] : [])].filter(shows);
    if (!want.length) want = ['Black', 'Oyster'].filter(shows).slice(0, 1);
    if (!want.length) want = ['Black'];
    return usable.filter(v => spec.variants.includes(v.id) && want.includes(v.color));
  }
  const offered = new Set(usable.map(v => v.color));
  const matching = [...DARK, ...LIGHT].filter(c => shirtColors.includes(c) && offered.has(c));
  let colors = matching.filter(shows);
  // A color was skipped: fill up with other colors from the same order that show the design well.
  if (colors.length < matching.length && colors.length < (spec.maxColors || 3)) colors.push(...[...DARK, ...LIGHT].filter(c => !colors.includes(c) && offered.has(c) && shows(c)));
  if (!colors.length) colors = ['Black'].filter(c => offered.has(c));
  colors = colors.slice(0, spec.maxColors || 3);
  return usable.filter(v => colors.includes(v.color) && (!spec.sizes || spec.sizes.includes(v.size)))
    .sort((a, b) => colors.indexOf(a.color) - colors.indexOf(b.color) || spec.sizes.indexOf(a.size) - spec.sizes.indexOf(b.size));
}

// Where the artwork goes in the print area (px), keeping its proportions.
export function position(spec, area, art) {
  const [aw, ah] = area;
  const w0 = Number(art.width), h0 = Number(art.height);
  if (!(w0 > 0 && h0 > 0)) return null;
  let width, height, top, left;
  if (spec.fit === 'chest') {
    const c = spec.chest || {w: 0.8627, h: 0.75, top: 0.1473};   // the shirts' placement on a 12x16in area
    const scale = Math.min((aw * c.w) / w0, (ah * c.h) / h0);
    width = Math.round(w0 * scale); height = Math.round(h0 * scale);
    left = Math.round((aw - width) / 2); top = Math.round(Math.min(ah * c.top, ah - height));
  } else {
    const room = 1 - 2 * (spec.margin || 0);
    const scale = Math.min((aw * room) / w0, (ah * room) / h0);
    width = Math.round(w0 * scale); height = Math.round(h0 * scale);
    left = Math.round((aw - width) / 2); top = Math.round((ah - height) / 2);
  }
  return {area_width: aw, area_height: ah, width, height, top, left, limit_to_print_area: true};
}

// The Printful store product for one design and type. design: {id, name, art:{id,width,height}, colors:[...]}.
export function buildProduct(spec, design, catalogVariants) {
  const variants = pickVariants(spec, catalogVariants, design.colors || [], design.palette || null);
  const sync_variants = [];
  for (const v of variants) {
    const area = spec.area[v.id] || spec.area.default;
    const pos = area && position(spec, area, design.art);
    if (!pos) continue;
    sync_variants.push({variant_id: v.id, retail_price: retailPrice(v.price), files: [{type: spec.file, id: design.art.id, position: pos}]});
  }
  if (!sync_variants.length) return null;
  const name = `${String(design.name).replace(/\s+T$/, '').trim()} ${spec.label}`.slice(0, 100);
  return {sync_product: {name, external_id: externalIdFor(spec.type, design.id)}, sync_variants};
}

// The model-photo job (mockups.mjs) for a created product: Printful's mockup generator with the same placement the
// orders use, in inches. Stickers get one photo (the largest size); garments and totes one per color.
export function photoLayer(spec, design, payload) {
  const variant = payload.sync_variants.find(v => !spec.photoVariant || v.variant_id === spec.photoVariant) || payload.sync_variants[0];
  const pos = variant.files[0].position, in3 = v => Math.round((v / spec.dpi) * 1000) / 1000;
  return {catalog: spec.catalog, placement: spec.placement, technique: spec.technique,
    catalog_variant_ids: spec.photoVariant ? [variant.variant_id] : null,
    position_in: {width: in3(pos.width), height: in3(pos.height), top: in3(pos.top), left: in3(pos.left)}};
}

// The design's artwork and shirt colors, from its store product (the shirt).
export function designFromDetail(detail) {
  const product = detail?.sync_product, variants = detail?.sync_variants;
  if (!product?.id || !Array.isArray(variants)) return null;
  let art = null; const colors = [];
  for (const v of variants) {
    if (!v || v.is_ignored === true) continue;
    if (v.color && !colors.includes(v.color)) colors.push(v.color);
    if (!art) {
      const f = (v.files || []).find(file => (file.type || 'default') === 'default' && file.status !== 'failed' && Number.isSafeInteger(file.id));
      if (f && Number(f.width) > 0 && Number(f.height) > 0) art = {id: f.id, width: Number(f.width), height: Number(f.height),
        thumb: /^https:\/\/files\.cdn\.printful\.com\/files\/[0-9a-f]{3}\/[0-9a-f]{32}_thumb\.png$/.test(f.thumbnail_url || '') ? f.thumbnail_url : null};
    }
  }
  return art ? {id: String(product.id), name: product.name, art, colors} : null;
}

async function api(env, method, path, body, fetcher) {
  const response = await fetcher(`https://api.printful.com${path}`, {
    method, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
    headers: {Authorization: `Bearer ${env.PRINTFUL_ACCESS_TOKEN}`, 'X-PF-Store-Id': env.PRINTFUL_STORE_ID, 'Content-Type': 'application/json'}
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const setSetting = (store, key, value) => store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);

// Catalog variants of a Printful product (id, color, size, cost), cached for a day.
async function catalogVariants(store, env, catalogId, now, fetcher) {
  const key = `expand_catalog2:${catalogId}`;   // 2 = with color codes
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', key);
  const cached = row ? JSON.parse(row.value) : null;
  if (cached && now - cached.at < 86400) return cached.variants;
  const result = (await api(env, 'GET', `/products/${catalogId}`, null, fetcher))?.result;
  const variants = (result?.variants || []).map(v => ({id: Number(v.id), color: v.color || '', color_code: v.color_code || '', size: v.size || '', price: Number(v.price),
    in_stock: (v.availability_status || []).some(a => a.region === 'US' && a.status === 'in_stock')}));
  await setSetting(store, key, JSON.stringify({at: now, variants}));
  return variants;
}

// The design's color summary, made once from Printful's artwork thumbnail and kept in commerce_settings. At most one
// new summary per run (decoding takes a few ms of CPU). Returns undefined when this run can't make it yet.
async function designPalette(store, design, fetcher, budget) {
  const key = `expand_art:${design.id}`;
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', key);
  if (row) return row.value === 'none' ? null : JSON.parse(row.value);
  if (!design.art.thumb) { await setSetting(store, key, 'none'); return null; }
  if (budget.used) return undefined;
  budget.used = true;
  const response = await fetcher(design.art.thumb, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`artwork thumbnail ${response.status}`);
  const image = await decodePng(new Uint8Array(await response.arrayBuffer()));
  const summary = image && summarize(image);
  await setSetting(store, key, summary ? JSON.stringify(summary) : 'none');
  return summary;
}

// One scheduled step: create up to EXPAND_PER_RUN missing products for the designs that are turned on.
// Returns {created:[...], errors:[...], remaining}. Never throws.
export async function runExpansion(store, env, now, {fetcher = (...a) => fetch(...a), max = EXPAND_PER_RUN} = {}) {
  const out = {created: [], errors: [], remaining: 0};
  try {
    if (!env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) return out;
    const setting = (await store.first("SELECT value FROM commerce_settings WHERE key='expand_designs'"))?.value?.trim();
    if (!setting) return out;
    const generation = await store.activeGeneration();
    if (!generation) return out;
    // Designs = the live shirts (anything that isn't itself an expansion product).
    let designs = (await store.all("SELECT id,external_id,title FROM catalog_products WHERE generation=? AND (external_id IS NULL OR external_id NOT LIKE 'nx-%') ORDER BY id DESC", generation)) || [];
    if (setting !== 'all') { const allow = new Set(setting.split(',').map(s => s.trim())); designs = designs.filter(d => allow.has(String(d.id))); }
    const done = new Set(((await store.all("SELECT key FROM commerce_settings WHERE key LIKE 'expand:%'")) || []).map(r => r.key));
    const todo = [];
    for (const d of designs) for (const spec of PRODUCT_TYPES) if (!done.has(`expand:${d.id}:${spec.type}`)) todo.push([d, spec]);
    // Products made before a rule change are rebuilt in place when their design is listed in 'expand_rebuild'
    // (Oct 31: the color check and the bigger sizes reached the 3 sample designs this way). Marked expand_v:<..> = 2.
    const rebuildIds = new Set(String((await store.first("SELECT value FROM commerce_settings WHERE key='expand_rebuild'"))?.value || '').split(',').map(v => v.trim()).filter(Boolean));
    const rebuilt = new Set(((await store.all("SELECT key FROM commerce_settings WHERE key LIKE 'expand_v:%'")) || []).map(r => r.key.slice(9)));
    const productIds = new Map(((await store.all("SELECT key,value FROM commerce_settings WHERE key LIKE 'expand:%'")) || []).map(r => [r.key.slice(7), r.value]));
    const redo = [];
    for (const d of designs) if (rebuildIds.has(String(d.id))) for (const spec of PRODUCT_TYPES) {
      const id = productIds.get(`${d.id}:${spec.type}`);
      if (/^\d+$/.test(id || '') && !rebuilt.has(`${d.id}:${spec.type}`)) redo.push([d, spec, id]);
    }
    out.remaining = todo.length + redo.length;
    const details = new Map(), budget = {used: false};
    const designOf = async d => {
      if (!details.has(d.id)) details.set(d.id, designFromDetail((await api(env, 'GET', `/store/products/${d.id}`, null, fetcher))?.result));
      return details.get(d.id);
    };
    for (const [d, spec, productId] of redo.slice(0, max)) {
      try {
        const design = await designOf(d);
        if (!design) continue;
        if (spec.colorRule && design.palette === undefined) {
          design.palette = await designPalette(store, design, fetcher, budget);
          if (design.palette === undefined) { delete design.palette; continue; }
        }
        const payload = buildProduct(spec, design, await catalogVariants(store, env, spec.catalog, now, fetcher));
        if (!payload) { await setSetting(store, `expand_v:${d.id}:${spec.type}`, 'error:no_variants'); out.errors.push(`${d.title} ${spec.label} rebuild: no variants`); continue; }
        // Printful replaces the variant list with the one sent (variants not listed are removed).
        await api(env, 'PUT', `/store/products/${productId}`, payload, fetcher);
        await setSetting(store, `expand_v:${d.id}:${spec.type}`, '2');
        await store.run("INSERT INTO mockup_jobs(product_id,layer_json,status,priority,updated_at) VALUES(?,?,'pending',5,?) ON CONFLICT(product_id) DO UPDATE SET layer_json=excluded.layer_json,status='pending',priority=5,task_id=NULL,attempts=0,last_error=NULL,updated_at=excluded.updated_at", String(productId), JSON.stringify(photoLayer(spec, design, payload)), now);
        out.created.push(payload.sync_product.name + ' (rebuilt)');
      } catch (error) { out.errors.push(`${d.title} ${spec.label} rebuild: ${String(error?.message || error).slice(0, 200)}`); }
    }
    max = Math.max(0, max - Math.min(max, redo.length));
    for (const [d, spec] of todo.slice(0, max)) {
      const key = `expand:${d.id}:${spec.type}`;
      try {
        const design = await designOf(d);
        if (!design) { await setSetting(store, key, 'error:no_artwork'); out.errors.push(`${d.title}: no artwork file`); continue; }
        if (spec.colorRule && design.palette === undefined) {
          design.palette = await designPalette(store, design, fetcher, budget);
          if (design.palette === undefined) { delete design.palette; continue; }   // next run
        }
        const payload = buildProduct(spec, design, await catalogVariants(store, env, spec.catalog, now, fetcher));
        if (!payload) { await setSetting(store, key, 'error:no_variants'); out.errors.push(`${d.title} ${spec.label}: no variants`); continue; }
        const created = await api(env, 'POST', '/store/products', payload, fetcher);
        const id = created?.result?.id;
        if (!id) throw new Error('create_no_id');
        await setSetting(store, key, String(id));
        await store.run("INSERT OR IGNORE INTO mockup_jobs(product_id,layer_json,status,priority,updated_at) VALUES(?,?,'pending',5,?)", String(id), JSON.stringify(photoLayer(spec, design, payload)), now);
        out.created.push(payload.sync_product.name);
      } catch (error) {
        // A refused key or a busy Printful is retried next run; anything else is recorded so it isn't retried forever.
        const message = String(error?.message || error).slice(0, 200);
        out.errors.push(`${d.title} ${spec.label}: ${message}`);
        if (!/\b(401|429|5\d\d)\b|timeout|abort/i.test(message)) await setSetting(store, key, `error:${message}`);
      }
    }
    out.remaining = Math.max(0, out.remaining - out.created.length);
    await setSetting(store, 'expand_last', JSON.stringify({at: now, ...out}));
  } catch (error) { out.errors.push(String(error?.message || error).slice(0, 200)); }
  return out;
}
