import {HttpError} from './common.mjs';

export async function createStripeClient(env) {
  const {default:Stripe} = await import('stripe');
  const client = new Stripe(env.STRIPE_SECRET_KEY,{apiVersion:'2026-08-26.dahlia',httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:2,timeout:15000});
  return {
    createSession:(params,key) => client.checkout.sessions.create(params,{idempotencyKey:key}),
    retrieveSession:id => client.checkout.sessions.retrieve(id,{expand:['payment_intent.latest_charge']}),
    listLineItems:id => client.checkout.sessions.listLineItems(id,{limit:100,expand:['data.price.product']}),
    createCustomer:(params,key) => client.customers.create(params,{idempotencyKey:key}),
    verifyWebhook:(raw,signature,secret) => client.webhooks.constructEventAsync(raw,signature,secret,300,Stripe.createSubtleCryptoProvider())
  };
}
export class PrintfulClient {
  constructor(env,fetcher = fetch) { this.env=env; this.fetcher=fetcher; }
  async call(method,path,data) {
    const response = await this.fetcher(`https://api.printful.com${path}`,{
      method,headers:{Authorization:`Bearer ${this.env.PRINTFUL_ACCESS_TOKEN}`,'X-PF-Store-Id':this.env.PRINTFUL_STORE_ID,'Content-Type':'application/json'},
      body:data == null ? undefined : JSON.stringify(data),signal:AbortSignal.timeout(15000)
    });
    if (response.status===404) return null;
    if (!response.ok) throw new HttpError(response.status===429 ? 503 : 502,'printful_request_failed');
    const body = await response.json();
    if (body.code !== 200 && body.code !== 201) throw new HttpError(502,'printful_invalid_response');
    return body;
  }
  prefix() { return this.env.PRINTFUL_CATALOG_MODE==='store' ? '/store' : '/sync'; }
  listProducts(offset,limit) { return this.call('GET',`${this.prefix()}/products?offset=${offset}&limit=${limit}`); }
  async getProduct(id) { return (await this.call('GET',`${this.prefix()}/products/${encodeURIComponent(id)}`))?.result || null; }
  async getVariant(id) {
    const path=this.env.PRINTFUL_CATALOG_MODE==='store' ? `/store/variants/${encodeURIComponent(id)}` : `/sync/variant/${encodeURIComponent(id)}`;
    const result=(await this.call('GET',path))?.result;
    return result?.sync_variant || result || null;
  }
  async shippingRates(payload) { return (await this.call('POST','/shipping/rates',payload))?.result; }
  async findOrder(externalId) { return (await this.call('GET',`/orders/@${encodeURIComponent(externalId)}`))?.result || null; }
  async createDraft(payload) { return (await this.call('POST','/orders',payload))?.result; }
  async confirmOrder(id) { return (await this.call('POST',`/orders/${encodeURIComponent(id)}/confirm`,{}))?.result; }
}
