import {fail,cents,money,canonical,recipient} from './common.mjs';
import {printFiles,artworkKeys} from './catalog.mjs';
import {checkedPaidSession} from './checkout.mjs';

const accepted = new Set(['inreview','pending','waiting','waiting_for_stock','inprocess','onhold','partial','fulfilled']);

function draftMatches(order,draft,env) {
  const snapshot=JSON.parse(order.snapshot_json);
  if(!draft || String(draft.external_id)!==order.id || !draft.id || draft.store!=null && String(draft.store)!==String(env.PRINTFUL_STORE_ID)) fail(409,'printful_order_identity_mismatch');
  let actualAddress;
  try {actualAddress=recipient(draft.recipient,snapshot.shipping.countries);} catch {fail(409,'printful_address_mismatch');}
  if(canonical(actualAddress)!==canonical(JSON.parse(order.recipient_json))) fail(409,'printful_address_mismatch');
  if(!Array.isArray(draft.items) || draft.items.length!==snapshot.lines.length) fail(409,'printful_items_mismatch');
  const seen=new Set();
  for(const item of draft.items) {
    const expected=snapshot.lines.find(line=>String(item.sync_variant_id)===line.variant_id);
    if(!expected || seen.has(expected.variant_id) || item.quantity!==expected.quantity || item.variant_id!==expected.variant.catalog_variant_id) fail(409,'printful_items_mismatch');
    if(canonical(artworkKeys(printFiles(item.files)))!==canonical(artworkKeys(expected.variant.files))) fail(409,'printful_artwork_changed');
    seen.add(expected.variant_id);
  }
  const cost=cents(draft.costs?.total,true);
  if(cost===null || String(draft.costs?.currency).toUpperCase()!=='USD') fail(502,'printful_cost_not_ready');
  const configuredCap=/^\d+$/.test(env.PRINTFUL_MAX_ORDER_COST_CENTS || '') ? Number(env.PRINTFUL_MAX_ORDER_COST_CENTS) : Infinity;
  if(cost>Math.min(order.paid_total_cents-order.paid_tax_cents,configuredCap)) fail(409,'printful_cost_requires_review');
}
export async function fulfillOrder(id,store,stripe,printful,env,now) {
  if(env.FULFILLMENT_ENABLED!=='true') return {queued:true};
  const claim=crypto.randomUUID();
  const lock=await store.run(`UPDATE commerce_orders SET fulfillment_status='processing',lease_until=?,claim_id=?,fulfillment_attempts=fulfillment_attempts+1,updated_at=? WHERE id=? AND payment_status='paid' AND live_mode=1 AND fulfillment_status IN ('queued','retry','processing','draft') AND lease_until<=? AND next_retry_at<=? AND fulfillment_attempts<10`,now+300,claim,now,id,now,now);
  if(!lock.meta.changes) return {skipped:true};
  let order=await store.order(id);
  try {
    const snapshot=JSON.parse(order.snapshot_json);
    const paid=await checkedPaidSession(order,await stripe.retrieveSession(order.stripe_session_id),await stripe.listLineItems(order.stripe_session_id));
    if(!paid) fail(409,'payment_not_paid');
    if(!order.recipient_json || !order.customer_email) fail(409,'fulfillment_address_missing');
    let draft=await printful.findOrder(order.id);
    if(!draft) {
      draft=await printful.createDraft({external_id:order.id,shipping:snapshot.shipping.method,recipient:{...JSON.parse(order.recipient_json),email:order.customer_email},items:snapshot.lines.map((line,index)=>({external_id:`item_${index+1}`,sync_variant_id:Number(line.variant_id),quantity:line.quantity,retail_price:money(line.unit_price_cents),name:line.title})),retail_costs:{currency:'USD',subtotal:money(snapshot.subtotal_cents),shipping:money(order.paid_shipping_cents),tax:money(order.paid_tax_cents),total:money(order.paid_total_cents)}});
    }
    draftMatches(order,draft,env);
    await store.run('UPDATE commerce_orders SET printful_order_id=?,printful_draft_json=?,updated_at=? WHERE id=? AND claim_id=?',String(draft.id),JSON.stringify(draft),now,order.id,claim);
    if(draft.status==='draft') {
      const confirmed=await printful.confirmOrder(draft.id);
      if(!confirmed || String(confirmed.id)!==String(draft.id) || !accepted.has(confirmed.status)) fail(502,'printful_confirmation_not_ready');
    } else if(!accepted.has(draft.status)) fail(409,'printful_order_requires_review');
    await store.batch([
      ["UPDATE commerce_orders SET fulfillment_status='confirmed',claim_id=NULL,lease_until=0,last_error=NULL,updated_at=? WHERE id=? AND claim_id=?",now,order.id,claim],
      ['INSERT INTO commerce_fulfillment_attempts(id,order_id,result,printful_order_id,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),order.id,'confirmed',String(draft.id),now]
    ]);
    return {confirmed:true};
  } catch(error) {
    const review=error.status===409 || order.fulfillment_attempts>=10;
    const code=String(error.code || 'fulfillment_provider_error').slice(0,150);
    const retryAt=now+Math.min(3600,30*2**Math.min(order.fulfillment_attempts,7));
    await store.batch([
      ["UPDATE commerce_orders SET fulfillment_status=?,claim_id=NULL,lease_until=0,next_retry_at=?,last_error=?,updated_at=? WHERE id=? AND claim_id=?",review?'review':'retry',retryAt,code,now,order.id,claim],
      ['INSERT INTO commerce_fulfillment_attempts(id,order_id,result,error_code,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),order.id,review?'review':'retry',code,now]
    ]);
    return {retry:!review,review,error:code};
  }
}

export async function stripeWebhook(raw,signature,store,stripe,printful,env,now,ctx) {
  if(!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) fail(503,'webhook_not_configured');
  let event;
  try { event=await stripe.verifyWebhook(raw,signature,env.STRIPE_WEBHOOK_SECRET); } catch { fail(400,'invalid_webhook_signature'); }
  if(!event || typeof event.id!=='string' || !event.id.startsWith('evt_') || event.livemode!==(env.STRIPE_MODE==='live')) fail(400,'invalid_webhook_environment');
  const payloadHash=await (await import('./common.mjs')).hash(raw);
  await store.run('INSERT OR IGNORE INTO commerce_webhook_events(id,event_type,payload_hash,created_at) VALUES(?,?,?,?)',event.id,event.type,payloadHash,now);
  const prior=await store.first('SELECT * FROM commerce_webhook_events WHERE id=?',event.id);
  if(prior.payload_hash!==payloadHash) fail(409,'webhook_payload_changed');
  if(prior.status==='processed') return {received:true,duplicate:true};
  const claim=crypto.randomUUID();
  const lock=await store.run("UPDATE commerce_webhook_events SET status='processing',claim_id=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status!='processed' AND lease_until<=?",claim,now+300,event.id,now);
  if(!lock.meta.changes) fail(503,'webhook_in_progress');
  let order;
  try {
    const supported=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'];
    if(supported.includes(event.type)) {
      order=await store.orderBySession(event.data?.object?.id);
      if(order) {
        if(event.type==='checkout.session.async_payment_failed') await store.run("UPDATE commerce_orders SET payment_status='failed',updated_at=? WHERE id=? AND payment_status!='paid'",now,order.id);
        else {
          const session=await stripe.retrieveSession(order.stripe_session_id);
          if(session.payment_status==='paid') {
            const paid=await checkedPaidSession(order,session,await stripe.listLineItems(order.stripe_session_id));
            if(paid) {
              await store.run(`UPDATE commerce_orders SET payment_status='paid',fulfillment_status=CASE WHEN fulfillment_status IN ('awaiting_payment','test_paid') THEN ? ELSE fulfillment_status END,stripe_payment_intent_id=?,recipient_json=?,customer_email=?,paid_total_cents=?,paid_tax_cents=?,paid_shipping_cents=?,updated_at=? WHERE id=? AND payment_status!='paid'`,order.live_mode===1?'queued':'test_paid',paid.payment_intent_id,JSON.stringify(paid.recipient),paid.email,paid.total,paid.tax,paid.shipping,now,order.id);
            }
          }
        }
      }
    }
    await store.run("UPDATE commerce_webhook_events SET status='processed',claim_id=NULL,lease_until=0,processed_at=?,last_error=NULL WHERE id=? AND claim_id=?",now,event.id,claim);
  } catch(error) {
    if(order && error.status===409) {
      await store.run("UPDATE commerce_orders SET payment_status='paid',fulfillment_status='review',last_error=?,updated_at=? WHERE id=? AND fulfillment_status!='confirmed'",error.code,now,order.id);
      await store.run("UPDATE commerce_webhook_events SET status='processed',claim_id=NULL,lease_until=0,processed_at=?,last_error=? WHERE id=? AND claim_id=?",now,error.code,event.id,claim);
      return {received:true,review:true};
    }
    await store.run("UPDATE commerce_webhook_events SET status='failed',claim_id=NULL,lease_until=0,last_error=? WHERE id=? AND claim_id=?",String(error.code || 'webhook_provider_error'),event.id,claim);
    throw error;
  }
  if(order?.live_mode===1) {
    const work=fulfillOrder(order.id,store,stripe,printful,env,now);
    if(ctx?.waitUntil) ctx.waitUntil(work); else await work;
  }
  return {received:true};
}
