// One-piece stickers (owner, Nov 1, 2026). Printful's kiss-cut sticker cuts around every separate part of the artwork,
// so designs made of loose parts (words, an icon) arrived as several stickers. The sticker-art GitHub workflow
// (commerce-api/scripts/sticker_backing.py) makes each design's sticker artwork with one white backing shape behind
// the whole design and publishes it on the site: assets/stickers/<design id>.png, listed in assets/stickers/manifest.json
// as {"<design id>": {"sha": "...", "w": px, "h": px}}.
//
// Every 5-minute run, applyStickerArt takes up to STICKERS_PER_RUN designs whose published artwork isn't in use yet:
// it adds the PNG to the Printful file library, keeps {id, w, h, sha} in commerce_settings 'sticker_file:<design>',
// and remakes the design's sticker product with it (photo job re-queued; it waits for the catalog to show the new
// file). New stickers (expand.mjs) and the free sticker with every order (fulfillment.mjs) use it too.
// Never throws: a failure is recorded and retried on a later run.

export const STICKER_SITE = 'https://ninobattaglia.com/assets/stickers/';
export const STICKERS_PER_RUN = 3;   // each is 3 Printful calls; the free plan allows 50 subrequests per run
const MANIFEST_TTL = 3600;

const setSetting = (store, key, value) => store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);

// The design's one-piece sticker artwork in the Printful library: {id, width, height} or null.
export async function stickerFile(store, designId) {
  try {
    const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', `sticker_file:${designId}`);
    const v = row ? JSON.parse(row.value) : null;
    return v && Number.isSafeInteger(v.id) && v.w > 0 && v.h > 0 ? {id: v.id, width: v.w, height: v.h} : null;
  } catch { return null; }
}

// The published manifest, re-read at most hourly (one settings row).
export async function stickerManifest(store, now, fetcher) {
  const row = await store.first("SELECT value FROM commerce_settings WHERE key='sticker_manifest'");
  const cached = row ? JSON.parse(row.value) : null;
  if (cached && now - cached.at < MANIFEST_TTL) return cached.designs;
  const response = await fetcher(`${STICKER_SITE}manifest.json?t=${now}`, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`sticker manifest ${response.status}`);
  const designs = {};
  for (const [id, v] of Object.entries(await response.json())) {
    if (/^\d+$/.test(id) && /^[0-9a-f]{12,64}$/.test(String(v?.sha || '')) && v.w > 0 && v.h > 0) designs[id] = {sha: v.sha, w: Number(v.w), h: Number(v.h)};
  }
  await setSetting(store, 'sticker_manifest', JSON.stringify({at: now, designs}));
  return designs;
}

// deps: {api(env, method, path, body, fetcher), remake(store, env, now, designId, productId, art, fetcher)} from expand.mjs.
export async function applyStickerArt(store, env, now, deps, {fetcher = (...a) => fetch(...a), max = STICKERS_PER_RUN} = {}) {
  const out = {applied: [], errors: [], remaining: 0};
  try {
    if (!env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) return out;
    const manifest = await stickerManifest(store, now, fetcher);
    // Which artwork each design already uses: one settings row (a LIKE over all settings every 5 minutes costs D1 reads).
    const appliedRow = await store.first("SELECT value FROM commerce_settings WHERE key='sticker_applied'");
    const applied = appliedRow ? JSON.parse(appliedRow.value) : {};
    const todo = Object.entries(manifest).filter(([id, v]) => applied[id] !== v.sha);
    out.remaining = todo.length;
    for (const [designId, v] of todo.slice(0, max)) {
      try {
        const file = (await deps.api(env, 'POST', '/files', {url: `${STICKER_SITE}${designId}.png?v=${v.sha}`, filename: `sticker-${designId}-${v.sha.slice(0, 8)}.png`}, fetcher))?.result;
        if (!Number.isSafeInteger(file?.id)) throw new Error('file_no_id');
        const art = {id: file.id, width: v.w, height: v.h};
        const product = (await store.first('SELECT value FROM commerce_settings WHERE key=?', `expand:${designId}:sticker`))?.value;
        if (/^\d+$/.test(product || '')) await deps.remake(store, env, now, designId, product, art, fetcher);
        await setSetting(store, `sticker_file:${designId}`, JSON.stringify({id: file.id, w: v.w, h: v.h, sha: v.sha}));
        applied[designId] = v.sha;
        await setSetting(store, 'sticker_applied', JSON.stringify(applied));
        out.applied.push(designId);
      } catch (error) { out.errors.push(`${designId}: ${String(error?.message || error).slice(0, 200)}`); }
    }
    out.remaining -= out.applied.length;
    if (todo.length) await setSetting(store, 'sticker_last', JSON.stringify({at: now, ...out}));
  } catch (error) { out.errors.push(String(error?.message || error).slice(0, 200)); }
  return out;
}
