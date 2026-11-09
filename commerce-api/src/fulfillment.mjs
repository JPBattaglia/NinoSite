import {fail,cents,money,canonical,recipient,countries,stripeConfiguration} from './common.mjs';
import {printFiles,artworkKeys} from './catalog.mjs';
import {checkedPaidSession} from './checkout.mjs';
import {resolveShippingCountries} from './countries.mjs';
import {sendOrderEmails,sendRecoveryEmail} from './emails.mjs';
import {PRODUCT_TYPES,position,threadsFor} from './expand.mjs';
import {stickerFile} from './sticker-art.mjs';
import {recordAppStamps} from './fans.mjs';

// Oct 31, 2026: Printful ignores artwork placement on stored (sync) products and prints the file at its own size
// (about 5in wide for most designs), even though the site's photos show it large. Placement is only honored on
// orders, so each line is sent as its catalog variant with the artwork file and an explicit position, the same
// placement the model photos use. T-shirts: the design's mockup layer (inches in the 12x16in front), else the
// shirts' standard placement; other products: their type's rule (expand.mjs).
const SHIRT = {fit: 'chest', file: 'default', area: {default: [1800, 2400]}};
const SPECS = new Map(PRODUCT_TYPES.map(t => [t.type, t]));
export async function placedItems(snapshot, store, printful, {gift: withGift = true} = {}) {
  const items = [];
  for (const [index, line] of snapshot.lines.entries()) {
    const file = (line.variant.files || []).find(f => (f.type || 'default') === 'default' && f.id) || (line.variant.files || [])[0];
    if (!file?.id) fail(409, 'artwork_missing');
    const spec = SPECS.get(line.kind) || SHIRT;
    const area = spec.area[line.variant.catalog_variant_id] || spec.area.default;
    let pos = null;
    if (spec === SHIRT) {
      const job = await store.first('SELECT layer_json FROM mockup_jobs WHERE product_id=?', String(line.product_id)).catch(() => null);
      const layer = job ? JSON.parse(job.layer_json) : null;
      if (layer && layer.width > 0 && layer.height > 0) {
        const s = Math.min(1, 12 / layer.width, 16 / layer.height), w = layer.width * s, h = layer.height * s;
        const left = Math.min(Math.max(layer.left + (layer.width - w) / 2, 0), 12 - w), top = Math.min(Math.max(layer.top + (layer.height - h) / 2, 0), 16 - h);
        pos = {area_width: 1800, area_height: 2400, width: Math.round(w * 150), height: Math.round(h * 150), top: Math.round(top * 150), left: Math.round(left * 150), limit_to_print_area: true};
      }
    }
    if (!pos) {
      const art = await printful.getFile(file.id);
      pos = art && position(spec, area, {width: art.width, height: art.height});
    }
    if (!pos) fail(409, 'artwork_position_unknown');
    // Embroidered products (hats) must name their threads: the same ones the product was made with (expand.mjs).
    const options = spec.embroidery ? await embroideryOptions(store, line.product_id) : null;
    items.push({external_id: `item_${index + 1}`, variant_id: line.variant.catalog_variant_id, quantity: line.quantity,
      retail_price: money(line.unit_price_cents), name: line.title, files: [{type: spec.file || 'default', id: file.id, position: pos}], ...(options ? {options} : {})});
  }
  // Owner decision Oct 31, 2026: a free sticker with every site order (the reason to buy here rather than on Etsy).
  // A 3x3in sticker of the order's first design, at $0. Switch: commerce_settings free_sticker = 'off'.
  const gift = withGift ? await giftSticker(snapshot, store, printful) : null;
  if (gift) items.push(gift);
  return items;
}

async function designOfProduct(store, productId) {
  const row = await store.first("SELECT key FROM commerce_settings WHERE key LIKE 'expand:%' AND value=?", String(productId)).catch(() => null);
  return /^expand:(\d+):/.exec(row?.key || '')?.[1] || null;
}

async function embroideryOptions(store, productId) {
  const row = await store.first("SELECT key FROM commerce_settings WHERE key LIKE 'expand:%' AND value=?", String(productId)).catch(() => null);
  const design = /^expand:(\d+):/.exec(row?.key || '')?.[1];
  const art = design && await store.first('SELECT value FROM commerce_settings WHERE key=?', `expand_art:${design}`).catch(() => null);
  const threads = art && art.value !== 'none' ? threadsFor(JSON.parse(art.value)) : [];
  if (!threads.length) fail(409, 'embroidery_threads_unknown');
  return [{id: 'thread_colors', value: threads}, {id: 'embroidery_type', value: 'flat'}];
}

