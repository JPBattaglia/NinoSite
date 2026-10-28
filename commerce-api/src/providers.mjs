import {HttpError,stripeConfiguration} from './common.mjs';

export async function createStripeClient(env) {
  stripeConfiguration(env);
  const {default:Stripe} = await import('stripe');
  const client = new Stripe(env.STRIPE_SECRET_KEY,{apiVersion:'2026-08-26.dahlia',httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:2,timeout:15000});
  return {
    createSession:(params,key) => client.checkout.sessions.create(params,{idempotencyKey:key}),
    retrieveSession:id => client.checkout.sessions.retrieve(id,{expand:['payment_intent.latest_charge']}),
    listLineItems:id => client.checkout.sessions.listLineItems(id,{limit:100,expand:['data.price.product']}),
    createCustomer:(params,key) => client.customers.create(params,{idempotencyKey:key}),
    retrieveAccount:() => client.accounts.retrieveCurrent(),
    listWebhookEndpoints:() => client.webhookEndpoints.list({limit:100}),
    listEvents:params => client.events.list(params),
    verifyWebhook:(raw,signature,secret) => client.webhooks.constructEventAsync(raw,signature,secret,300,Stripe.createSubtleCryptoProvider())
  };
}
export class PrintfulClient {
  constructor(env,fetcher = (...args) => fetch(...args)) { this.env=env; this.fetcher=fetcher; }
  async call(method,path,data) {
    // Workers reject fetch invoked as a method of another object (Illegal invocation).
    const fetcher = this.fetcher;
    const response = await fetcher(`https://api.printful.com${path}`,{
      method,headers:{Authorization:`Bearer ${this.env.PRINTFUL_ACCESS_TOKEN}`,'X-PF-Store-Id':this.env.PRINTFUL_STORE_ID,'Content-Type':'application/json'},
      body:data == null ? undefined : JSON.stringify(data),signal:AbortSignal.timeout(15000)
    });
    if (response.status===404) return null;
    if (!response.ok) {
      // Keep Printful's own reason (e.g. a missing token scope or a bad address) so fulfillment can record it.
      let reason=''; try { const body=await response.json(); reason=String(body?.error?.message || body?.result || body?.message || '').slice(0,200); } catch {}
      throw new HttpError(response.status===429 ? 503 : 502,'printful_request_failed',`${method} ${path.replace(/\/@?[^/]*$/,m=>m.length>12?'/…':m)} ${response.status}${reason?': '+reason:''}`);
    }
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
  async getCountries() { return (await this.call('GET','/countries'))?.result; }
  async shippingRates(payload) { return (await this.call('POST','/shipping/rates',payload))?.result; }
  async findOrder(externalId) { return (await this.call('GET',`/orders/@${encodeURIComponent(externalId)}`))?.result || null; }
  async createDraft(payload) { return (await this.call('POST','/orders',payload))?.result; }
  async deleteOrder(id) { return (await this.call('DELETE',`/orders/${encodeURIComponent(id)}`))?.result; }
  async confirmOrder(id) { return (await this.call('POST',`/orders/${encodeURIComponent(id)}/confirm`,{}))?.result; }
}
