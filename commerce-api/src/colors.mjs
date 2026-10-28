// Garment color swatches for the storefront.
//
// The curated catalog.json carries a hex code per color for the original 136 shirts. Designs added later
// (copied from NinosTs by the mirror job) only arrive through the API, so the API attaches `color_hex` to
// each variant from this palette. The palette starts from the curated colors and the daily cron fills any
// color name it doesn't know from Printful's own catalog color codes.

export const PALETTE_KEY = 'color_palette';
const HEX = /^#[0-9a-f]{6}$/;

// Colors used across catalog.json (most common hex per name, Oct 28, 2026).
export const SEED_PALETTE = Object.freeze({
  'Ash':'#f3f3f3','Azalea':'#ff98c6','Black':'#141313','Brown Savana':'#9f8971','Cardinal':'#c21b3a',
  'Carolina Blue':'#96bbff','Charcoal':'#6a6967','Daisy':'#ffc946','Dark Chocolate':'#463b33',
  'Dark Heather':'#595959','Forest Green':'#1a3b23','Gold':'#ffb22d','Graphite Heather':'#858585',
  'Heliconia':'#e33f7a','Ice Grey':'#e9dddc','Irish Green':'#00ba69','Light Blue':'#d9efff',
  'Light Pink':'#ffd4d5','Lime':'#a3e05a','Maroon':'#47001b','Military Green':'#737a5f','Natural':'#e8dacd',
  'Navy':'#1a2330','Orange':'#ff5f2e','Purple':'#48197d','Red':'#d80019','Royal':'#175ac7','Sand':'#d6c0ab',
  'Sapphire':'#007ab3','Sky':'#8ee0ff','Sport Grey':'#c4c0be','Tropical Blue':'#00a0b3','Turf Green':'#187532',
  'White':'#fffefa','Yellow Haze':'#ffd99c'
});

export function normalizeHex(value) {
  const hex = String(value || '').trim().toLowerCase();
  return HEX.test(hex) ? hex : null;
}

export async function loadPalette(store) {
  let stored = {};
  try { stored = JSON.parse((await store.first('SELECT value FROM commerce_settings WHERE key=?', PALETTE_KEY))?.value || '{}'); } catch { stored = {}; }
  const palette = { ...SEED_PALETTE };
  for (const [name, hex] of Object.entries(stored)) { const clean = normalizeHex(hex); if (clean) palette[name] = clean; }
  return palette;
}

// Daily: for each color in the live catalog with no hex yet, ask Printful for that catalog variant's color
// code, then read the whole garment's color list once so its other colors are known too. A few calls a day
// at most, and none once every color is known.
export async function refreshPalette(store, printful, limit = 5) {
  const generation = await store.activeGeneration();
  if (!generation) return { added: [] };
  const palette = await loadPalette(store);
  const rows = await store.all(`SELECT json_extract(snapshot_json,'$.color') AS color, MIN(json_extract(snapshot_json,'$.catalog_variant_id')) AS catalog_variant_id
    FROM catalog_variants WHERE generation=? GROUP BY color`, generation);
  const missing = rows.filter(row => row.color && row.catalog_variant_id && !palette[row.color]).slice(0, limit);
  const added = []; const seenProducts = new Set();
  for (const row of missing) {
    if (palette[row.color]) continue;
    const found = await printful.call('GET', `/products/variant/${encodeURIComponent(row.catalog_variant_id)}`);
    const variant = found?.result?.variant; const productId = variant?.product_id || found?.result?.product?.id;
    const own = normalizeHex(variant?.color_code);
    if (own && variant?.color === row.color) { palette[row.color] = own; added.push(row.color); }
    if (productId && !seenProducts.has(productId)) {
      seenProducts.add(productId);
      const garment = await printful.call('GET', `/products/${encodeURIComponent(productId)}`);
      for (const item of garment?.result?.variants || []) {
        const hex = normalizeHex(item.color_code);
        if (item.color && hex && !palette[item.color]) { palette[item.color] = hex; added.push(item.color); }
      }
    }
  }
  if (added.length) {
    const learned = Object.fromEntries(Object.entries(palette).filter(([name, hex]) => SEED_PALETTE[name] !== hex));
    await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', PALETTE_KEY, JSON.stringify(learned));
  }
  return { added: [...new Set(added)] };
}
