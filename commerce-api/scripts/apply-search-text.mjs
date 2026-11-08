// Search-friendly page titles and descriptions for every shirt page (shirts/<slug>.html), from catalog.json and
// search-phrases.json. The visible page (headline, copy) is untouched; only <title>, meta description, og:title,
// og:description and the Product JSON-LD description change. Safe to run again: it rewrites the same tags.
//   node commerce-api/scripts/apply-search-text.mjs            (run daily by .github/workflows/product-feed.yml)
import {readFile, writeFile, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plain = s => String(s ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function searchText(product, phrase) {
  const name = plain(product.title);
  const about = plain(product.description).replace(/([^.!?])$/, '$1.');
  const lead = plain(phrase) || (product.category === 'Seasonal' ? 'Holiday Graphic' : 'Graphic');
  const title = `${lead} T-Shirt – ${name} | Nino Battaglia`;
  const description = `${lead} t-shirt: ${about} Unisex tee by San Francisco artist Nino Battaglia, printed to order. Free sticker with every order.`.slice(0, 300);
  return {title, description};
}

export function rewrite(html, {title, description}) {
  const t = esc(title), d = esc(description);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
}

async function main() {
  const products = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8')).products;
  const phrases = JSON.parse(await readFile(path.join(root, 'commerce-api/scripts/search-phrases.json'), 'utf8'));
  let changed = 0, missing = [];
  for (const product of products) {
    const file = path.join(root, 'shirts', `${product.slug}.html`);
    try { await access(file); } catch { continue; }
    if (!phrases[String(product.id)]) missing.push(product.title);
    const before = await readFile(file, 'utf8');
    const after = rewrite(before, searchText(product, phrases[String(product.id)]));
    if (after !== before) { await writeFile(file, after); changed++; }
  }
  console.log(`Shirt pages updated: ${changed}.${missing.length ? ` No search phrase yet (category used): ${missing.join(', ')}` : ''}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
