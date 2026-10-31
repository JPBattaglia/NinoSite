// Deployed entry module for nino-printful-commerce-api (wrangler.jsonc "main").
// worker.mjs stays importable by the Node tests; this file adds what only runs on Cloudflare.
import {WorkerEntrypoint} from 'cloudflare:workers';
import app from './worker.mjs';
import {Store} from './db.mjs';
import {PrintfulClient} from './providers.mjs';
import {nowSeconds} from './common.mjs';
import {merchCall,merchQuote,placeMerchOrder,merchOrderStatus,deleteMerchDraft,merchSample} from './merch.mjs';
import {logoProducts} from './merch-products.mjs';
import {withPrintfulTokens} from './printful-auth.mjs';

export * from './worker.mjs';
export default app;

// Staff merch for Menu-made (merch.mjs). Reachable only through Menu-made's service binding to this named
// entrypoint; named entrypoints have no public route, so nothing on the internet can call these.
export class NinoMerch extends WorkerEntrypoint {
  // The Printful app's live token where connected (printful-auth.mjs), else the private key.
  async deps() {
    if(!this.env.DB) throw new Error('database_not_configured');
    const store=new Store(this.env.DB), now=nowSeconds();
    const env=await withPrintfulTokens(this.env,store,now);
    return {store,printful:new PrintfulClient(env),env,now};
  }
  async quote(args) { return merchCall(merchQuote,args,await this.deps()); }
  async placeOrder(args) { return merchCall(placeMerchOrder,args,await this.deps()); }
  async orderStatus(args) { return merchCall(merchOrderStatus,args,await this.deps()); }
  async deleteDraft(args) { return merchCall(deleteMerchDraft,args,await this.deps()); }
  async products() { const d=await this.deps(); return merchCall(()=>logoProducts(d.store,d.env,d.now),{},d); }
  async sample(args) { return merchCall(merchSample,args || {},await this.deps()); }
}
