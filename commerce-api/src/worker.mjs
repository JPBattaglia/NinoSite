import {subscribe,confirmSubscription,unsubscribe,subscriberCounts} from './subscribers.mjs';
import {recordMeasurement,measurementReport} from './measurement.mjs';
import {Store} from './db.mjs';
import {resolveShippingCountries} from './countries.mjs';
import {HttpError,fail,hash,requestJson,limitedText,checkoutConfiguration,stripeConfiguration,countries,nowSeconds} from './common.mjs';
import {createStripeClient,PrintfulClient} from './providers.mjs';
import {publicCatalog,startCatalogSync,continueCatalogSync,pruneCatalogHistory} from './catalog.mjs';
// Must match the daily entry in wrangler.jsonc `triggers.crons`.
export const DAILY_CRON='0 10 * * *';
// How long a built /api/products response is shared at the edge (see the /api/products route).
export const PRODUCTS_EDGE_TTL=1800;
import {shippingQuote,createCheckout} from './checkout.mjs';
import {runPrintfulProbes} from './probe.mjs';
import {refreshPalette} from './colors.mjs';
import {sendOrderEmails} from './emails.mjs';
import {runSelfCheck,lastSelfCheck,SELFCHECK_RUN_NOW} from './selfcheck.mjs';
import {processMockups,serveMockup} from './mockups.mjs';
import {catalogSnapshot,refreshCatalogSnapshot,readinessCatalog,withReadiness} from './catalog-snapshot.mjs';
import {runMirror} from './mirror.mjs';
import {runExpansion,api as printfulApi,remakeSticker} from './expand.mjs';
import {applyStickerArt} from './sticker-art.mjs';
import {refusedKey,alertRefusedKey} from './key-alert.mjs';
import {withPrintfulTokens,renewPrintfulTokens,connectRedirect,connectCallback,connectionStatus} from './printful-auth.mjs';
import {stripeWebhook,fulfillOrder} from './fulfillment.mjs';

const JSON_HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const productBodies=new WeakMap();
function json(value,status=200,headers={}) {
  return Response.json(value,{status,headers:{...JSON_HEADERS,...headers}});
}
async function admin(request,env) {
  if(!env.ADMIN_API_TOKEN) fail(503,'admin_not_configured');
  const supplied=request.headers.get('Authorization') || '';
  const a=await hash(supplied); const b=await hash(`Bearer ${env.ADMIN_API_TOKEN}`);
  let mismatch=0; for(let i=0;i<a.length;i++) mismatch|=a.charCodeAt(i)^b.charCodeAt(i);
  if(mismatch) fail(401,'unauthorized');
}
function syncSummary(run) { return {sync_id:run.id,status:run.status,processed:run.cursor,total:JSON.parse(run.product_ids_json).length,last_error:run.last_error}; }
function commerceReadiness(env,catalog) {
  let ready=true;
  try { checkoutConfiguration(env); } catch { ready=false; }
  return {checkout_ready:ready && catalog.catalog_ready && catalog.products.some(product=>product.variants.some(variant=>variant.available)),shipping_mode:env.SHIPPING_MODE || null,shipping_countries:countries(env)};
}


async function publicReadiness(env,catalog,store,printful,now) {
  try {
    const shippingEnv=await resolveShippingCountries(env,store,printful,now);
    return commerceReadiness(shippingEnv,catalog);
  } catch(error) {
    if(error instanceof HttpError && error.code==='shipping_countries_unavailable') return {checkout_ready:false,shipping_mode:env.SHIPPING_MODE || null,shipping_countries:[]};
    throw error;
  }
}

