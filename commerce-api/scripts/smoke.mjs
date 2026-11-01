// Read-only health check of the live shop. It only issues GET requests: it never starts a checkout, never contacts
// Stripe or Printful, and never creates an order. Run after every deploy and daily:
//   node scripts/smoke.mjs            (uses the default URLs below)
//   API_BASE=https://... SITE_BASE=https://... MIN_PRODUCTS=100 node scripts/smoke.mjs
import {pathToFileURL} from 'node:url';

export const DEFAULTS = Object.freeze({
  api: 'https://nino-printful-commerce-api.ijpbattaglia.workers.dev',
  site: 'https://ninobattaglia.com',
  minProducts: 100,
  blocked: ['CU', 'IR', 'KP', 'SY']
});

export async function runSmoke(fetcher = fetch, options = {}) {
  const config = {...DEFAULTS, ...options};
  const results = [];
  const check = async (name, work) => {
    try {
      const detail = await work();
      results.push({name, ok: true, detail: detail || ''});
    } catch (error) {
      results.push({name, ok: false, detail: error.message});
    }
  };
  const getJson = async url => {
    const response = await fetcher(url, {headers: {Accept: 'application/json'}});
    if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  await check('API health', async () => {
    const health = await getJson(`${config.api}/api/health`);
    expect(health.ok === true, 'database check failed');
    return `payment mode ${health.payment_mode}`;
  });
  if (!config.skipSelfCheck) await check('Daily payment and fulfilment self-check passed', async () => {
    const health = await getJson(`${config.api}/api/health`);
    const result = health.selfcheck;
    expect(result, 'the self-check has not run yet');
    const age = Math.round((Date.now() / 1000 - result.checked_at) / 3600);
    expect(age <= 26, `the self-check last ran ${age} hours ago`);
    expect(result.ok === true, `failed: ${(result.failed || []).join('; ')} (details: GET /api/admin/selfcheck)`);
    return `ran ${age} hours ago`;
  });
  await check('Checkout is ready and only offers allowed countries', async () => {
    const conf = await getJson(`${config.api}/api/commerce-config`);
    expect(conf.catalog_ready === true, 'catalog is not ready');
    expect(conf.checkout_ready === true, 'checkout is not ready');
    expect(Array.isArray(conf.shipping_countries) && conf.shipping_countries.length > 0, 'no shipping countries offered');
    const offered = conf.shipping_countries.filter(code => config.blocked.includes(code));
    expect(!offered.length, `embargoed countries offered: ${offered.join(', ')}`);
    return `${conf.shipping_countries.length} countries`;
  });
  let products = [];
  await check('Catalog has every design purchasable', async () => {
    const data = await getJson(`${config.api}/api/products`);
    products = data.products || [];
    expect(products.length >= config.minProducts, `only ${products.length} products (expected at least ${config.minProducts})`);
    const unavailable = products.filter(product => !product.variants?.some(variant => variant.available)).map(product => product.title);
    expect(!unavailable.length, `no available variant: ${unavailable.slice(0, 5).join(', ')}`);
    const noImage = products.filter(product => !product.image).map(product => product.title);
    expect(!noImage.length, `no image: ${noImage.slice(0, 5).join(', ')}`);
    return `${products.length} products`;
  });
  await check('Product photos load', async () => {
    const remote = products.map(product => product.image).filter(image => /^https:/.test(image || ''));
    const sample = [remote[0], remote[Math.floor(remote.length / 2)], remote[remote.length - 1]].filter(Boolean);
    for (const image of sample) {
      const response = await fetcher(image);
      expect(response.status === 200 && /^image\//.test(response.headers.get('content-type') || ''), `${image} answered ${response.status}`);
    }
    return `${sample.length} sampled`;
  });
  // Email signup (subscribers.mjs), checked without sending mail: bad links are refused and pages carry the form.
  await check('Email signup links answer and the form is on the site', async () => {
    const unsub = await fetcher(`${config.api}/api/unsubscribe?t=smoke`);
    expect(unsub.status === 400, `unsubscribe with a bad link answered ${unsub.status}`);
    const confirm = await fetcher(`${config.api}/api/subscribe/confirm?t=smoke`, {redirect: 'manual'});
    expect(confirm.status === 303 && /signup=expired/.test(confirm.headers.get('location') || ''), `confirm with a bad link answered ${confirm.status}`);
    const home = await fetcher(`${config.site}/index.html`);
    expect(home.status === 200 && /signup\.js/.test(await home.text()), 'the home page has no signup form script');
    const script = await fetcher(`${config.site}/signup.js`);
    expect(script.status === 200, `signup.js answered ${script.status}`);
  });
  for (const page of ['shop.html', 'cart.html', 'quiz.html', 'catalog.json']) {
    await check(`Site serves ${page}`, async () => {
      const response = await fetcher(`${config.site}/${page}`);
      expect(response.status === 200, `${page} answered ${response.status}`);
    });
  }
  return results;
}

async function main() {
  const options = {};
  if (process.env.API_BASE) options.api = process.env.API_BASE.replace(/\/$/, '');
  if (process.env.SITE_BASE) options.site = process.env.SITE_BASE.replace(/\/$/, '');
  if (process.env.MIN_PRODUCTS) options.minProducts = Number(process.env.MIN_PRODUCTS);
  if (process.env.SKIP_SELFCHECK === '1') options.skipSelfCheck = true;
  // A fresh deploy can take a few seconds to answer everywhere, so a failing run is repeated before it counts.
  let results;
  for (let attempt = 1; attempt <= 3; attempt++) {
    results = await runSmoke(fetch, options);
    if (results.every(result => result.ok)) break;
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 10000));
  }
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  const failed = results.filter(result => !result.ok);
  if (failed.length) {
    for (const result of failed) console.log(`::error title=Smoke test failed::${result.name}: ${result.detail}`);
    process.exit(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
