export class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function hash(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2,'0')).join('');
}
export function cents(value, allowZero = false) {
  if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(amount) && amount >= (allowZero ? 0 : 1) && amount <= 10000000 ? amount : null;
}
export const money = value => (value / 100).toFixed(2);
export function httpsImage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function normalizeCart(body) {
  if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) fail(400,'invalid_cart','Choose between 1 and 20 variants.');
  const seen = new Set(); let total = 0;
  const items = body.items.map(item => {
    if (!item || Object.keys(item).some(k => !['product_id','variant_id','quantity'].includes(k))) fail(400,'invalid_item_fields','Send product_id, variant_id and quantity only. Prices are calculated by the server.');
    const product = String(item.product_id ?? ''); const variant = String(item.variant_id ?? '');
    if (!/^\d{1,20}$/.test(product) || !/^\d{1,20}$/.test(variant) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) fail(400,'invalid_cart_item');
    if (seen.has(variant)) fail(400,'duplicate_variant');
    seen.add(variant); total += item.quantity;
    return {product_id:product,variant_id:variant,quantity:item.quantity};
  }).sort((a,b) => a.variant_id.localeCompare(b.variant_id));
  if (total > 50) fail(400,'quantity_limit','Choose at most 50 items per order.');
  return items;
}
export function recipient(input, countries = []) {
  if (!input || typeof input !== 'object') fail(400,'shipping_address_required');
  const out = {};
  for (const field of ['name','address1','address2','city','state_code','country_code','zip']) {
    if (input[field] != null && typeof input[field] !== 'string') fail(400,'invalid_shipping_address');
    out[field] = (input[field] || '').trim();
    if (out[field].length > (field === 'country_code' ? 2 : 150) || /[\u0000-\u001f]/.test(out[field])) fail(400,'invalid_shipping_address');
  }
  out.country_code = out.country_code.toUpperCase();
  if (!out.name || !out.address1 || !out.city || !out.zip || !/^[A-Z]{2}$/.test(out.country_code)) fail(400,'shipping_address_required');
  if (['US','AU','CA'].includes(out.country_code) && !out.state_code) fail(400,'shipping_state_required');
  if (countries.length && !countries.includes(out.country_code)) fail(400,'shipping_country_unavailable');
  return out;
}
export function stripeShipping(address) {
  return {name:address.name,address:{line1:address.address1,line2:address.address2 || undefined,city:address.city,state:address.state_code || undefined,postal_code:address.zip,country:address.country_code}};
}
export function countries(env) {
  const values = (env.SHIPPING_COUNTRIES || '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
  return values.length && values.every(v => /^[A-Z]{2}$/.test(v)) ? [...new Set(values)] : [];
}
export function shippingConfig(env) {
  const mode = env.SHIPPING_MODE; const allowed = countries(env);
  if (!['flat','free','calculated'].includes(mode) || !allowed.length) fail(503,'shipping_not_configured','Shipping has not been configured.');
  let amount = 0;
  if (mode === 'flat') {
    if (!/^\d{1,7}$/.test(env.SHIPPING_RATE_CENTS || '')) fail(503,'shipping_not_configured');
    amount = Number(env.SHIPPING_RATE_CENTS);
    if (amount <= 0 || amount > 1000000) fail(503,'shipping_not_configured');
  }
  return {mode,countries:allowed,amount,name:String(env.SHIPPING_RATE_NAME || 'Shipping').slice(0,100)};
}
export function checkoutConfiguration(env) {
  if (env.CHECKOUT_ENABLED !== 'true' || !env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.PRINTFUL_ACCESS_TOKEN || !/^\d+$/.test(env.PRINTFUL_STORE_ID || '') || !['test','live'].includes(env.STRIPE_MODE)) fail(503,'checkout_not_configured','Checkout is not available yet.');
  const shipping = shippingConfig(env);
  if (env.STRIPE_MODE === 'live' && env.FULFILLMENT_ENABLED !== 'true') fail(503,'fulfillment_not_enabled','Checkout is not available yet.');
  if (!['none','automatic'].includes(env.STRIPE_TAX_MODE) || (env.STRIPE_TAX_MODE === 'automatic' && env.STRIPE_TAX_REGISTRATION_CONFIRMED !== 'true')) fail(503,'tax_not_configured','Tax settings have not been confirmed.');
  let origin;
  try { origin = new URL(env.STOREFRONT_ORIGIN); } catch { fail(503,'origin_not_configured'); }
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') fail(503,'origin_not_configured');
  return shipping;
}
export async function requestJson(request, maximum = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415,'json_required');
  const text = await limitedText(request,maximum);
  try { return JSON.parse(text); } catch { fail(400,'invalid_json'); }
}
export async function limitedText(request,maximum) {
  const declared=Number(request.headers.get('Content-Length'));
  if(declared>maximum) fail(413,'request_too_large');
  if(!request.body) return '';
  const reader=request.body.getReader();const chunks=[];let length=0;
  try {
    while(true){
      const next=await reader.read();if(next.done)break;
      length+=next.value.byteLength;
      if(length>maximum){await reader.cancel();fail(413,'request_too_large');}
      chunks.push(next.value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(bytes);
}
