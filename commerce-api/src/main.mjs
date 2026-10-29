// Deployed entry module for nino-printful-commerce-api (wrangler.jsonc "main").
// worker.mjs stays importable by the Node tests; this file adds what only runs on Cloudflare.
import {WorkerEntrypoint} from 'cloudflare:workers';
import app from './worker.mjs';
import {Store} from './db.mjs';
import {PrintfulClient} from './providers.mjs';
import {nowSeconds} from './common.mjs';
import {merchCall,merchQuote,placeMerchOrder,merchOrderStatus,deleteMerchDraft,merchSample} from './merch.mjs';

export * from './worker.mjs';
export default app;

// Staff merch for Menu-made (merch.mjs). Reachable only through Menu-made's service binding to this named
// entrypoint; named entrypoints have no public route, so nothing on the internet can call these.
export class NinoMerch extends WorkerEntrypoint {
  deps() {
    if(!this.env.DB) throw new Error('database_not_configured');
    return {store:new Store(this.env.DB),printful:new PrintfulClient(this.env),env:this.env,now:nowSeconds()};
  }
  quote(args) { return merchCall(merchQuote,args,this.deps()); }
  placeOrder(args) { return merchCall(placeMerchOrder,args,this.deps()); }
  orderStatus(args) { return merchCall(merchOrderStatus,args,this.deps()); }
  deleteDraft(args) { return merchCall(deleteMerchDraft,args,this.deps()); }
  sample(args) { return merchCall(merchSample,args || {},this.deps()); }
}
