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
import {etsyRoute,ensureEtsyLink,runEtsy} from './etsy.mjs';

export * from './worker.mjs';

// Etsy listing tools for NinosTs (etsy.mjs, owner Nov 24, 2026): the owner's one-time connect page, status and
// listings, answered before the shop's own routes; each scheduled run emails the connect link once, renews the
// Etsy access and applies queued listing changes. Neither can block the shop.
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/etsy/') && env.DB) {
      try { const response=await etsyRoute(request,url,new Store(env.DB),env,nowSeconds(),ctx); if(response) return response; }
      catch { return Response.json({error:'service_error'},{status:500,headers:{'Cache-Control':'no-store'}}); }
    }
    return app.fetch(request,env,ctx);
  },
  async scheduled(event,env,ctx) {
    if(env.DB) ctx.waitUntil((async()=>{ try { const store=new Store(env.DB); await ensureEtsyLink(store,env); await runEtsy(store,env,nowSeconds()); } catch { /* never blocks the shop */ } })());
    return app.scheduled(event,env,ctx);
  }
};

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