export function createApp(dependencies={}) {
  const clock=dependencies.now || nowSeconds;
  const stripeFactory=dependencies.stripeFactory || createStripeClient;
  const gateways=async env=>({stripe:dependencies.stripe || await stripeFactory(env),printful:dependencies.printful || new PrintfulClient(env)});
  return {
    async fetch(request,env,ctx) {
      const url=new URL(request.url); const origin=request.headers.get('Origin');
      const publicRead=request.method==='GET' && ['/api/products','/api/commerce-config','/api/health'].includes(url.pathname);
      const cors=publicRead ? {'Access-Control-Allow-Origin':'*'} : origin===env.STOREFRONT_ORIGIN ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Idempotency-Key, Authorization'} : {};
      try {
        if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
        if(!env.DB) fail(503,'database_not_configured');
        const store=new Store(env.DB); const now=clock();
        // Self-renewing Printful connection (printful-auth.mjs): the owner's one-time connect links.
        if(request.method==='GET' && url.pathname==='/api/printful/connect') return await connectRedirect(env,url.searchParams.get('store'),now);
        if(request.method==='GET' && url.pathname==='/api/printful/callback') return await connectCallback(env,store,url,now);
        const mockup=request.method==='GET' && url.pathname.match(/^\/api\/mockups\/(\d+)\/([a-z0-9-]+)\.jpg$/);
        if(mockup) {
          const cache=globalThis.caches?.default; const cached=cache && await cache.match(request);
          if(cached) return cached;
          const response=await serveMockup(env,mockup[1],mockup[2]);
          if(!response) return new Response('Not found',{status:404,headers:{'Access-Control-Allow-Origin':'*'}});
          if(cache) ctx?.waitUntil?.(cache.put(request,response.clone()));
          return response;
        }
        // Email signup (subscribers.mjs): double opt-in; needs no Printful token.
        if(request.method==='POST' && url.pathname==='/api/subscribe') return json(await subscribe(request,store,env,now),200,cors);
        if(request.method==='GET' && url.pathname==='/api/subscribe/confirm') return await confirmSubscription(url,store,env,now);
        if(['GET','POST'].includes(request.method) && url.pathname==='/api/unsubscribe') return await unsubscribe(request,url,store,env,now);
        // From here on, Printful calls use the app's live token where the app is connected, else the private key.
        env=await withPrintfulTokens(env,store,now);
        if(request.method==='GET' && url.pathname==='/api/health') {
          const row=await store.first('SELECT 1 AS ok');
          const check=await lastSelfCheck(store);
          const selfcheck=check ? {ok:check.ok===true,checked_at:check.checked_at,failed:(check.checks || []).filter(item=>!item.ok).map(item=>item.name)} : null;
          const printful_connection=await connectionStatus(store,env,now).catch(()=>null);
          return json({ok:row?.ok===1,payment_mode:env.STRIPE_MODE || 'unconfigured',selfcheck,printful_connection},200,cors);
        }
        if(request.method==='GET' && url.pathname==='/api/products') {
          // Served from the stored catalog body (catalog-snapshot.mjs): two single-row reads and one KV read per visit.
          // Checkout never trusts this copy: validatedLines re-reads current prices and availability from D1.
          const snap=await catalogSnapshot(store,env,now,url.origin);
          const readiness=await publicReadiness(env,readinessCatalog(snap.meta),store,dependencies.printful || new PrintfulClient(env),now);
          return new Response(withReadiness(snap.body,readiness),{status:200,headers:{'Content-Type':'application/json; charset=utf-8',...JSON_HEADERS,...cors}});
        }
        if(request.method==='GET' && url.pathname==='/api/commerce-config') {
          const snap=await catalogSnapshot(store,env,now,url.origin);
          const readiness=await publicReadiness(env,readinessCatalog(snap.meta),store,dependencies.printful || new PrintfulClient(env),now);
          return json({...readiness,catalog_ready:snap.meta.ready,currency:'usd',max_quantity:10,max_cart_quantity:50,max_variants:20,payment_mode:env.STRIPE_MODE || null},200,cors);
        }
        if(request.method==='POST' && url.pathname==='/api/measurement') return json(await recordMeasurement(request,store,env,now),200,cors);
        if(request.method==='POST' && url.pathname==='/api/webhooks/stripe') {
          stripeConfiguration(env,true);
          const raw=await limitedText(request,1048576);
          const {stripe,printful}=await gateways(env);
          return json(await stripeWebhook(raw,request.headers.get('Stripe-Signature'),store,stripe,printful,env,now,ctx));
        }
        if(request.method==='POST' && ['/api/checkout','/api/shipping-quotes'].includes(url.pathname)) {
          if(origin!==env.STOREFRONT_ORIGIN) fail(403,'origin_not_allowed');
          stripeConfiguration(env);
          const printful=dependencies.printful || new PrintfulClient(env);
          const shippingEnv=await resolveShippingCountries(env,store,printful,now);
          checkoutConfiguration(shippingEnv);
          const body=await requestJson(request);
          const stripe=url.pathname==='/api/checkout' ? dependencies.stripe || await stripeFactory(shippingEnv) : null;
          const result=url.pathname==='/api/checkout' ? await createCheckout(body,request,store,stripe,printful,shippingEnv,now) : await shippingQuote(body,store,printful,shippingEnv,now);
          return json(result,200,cors);
        }
        const receipt=url.pathname.match(/^\/api\/orders\/(ord_[a-f0-9]{24})$/);
        if(request.method==='GET' && receipt) {
          const order=await store.order(receipt[1]);
          if(!order || !url.searchParams.get('token') || url.searchParams.get('token')!==order.receipt_token) fail(404,'order_not_found');
          return json({order_id:order.id,payment_status:order.payment_status,fulfillment_status:order.fulfillment_status,total_cents:order.paid_total_cents,currency:'usd'},200,cors);
        }
        if(url.pathname.startsWith('/api/admin/')) {
          await admin(request,env);
          if(request.method==='GET' && url.pathname==='/api/admin/measurement') return json(await measurementReport(store,now),200,cors);
          if(request.method==='GET' && url.pathname==='/api/admin/subscribers') return json(await subscriberCounts(store),200,cors);
          if(request.method==='GET' && url.pathname==='/api/admin/selfcheck') return json(await lastSelfCheck(store),200,cors);
          const printful=dependencies.printful || new PrintfulClient(env);
          if(request.method==='POST' && url.pathname==='/api/admin/catalog/sync') {
            if(!env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) fail(503,'printful_not_configured');
            const run=await startCatalogSync(store,printful,now);
            return json(await continueCatalogSync(store,printful,run.id,now),200,cors);
          }
          const sync=url.pathname.match(/^\/api\/admin\/catalog\/sync\/([a-zA-Z0-9-]+)$/);
          if(sync) {
            const run=await store.first('SELECT * FROM catalog_sync_runs WHERE id=?',sync[1]);
            if(!run) fail(404,'sync_not_found');
            if(request.method==='GET') return json(syncSummary(run),200,cors);
            if(request.method==='POST') return json(await continueCatalogSync(store,printful,run.id,now),200,cors);
          }
          const retry=url.pathname.match(/^\/api\/admin\/orders\/(ord_[a-f0-9]{24})\/retry$/);
          if(request.method==='POST' && retry) {
            const lock=await store.run("UPDATE commerce_orders SET fulfillment_status='retry',fulfillment_attempts=0,next_retry_at=0,last_error=NULL,updated_at=? WHERE id=? AND payment_status='paid' AND live_mode=1 AND fulfillment_status IN ('retry','review','draft') AND lease_until<=?",now,retry[1],now);
            if(!lock.meta.changes) fail(409,'order_not_retryable');
            const {stripe}=await gateways(env);
            return json(await fulfillOrder(retry[1],store,stripe,printful,env,now),200,cors);
          }
          if(request.method==='GET' && url.pathname==='/api/admin/orders') {
            const orders=await store.all('SELECT id,payment_status,fulfillment_status,paid_total_cents,printful_order_id,last_error,fulfillment_attempts,created_at,updated_at FROM commerce_orders ORDER BY created_at DESC LIMIT 100');
            return json({orders},200,cors);
          }
        }
        return json({error:'not_found'},404,cors);
      } catch(error) {
        const known=error instanceof HttpError;
        const status=known?error.status:500;
        return json({error:known?error.code:'service_error',message:known?error.message:'The request could not be completed. Please try again.'},status,{...cors,...(status===503?{'Retry-After':'30'}:{})});
      }
    },
    async scheduled(event,env,ctx) {
      if(!env.DB) return;
      const run=async()=>{
        const store=new Store(env.DB); const now=clock();
        const daily=event.cron===DAILY_CRON;
        if(daily) await store.run('DELETE FROM shopping_measurement WHERE day<?',new Date((now-89*86400)*1000).toISOString().slice(0,10));
        if(daily) await pruneCatalogHistory(store,now);
        // Renew the Printful app's hourly access first, then run everything below on it (private keys as fallback).
        try { await renewPrintfulTokens(store,env,now); } catch { /* falls back to the private keys */ }
        env=await withPrintfulTokens(env,store,now);
        if(!env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) return;
        try { await runPrintfulProbes(store,env,now); } catch { /* research helper must never block sync or fulfillment */ }
        try { await processMockups(store,env,now); } catch { /* model photos must never block sync or fulfillment */ }
        const printful=dependencies.printful || new PrintfulClient(env);
        // New designs made in the source Printful store are copied into the website store before the daily sync,
        // so the same sync publishes them. The owner can also trigger it by setting commerce_settings 'mirror_run_now'.
        let mirrored={created:[]};
        try {
          const requested=await store.first("SELECT value FROM commerce_settings WHERE key='mirror_run_now'");
          if(requested) await store.run("DELETE FROM commerce_settings WHERE key='mirror_run_now'");
          if(daily || requested) mirrored=await runMirror(store,env,now,{destination:printful});
          if(mirrored?.errors?.some(refusedKey)) await alertRefusedKey(store,env,'source',now);
        } catch { /* copying new designs must never block sync or fulfillment */ }
        // Stage 14: the same designs on more products (expand.mjs), a few per run, only while a sync isn't running;
        // when a batch finishes, a sync publishes it.
        let expanded={created:[],remaining:0};
        let sync=await store.first("SELECT * FROM catalog_sync_runs WHERE status='running'");
        // One-piece sticker artwork (sticker-art.mjs): remade stickers need a sync before checkout accepts them again.
        // Not held back by a running sync (a full sync takes ~40 runs); the next sync picks the remade stickers up.
        let stickers={applied:[]};
        try { stickers=await applyStickerArt(store,env,now,{api:printfulApi,remake:remakeSticker}); } catch { /* never blocks sync or fulfillment */ }
        // The rollout (owner, Nov 1: don't sit idle during syncs). While a sync runs, a run does the rollout only when
        // the sticker step had nothing to do, so the run stays inside the free plan's 50 database queries.
        if(!sync || !stickers.applied?.length) {
          try { expanded=await runExpansion(store,env,now); } catch { /* never blocks sync or fulfillment */ }
          if(expanded.errors?.some(refusedKey)) await alertRefusedKey(store,env,'shop',now);
        }
        const expansionReady=expanded.created?.length>0 && expanded.remaining===0;
        if(!sync && (daily || mirrored.created?.length || mirrored.ignored?.length || expansionReady || stickers.applied?.length)) sync=await startCatalogSync(store,printful,now);
        if(sync) { try { await continueCatalogSync(store,printful,sync.id,now); } catch(error) { /* The retained run is retried by the next scheduled invocation. */ if(refusedKey(error)) await alertRefusedKey(store,env,'shop',now); } }
        // Keep the stored product list current (a finished sync right away, new model photos at most hourly).
        try { await refreshCatalogSnapshot(store,env,now); } catch { /* visitors then rebuild it once */ }
        // New garment colors get a swatch hex from Printful's catalog (only names not yet known).
        if(daily) { try { await refreshPalette(store,printful); } catch { /* swatches fall back to color names */ } }
        if(env.FULFILLMENT_ENABLED==='true' && env.STRIPE_MODE==='live' && env.STRIPE_SECRET_KEY) {
          const orders=await store.all("SELECT id FROM commerce_orders WHERE payment_status='paid' AND live_mode=1 AND fulfillment_status IN ('queued','retry','processing','draft') AND lease_until<=? AND next_retry_at<=? AND fulfillment_attempts<10 ORDER BY created_at LIMIT 3",now,now);
          if(orders.length) {
            const stripe=dependencies.stripe || await createStripeClient(env);
            for(const order of orders) await fulfillOrder(order.id,store,stripe,printful,env,now);
          }
        }
        // Order emails that failed to send (mailer briefly unavailable) are retried for two days.
        if(env.MAILER) {
          try {
            const unsent=await store.all("SELECT o.id FROM commerce_orders o WHERE o.payment_status='paid' AND o.live_mode=1 AND o.fulfillment_status IN ('confirmed','review') AND o.updated_at>? AND NOT EXISTS (SELECT 1 FROM commerce_settings s WHERE s.key IN ('order_email:'||o.id||':owner','order_email:'||o.id||':owner_review')) LIMIT 3",now-2*86400);
            for(const row of unsent) await sendOrderEmails(store,env,row.id,now);
          } catch { /* retried on the next run */ }
        }
        // Daily self-check of the live payment and fulfilment setup (see selfcheck.mjs); also on request.
        try {
          const requested=await store.first('SELECT value FROM commerce_settings WHERE key=?',SELFCHECK_RUN_NOW);
          if(requested) await store.run('DELETE FROM commerce_settings WHERE key=?',SELFCHECK_RUN_NOW);
          if((daily || requested) && env.STRIPE_SECRET_KEY) await runSelfCheck(store,dependencies.stripe || await createStripeClient(env),printful,env,now);
        } catch(error) { console.error('shop self-check could not run',error?.message || error); }
      };
      if(ctx?.waitUntil) ctx.waitUntil(run()); else await run();
    }
  };
}
export default createApp();
