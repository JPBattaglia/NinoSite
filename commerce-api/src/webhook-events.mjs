// The shop's Stripe webhook must send checkout.session.expired for the one abandoned-checkout reminder (emails.mjs).
// Rather than ask the owner to tick it in the Stripe dashboard, the scheduled run adds it once with the shop's own
// Stripe key, keeping every event already on the endpoint. Recorded in commerce_settings so it runs until it succeeds,
// then never again; the reason it last failed is kept there too for the self-check and for Claude.
import {WEBHOOK_PATH} from './selfcheck.mjs';

export const REQUIRED_EVENTS=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'];
const DONE_KEY='webhook_events_v2';

export async function ensureWebhookEvents(store,stripe,env,now) {
  if(env.STRIPE_MODE!=='live' || !env.STRIPE_SECRET_KEY || !env.COMMERCE_API_ORIGIN) return {skipped:'not live'};
  const done=await store.first('SELECT value FROM commerce_settings WHERE key=?',DONE_KEY);
  if(done?.value==='done') return {skipped:'done'};
  // A failure is retried every 6 hours, not every 5 minutes.
  const failedAt=Date.parse(/^failed (\S+):/.exec(done?.value||'')?.[1]||'');
  if(failedAt && now*1000-failedAt<6*3600*1000) return {skipped:'recently failed'};
  let result;
  try {
    const url=new URL(WEBHOOK_PATH,env.COMMERCE_API_ORIGIN).href;
    const endpoint=((await stripe.listWebhookEndpoints())?.data||[]).find(item => item.url===url);
    if(!endpoint) result={ok:false,reason:`no webhook points at ${url}`};
    else {
      const events=endpoint.enabled_events||[];
      const missing=events.includes('*') ? [] : REQUIRED_EVENTS.filter(event => !events.includes(event));
      if(missing.length) await stripe.updateWebhookEndpoint(endpoint.id,{enabled_events:[...events,...missing]});
      result={ok:true,added:missing};
    }
  } catch(error) {
    result={ok:false,reason:String(error?.message||error).slice(0,300)};
  }
  const value=result.ok ? 'done' : `failed ${new Date(now*1000).toISOString()}: ${result.reason}`;
  await store.run('INSERT INTO commerce_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',DONE_KEY,value);
  return result;
}
