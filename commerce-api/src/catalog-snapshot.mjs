// The public product list, kept as one finished JSON body in Workers KV (MOCKUPS namespace).
//
// Why (Oct 31, 2026): building the list reads every catalog variant row (~15,000 and growing with stage 14), and the
// edge cache meant to share it does nothing on a workers.dev address, so most visits rebuilt it. With the stage 14
// rollout finishing a model photo every few minutes, the in-memory copy was also thrown away constantly, and the shop
// used 4.8 of D1's 5 million free daily row reads; reads were blocked from about 5 pm Pacific.
//
// Now a visit costs two single-row reads plus one KV read. The body is rebuilt when a catalog sync finishes (the
// generation or its finish time changes), when the catalog goes stale or fresh, and at most hourly while new model
// photos keep arriving (refreshCatalogSnapshot, from the 5-minute run).
//
// Nov 1, 2026: during the stage 14 rollout a catalog sync finishes about every 10 minutes, and each finish rebuilt the
// body (~37,000 rows read each time, ~665,000 rows in 3 hours, 80% of the account's free daily reads by 3 pm Pacific,
// shared with Menu-made's checkout). A newer sync now replaces the stored body at most once per
// SNAPSHOT_REFRESH_SECONDS. Showing a list up to an hour old is safe: checkout re-reads every line's current price and
// availability from D1 and Printful before charging (validatedLines). A change in readiness still rebuilds at once.
import {publicCatalog, catalogMaxAge} from './catalog.mjs';
import {mockupColors} from './mockups.mjs';

export const SNAPSHOT_KEY = 'catalog:snapshot';
export const SNAPSHOT_REFRESH_SECONDS = 3600;

async function liveCatalog(store) {
  const generation = await store.activeGeneration();
  if (!generation) return null;
  const run = await store.first("SELECT updated_at FROM catalog_sync_runs WHERE id=? AND status='complete'", generation);
  return run ? {generation, run: run.updated_at} : null;
}

async function build(store, env, now, origin, live) {
  const catalog = await publicCatalog(store, env, now, origin);
  const body = JSON.stringify(catalog);
  const meta = {g: live?.generation || '', r: live?.run || 0, o: origin, b: now,
    ready: Boolean(catalog.catalog_ready), any: catalog.products.some(p => p.variants.some(v => v.available)),
    m: live ? (await mockupColors(store)).version : ''};
  if (env.MOCKUPS && live && catalog.catalog_complete) await env.MOCKUPS.put(SNAPSHOT_KEY, body, {metadata: meta});
  return {body, meta};
}

async function stored(env) {
  if (!env.MOCKUPS || typeof env.MOCKUPS.getWithMetadata !== 'function') return null;
  try { const hit = await env.MOCKUPS.getWithMetadata(SNAPSHOT_KEY, 'text'); return hit?.value && hit.metadata ? hit : null; } catch { return null; }
}

// {body, meta} for a request. body is the catalog JSON object without the readiness fields.
export async function catalogSnapshot(store, env, now, origin) {
  const live = await liveCatalog(store);
  if (live) {
    const hit = await stored(env);
    const m = hit?.metadata;
    const ready = now - live.run <= catalogMaxAge(env);
    if (m && m.o === origin && m.ready === ready && ((m.g === live.generation && m.r === live.run) || now - m.b < SNAPSHOT_REFRESH_SECONDS)) return {body: hit.value, meta: m};
  }
  return build(store, env, now, origin, live);
}

// From the 5-minute run: keep the stored body current without any visitor paying for the rebuild.
export async function refreshCatalogSnapshot(store, env, now) {
  const hit = await stored(env);
  if (!hit) return 'none';
  const m = hit.metadata, live = await liveCatalog(store);
  if (!live) return 'no_catalog';
  const fresh = now - live.run <= catalogMaxAge(env);
  if (m.ready === fresh && now - m.b < SNAPSHOT_REFRESH_SECONDS) return 'recent';
  if (m.g === live.generation && m.r === live.run && m.ready === fresh && (await mockupColors(store)).version === m.m) return 'current';
  await build(store, env, now, m.o, live);
  return 'rebuilt';
}

// The readiness fields only need to know whether the catalog is current and has anything for sale.
export const readinessCatalog = meta => ({catalog_ready: Boolean(meta.ready), products: meta.any ? [{variants: [{available: true}]}] : []});
export const withReadiness = (body, readiness) => body.slice(0, -1) + ',' + JSON.stringify(readiness).slice(1);
