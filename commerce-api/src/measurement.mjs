import {fail,requestJson} from './common.mjs';
const events=new Set(['page_view','product_view','add_to_cart','checkout_attempt','checkout_opened']);
const productEvents=new Set(['product_view','add_to_cart']);
export async function recordMeasurement(request,store,env,now) {
  if(request.headers.get('Origin')!==env.STOREFRONT_ORIGIN) fail(403,'origin_not_allowed');
  if(request.headers.get('DNT')==='1' || request.headers.get('Sec-GPC')==='1') return {recorded:false};
  if(!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415,'json_required');
  // Keep the accepted payload small and reject arbitrary personal or payment fields.
  const body=await requestJson(request,256);
  if(!body || Array.isArray(body) || Object.keys(body).some(key=>!['event','product_id'].includes(key)) || !events.has(body.event)) fail(400,'invalid_measurement');
  const product=body.product_id ?? '';
  if(typeof product!=='string' || (product && !/^\d{1,20}$/.test(product)) || (!productEvents.has(body.event) && product)) fail(400,'invalid_measurement');
  if(product) {
    const generation=await store.activeGeneration();
    if(!generation || !await store.first('SELECT id FROM catalog_products WHERE generation=? AND id=?',generation,product)) return {recorded:false};
  }
  if(!['test','live'].includes(env.STRIPE_MODE)) return {recorded:false};
  const day=new Date(now*1000).toISOString().slice(0,10);
  const cutoff=new Date((now-89*86400)*1000).toISOString().slice(0,10);
  await store.run('DELETE FROM shopping_measurement WHERE day<?',cutoff);
  // Bound storage writes to 10,000 accepted actions/day across both datasets.
  // Browser actions are untrusted, may repeat, and are never evidence of payment.
  const result=await store.run(`INSERT INTO shopping_measurement(day,mode,event,product_id,total)
    SELECT ?,?,?,?,1 WHERE (SELECT COALESCE(SUM(total),0) FROM shopping_measurement WHERE day=?)<10000
    ON CONFLICT(day,mode,event,product_id) DO UPDATE SET total=total+1`,day,env.STRIPE_MODE,body.event,product,day);
  return {recorded:result.meta.changes===1};
}
export async function measurementReport(store,now) {
  const cutoff=new Date((now-29*86400)*1000).toISOString().slice(0,10);
  const actions=await store.all('SELECT day,mode,event,product_id,total FROM shopping_measurement WHERE day>=? ORDER BY day DESC,mode,event,product_id',cutoff);
  // Distinct database order rows, verified by the signed payment webhook.
  const purchases=await store.all(`SELECT date(paid_at,'unixepoch') AS day,COUNT(*) AS paid_orders,SUM(paid_total_cents) AS paid_total_cents
    FROM commerce_orders WHERE live_mode=1 AND payment_status='paid' AND paid_at>=? AND paid_total_cents IS NOT NULL AND stripe_payment_intent_id IS NOT NULL GROUP BY day ORDER BY day DESC`,Math.floor(Date.parse(cutoff+'T00:00:00Z')/1000));
  return {window_start:cutoff,day_timezone:'UTC',actions,confirmed_live_purchases:purchases,notes:'Actions are opt-in counts, not unique people or linked funnels. Test and live actions are separate. Purchase totals include shipping and tax where charged; they are not net revenue. Purchase dates use the first verified payment observation. Historical paid orders without that timestamp are omitted.'};
}