export const GIFT_EXTERNAL_ID = 'gift_sticker';
export const GIFT_VARIANT = 10163;   // Kiss-cut sticker 3x3in
// Products whose own print file is the plain design, so it can stand in for the sticker artwork. Mug files are a
// full wrap and hat files are embroidery: never use those for the sticker.
const FLAT_ART = new Set(['tshirt', 'sticker', 'tote', 'crewneck', 'hoodie', 'apron']);
const lineDesign = (store, line) => !line.kind || line.kind === 'tshirt' ? String(line.product_id) : designOfProduct(store, line.product_id);
const defaultFile = files => (files || []).find(f => (f.type || 'default') === 'default' && f.id) || (files || [])[0] || null;
// The design's shirt artwork from the active catalog (every design is a shirt first).
async function shirtFile(store, design) {
  const row = await store.first("SELECT snapshot_json FROM catalog_variants WHERE generation=(SELECT value FROM commerce_settings WHERE key='active_catalog') AND product_id=? LIMIT 1", String(design)).catch(() => null);
  try { return row ? defaultFile(JSON.parse(row.snapshot_json).files) : null; } catch { return null; }
}
const giftName = line => `Free sticker: ${String(line.title || 'Nino design').replace(/\s+T$/, '')}`;
// Owner, Nov 3, 2026: the free sticker must work for every design, including ones added later. In order of preference:
// 1. the one-piece sticker artwork (sticker-art.mjs) of the order's first design that has it;
// 2. a design's plain artwork: a flat product's own file, else the design's shirt file (a brand-new design before the
//    sticker-art workflow has made its one-piece file);
// 3. none found: the order goes to review (409) and the owner is emailed, instead of shipping without the sticker.
export async function giftSticker(snapshot, store, printful) {
  const off = await store.first("SELECT value FROM commerce_settings WHERE key='free_sticker'").catch(() => null);
  if (String(off?.value || '').toLowerCase() === 'off') return null;
  const lines = snapshot.lines || [];
  if (!lines.length) return null;
  const sticker = SPECS.get('sticker');
  const gift = (line, fileId, art) => {
    const pos = art && position(sticker, sticker.area[GIFT_VARIANT], {width: art.width, height: art.height});
    return pos ? {external_id: GIFT_EXTERNAL_ID, variant_id: GIFT_VARIANT, quantity: 1, retail_price: '0.00', name: giftName(line), files: [{type: 'default', id: fileId, position: pos}]} : null;
  };
  const designs = [];
  for (const line of lines) designs.push(await lineDesign(store, line));
  for (const [i, line] of lines.entries()) {
    const onepiece = designs[i] ? await stickerFile(store, designs[i]) : null;
    if (onepiece) { const g = gift(line, onepiece.id, onepiece); if (g) return g; }
  }
  for (const [i, line] of lines.entries()) {
    const file = FLAT_ART.has(line.kind || 'tshirt') ? defaultFile(line.variant?.files) : (designs[i] ? await shirtFile(store, designs[i]) : null);
    if (!file?.id) continue;
    const art = await printful.getFile(file.id);   // a provider error retries the order; it is not a missing sticker
    const g = gift(line, file.id, art);
    if (g) return g;
  }
  fail(409, 'free_sticker_art_missing');
}

const accepted = new Set(['inreview','pending','waiting','waiting_for_stock','inprocess','onhold','partial','fulfilled']);

