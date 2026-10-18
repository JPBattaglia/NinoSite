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
  for (const product of live.values()) {
    const previous = curated.get(String(product.id)) || (product.external_id != null ? curated.get(String(product.external_id)) : undefined);
    const photo = independentPhoto(previous?.image) || independentPhoto(product.image);
    const record = {
      ...previous,
      id: String(product.id), title: product.title,
      image: photo || 'assets/brand-mark.webp',
      imageUnavailable: !photo,
      gallery: previous?.gallery?.some(independentPhoto) ? previous.gallery.filter(independentPhoto) : photo ? [photo] : [],
      category: previous?.category || 'Graphic tees',
      description: previous?.description || '',
      featured: previous?.featured === true
    };
    delete record.price;
    const prices = [...product.variants.values()].filter(variant => variant.purchasable).map(variant => variant.price);
    if (prices.length && new Set(prices.map(price => price.currency)).size === 1) {
      record.price = prices.reduce((a, b) => a.amount < b.amount ? a : b);
    }
    products.push(record);
  }
  return products;
}
