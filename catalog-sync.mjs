// Merge a completed Printful snapshot with the artist's curated presentation.
// Purchase eligibility continues to come exclusively from the commerce API.
function independentPhoto(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, 'https://ninobattaglia.com/');
    return url.protocol === 'https:' && !/(^|\.)(etsy|etsystatic)\.com$/i.test(url.hostname) ? value : '';
  } catch { return ''; }
}
export function storefrontProducts(existing, live, complete) {
  if (!complete) return existing;
  const curated = new Map(existing.map(product => [String(product.id), product]));
  const products = [];
  // Stage 14: the same design on other products (external_id "nx-<type>-<design product id>") isn't its own card;
  // the design's page offers it (commerce.js). Each design record lists which ones it has, for the shop to show.
  const extras = new Map();
  for (const product of live.values()) {
    const match = /^nx-([a-z]+)-(\d+)$/.exec(String(product.external_id || ''));
    if (match) { if (!extras.has(match[2])) extras.set(match[2], []); extras.get(match[2]).push(match[1]); }
  }
  for (const product of live.values()) {
    if (/^nx-[a-z]+-\d+$/.test(String(product.external_id || ''))) continue;
    const previous = curated.get(String(product.id)) || (product.external_id != null ? curated.get(String(product.external_id)) : undefined);
    const photo = independentPhoto(previous?.image) || independentPhoto(product.image);
    const record = {
      ...previous,
      id: String(product.id),
      // Older links (shirt pages, shared URLs) use the curated catalog ID or Printful's external ID.
      aliases: [previous?.id, product.external_id].filter(value => value != null && String(value) !== String(product.id)).map(String),
      title: previous?.title || String(product.title || '').replace(/\s+T$/, ''),
      image: photo || 'assets/brand-mark.webp',
      imageUnavailable: !photo,
      gallery: previous?.gallery?.some(independentPhoto) ? previous.gallery.filter(independentPhoto) : photo ? [photo] : [],
      category: previous?.category || 'Graphic tees',
      description: previous?.description || '',
      featured: previous?.featured === true
    };
    // New designs (not in catalog.json) take their swatch colors from the API's color_hex.
    if (!(Array.isArray(previous?.options?.colors) && previous.options.colors.length)) {
      const colors = [];
      for (const variant of product.variants.values()) {
        if (variant.color && variant.hex && !colors.some(color => color.name === variant.color)) colors.push({ name: variant.color, hex: variant.hex });
      }
      if (colors.length) record.options = { ...(previous?.options || {}), colors };
    }
    if (extras.has(String(product.id))) record.extras = extras.get(String(product.id)); else delete record.extras;
    delete record.price;
    const prices = [...product.variants.values()].filter(variant => variant.purchasable).map(variant => variant.price);
    if (prices.length && new Set(prices.map(price => price.currency)).size === 1) {
      record.price = prices.reduce((a, b) => a.amount < b.amount ? a : b);
    }
    products.push(record);
  }
  return products;
}