function draftMatches(order,draft,env) {
  const snapshot=JSON.parse(order.snapshot_json);
  if(!draft || String(draft.external_id)!==order.id || !draft.id || draft.store!=null && String(draft.store)!==String(env.PRINTFUL_STORE_ID)) fail(409,'printful_order_identity_mismatch');
  let actualAddress;
  try {actualAddress=recipient(draft.recipient,snapshot.shipping.countries);} catch {fail(409,'printful_address_mismatch');}
  if(canonical(actualAddress)!==canonical(JSON.parse(order.recipient_json))) fail(409,'printful_address_mismatch');
  if(!Array.isArray(draft.items)) fail(409,'printful_items_mismatch');
  // The free sticker (placedItems) is the one extra item allowed: one 3in sticker at no charge.
  const gifts=draft.items.filter(item=>item?.external_id===GIFT_EXTERNAL_ID);
  if(gifts.length>1 || gifts.some(item=>item.quantity!==1 || item.variant_id!==GIFT_VARIANT)) fail(409,'printful_items_mismatch');
  const paidItems=draft.items.filter(item=>item?.external_id!==GIFT_EXTERNAL_ID);
  if(paidItems.length!==snapshot.lines.length) fail(409,'printful_items_mismatch');
  const seen=new Set();
  for(const item of paidItems) {
    // Orders since Oct 31 are placed by catalog variant (placedItems) and matched by their item external id;
    // drafts made before that still carry the sync variant id.
    const byIndex=/^item_(\d+)$/.exec(String(item.external_id || ''));
    const expected=item.sync_variant_id ? snapshot.lines.find(line=>String(item.sync_variant_id)===line.variant_id) : byIndex ? snapshot.lines[Number(byIndex[1])-1] : null;
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
    const shippingEnv=await resolveShippingCountries(env,store,printful,now);
    if(order.recipient_json) {
      try {recipient(JSON.parse(order.recipient_json),countries(shippingEnv));} catch {fail(409,'shipping_country_requires_review');}
    }
    const paid=await checkedPaidSession(order,await stripe.retrieveSession(order.stripe_session_id),await stripe.listLineItems(order.stripe_session_id));
    if(!paid) fail(409,'payment_not_paid');
    if(!order.recipient_json || !order.customer_email) {
      // The webhook stores these only after its own payment check passes; an order it sent to review has none of them.
      // The payment was just re-verified against Stripe above, so save the verified values and let the retry proceed.
      await store.run('UPDATE commerce_orders SET recipient_json=?,customer_email=?,stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,?),paid_total_cents=?,paid_tax_cents=?,paid_shipping_cents=?,updated_at=? WHERE id=? AND claim_id=?',JSON.stringify(paid.recipient),paid.email,paid.payment_intent_id,paid.total,paid.tax,paid.shipping,now,order.id,claim);
      order=await store.order(id);
    }
    if(!order.recipient_json || !order.customer_email) fail(409,'fulfillment_address_missing');
    let draft=await printful.findOrder(order.id);
    if(!draft) {
      draft=await printful.createDraft({external_id:order.id,shipping:snapshot.shipping.method,recipient:{...JSON.parse(order.recipient_json),email:order.customer_email},items:await placedItems(snapshot,store,printful),retail_costs:{currency:'USD',subtotal:money(snapshot.subtotal_cents),shipping:money(order.paid_shipping_cents),tax:money(order.paid_tax_cents),total:money(order.paid_total_cents)}});
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
    await sendOrderEmails(store,env,order.id,now);
    return {confirmed:true};
  } catch(error) {
    const review=error.status===409 || order.fulfillment_attempts>=10;
    const code=String(error.code || 'fulfillment_provider_error').slice(0,150);
    const detail=code==='printful_request_failed' && error.message && error.message!==error.code ? `${code}: ${error.message}`.slice(0,300) : code;
    // Printful prices a new draft a few seconds after creating it, so that case retries on the next run, not after a long backoff.
    const retryAt=now+(code==='printful_cost_not_ready' ? 60 : Math.min(3600,30*2**Math.min(order.fulfillment_attempts,7)));
    await store.batch([
      ["UPDATE commerce_orders SET fulfillment_status=?,claim_id=NULL,lease_until=0,next_retry_at=?,last_error=?,updated_at=? WHERE id=? AND claim_id=?",review?'review':'retry',retryAt,detail,now,order.id,claim],
      ['INSERT INTO commerce_fulfillment_attempts(id,order_id,result,error_code,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),order.id,review?'review':'retry',code,now]
    ]);
    if(review) await sendOrderEmails(store,env,order.id,now);
    return {retry:!review,review,error:code};
  }
}

// A buyer who pays through a reminder's recovery link pays a NEW Checkout Session that Stripe copied from the expired
// one (same client_reference_id and metadata, recovered_from = the expired session). Point the order at the new
// session once; checkedPaidSession then verifies it against Stripe exactly like a first-time payment.
async function recoveredOrder(store,session,now) {
  if(typeof session?.id!=='string' || typeof session.recovered_from!=='string') return null;
  const order=await store.orderBySession(session.recovered_from);
  if(!order || order.payment_status==='paid' || session.client_reference_id!==order.id || session.livemode!==(order.live_mode===1)) return null;
  await store.run('UPDATE commerce_orders SET stripe_session_id=?,checkout_url=NULL,updated_at=? WHERE id=? AND stripe_session_id=? AND payment_status!=?',session.id,now,order.id,session.recovered_from,'paid');
  return store.orderBySession(session.id);
}

export async function stripeWebhook(raw,signature,store,stripe,printful,env,now,ctx) {
  stripeConfiguration(env,true);
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
    if(event.type==='checkout.session.expired') await sendRecoveryEmail(store,env,event.data?.object,now);
    if(supported.includes(event.type)) {
      order=await store.orderBySession(event.data?.object?.id);
      if(!order && event.type==='checkout.session.completed') order=await recoveredOrder(store,event.data?.object,now);
      if(order) {
        if(event.type==='checkout.session.async_payment_failed') await store.run("UPDATE commerce_orders SET payment_status='failed',updated_at=? WHERE id=? AND payment_status!='paid'",now,order.id);
        else {
          const session=await stripe.retrieveSession(order.stripe_session_id);
          if(session.payment_status==='paid') {
            const paid=await checkedPaidSession(order,session,await stripe.listLineItems(order.stripe_session_id));
            if(paid) {
              await store.run(`UPDATE commerce_orders SET payment_status='paid',fulfillment_status=CASE WHEN fulfillment_status IN ('awaiting_payment','test_paid') THEN ? ELSE fulfillment_status END,stripe_payment_intent_id=?,recipient_json=?,customer_email=?,paid_total_cents=?,paid_tax_cents=?,paid_shipping_cents=?,updated_at=? WHERE id=? AND payment_status!='paid'`,order.live_mode===1?'queued':'test_paid',paid.payment_intent_id,JSON.stringify(paid.recipient),paid.email,paid.total,paid.tax,paid.shipping,now,order.id);
              // Nino app rewards (fans.mjs): this order's shirts count toward the member's free canvas and hoodie.
              await recordAppStamps(store,order,now);
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
      await sendOrderEmails(store,env,order.id,now);
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
