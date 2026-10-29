// Staff merch for Menu-made (stage 10 of the Nino + Menu-made automation handbook).
//
// Businesses order staff shirts with Nino's designs on menu-made.com, optionally with their own logo on the back.
// Menu-made sells and charges (its own Stripe account and order engine); this shop only does what needs its Printful
// token: re-checks the chosen shirts against Printful, quotes delivery, and places the Printful order once Menu-made
// says it is paid (and, with a logo, approved by the owner). Menu-made reaches these functions only through the
// private service-binding entrypoint NinoMerch (main.mjs); nothing here has a public route.
//
// Nino's own shirt shop (checkout, Stripe account, database rows) is untouched: merch orders live only in Printful,
// tagged with Menu-made's external id ("mm" + its order id).
import {HttpError,fail,cents,recipient,countries} from './common.mjs';
import {validatedLines} from './catalog.mjs';
import {resolveShippingCountries} from './countries.mjs';

export const MERCH_LIMITS=Object.freeze({max_lines:30,max_per_line:100,max_total:200});
// Logo on the upper back, inside Printful's 12x16 in DTG area (positions in pixels at 150 dpi: 1800x2400).
export const LOGO_POSITION=Object.freeze({area_width:1800,area_height:2400,width:600,height:600,top:150,left:600,limit_to_print_area:true});
const EXTERNAL_ID=/^mm[a-z0-9]{8,30}$/;

export function normalizeMerchItems(items) {
  if(!Array.isArray(items) || items.length<1 || items.length>MERCH_LIMITS.max_lines) fail(400,'invalid_merch_cart',`Choose between 1 and ${MERCH_LIMITS.max_lines} sizes and colours.`);
  const seen=new Set(); let total=0;
  const clean=items.map(item=>{
    const product=String(item?.product_id ?? ''); const variant=String(item?.variant_id ?? ''); const quantity=item?.quantity;
    if(!/^\d{1,20}$/.test(product) || !/^\d{1,20}$/.test(variant) || !Number.isInteger(quantity) || quantity<1 || quantity>MERCH_LIMITS.max_per_line) fail(400,'invalid_merch_item');
    if(seen.has(variant)) fail(400,'duplicate_variant');
    seen.add(variant); total+=quantity;
    return {product_id:product,variant_id:variant,quantity};
  });
  if(total>MERCH_LIMITS.max_total) fail(400,'quantity_limit',`Choose at most ${MERCH_LIMITS.max_total} shirts per order.`);
  return clean;
}

// Verified lines (today's Nino price, colour, size, artwork) and Printful's delivery rates for the address.
export async function merchQuote({items,recipient:address},{store,printful,env,now}) {
  const clean=normalizeMerchItems(items);
  const shippingEnv=await resolveShippingCountries(env,store,printful,now);
  const to=recipient(address,countries(shippingEnv));
  const lines=await validatedLines(store,printful,env,clean,now);
  const received=await printful.shippingRates({recipient:to,items:lines.map(line=>({variant_id:line.variant.catalog_variant_id,quantity:line.quantity})),currency:'USD'});
  if(!Array.isArray(received)) fail(502,'shipping_quote_failed');
  const rates=received.map(rate=>({id:String(rate.id || ''),name:String(rate.name || 'Shipping').slice(0,100),amount_cents:cents(rate.rate,true),currency:String(rate.currency || '').toLowerCase(),min_days:Number(rate.minDeliveryDays)||null,max_days:Number(rate.maxDeliveryDays)||null})).filter(rate=>rate.id && rate.amount_cents!==null && rate.currency==='usd');
  if(!rates.length) fail(422,'shipping_unavailable','No delivery service is available for that address.');
  return {
    recipient:to,
    lines:lines.map(line=>({product_id:line.product_id,variant_id:line.variant_id,quantity:line.quantity,title:line.title,color:line.variant.color,size:line.variant.size,image:line.image,unit_price_cents:line.unit_price_cents,catalog_variant_id:line.variant.catalog_variant_id,fingerprint:line.variant.fingerprint})),
    rates
  };
}

function printfulItems(lines,snapshots,logoUrl) {
  return lines.map((line,index)=>{
    const variant=snapshots.get(String(line.variant_id));
    const base={external_id:`item_${index+1}`,quantity:line.quantity,retail_price:(line.retail_cents/100).toFixed(2),name:String(line.title || 'Staff shirt').slice(0,100)};
    if(!logoUrl) return {...base,sync_variant_id:Number(line.variant_id)};
    // With a logo the shirt is ordered from the catalog variant: Nino's artwork where it already prints, plus the logo.
    const files=variant.files.filter(file=>file.type!=='back').map(file=>({type:file.type==='default'?'front':file.type,...(file.id?{id:file.id}:{url:file.url})}));
    files.push({type:'back',url:logoUrl,position:LOGO_POSITION});
    return {...base,variant_id:variant.catalog_variant_id,files};
  });
}

// Places (or finds) the Printful order for a paid Menu-made merch order. Idempotent by external_id.
// confirm=false leaves a draft (sandbox orders and the self-test never print anything).
export async function placeMerchOrder({external_id,lines,recipient:address,email,shipping_method,logo_url,max_cost_cents,confirm},{store,printful,env,now}) {
  if(!EXTERNAL_ID.test(String(external_id || ''))) fail(400,'invalid_external_id');
  if(logo_url!=null && !/^https:\/\/[^\s]+$/.test(String(logo_url))) fail(400,'invalid_logo_url');
  if(!Number.isInteger(max_cost_cents) || max_cost_cents<1) fail(400,'invalid_cost_cap');
  let draft=await printful.findOrder(external_id);
  if(!draft) {
    const clean=normalizeMerchItems(lines.map(({product_id,variant_id,quantity})=>({product_id,variant_id,quantity})));
    // Same check as a shop checkout: the shirt must still exist with the artwork that was quoted.
    const verified=await validatedLines(store,printful,env,clean,now);
    const snapshots=new Map(verified.map(line=>[String(line.variant_id),line.variant]));
    for(const line of lines) if(line.fingerprint && snapshots.get(String(line.variant_id))?.fingerprint!==line.fingerprint) fail(409,'catalog_changed','A chosen shirt changed since the order was paid.');
    const shippingEnv=await resolveShippingCountries(env,store,printful,now);
    const to=recipient(address,countries(shippingEnv));
    if(typeof email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'invalid_email');
    draft=await printful.createDraft({external_id,shipping:String(shipping_method || 'STANDARD'),recipient:{...to,email},items:printfulItems(lines,snapshots,logo_url || null)});
  }
  if(!draft || String(draft.external_id)!==external_id) fail(409,'printful_order_identity_mismatch');
  const cost=cents(String(draft.costs?.total ?? ''),true);
  if(cost===null) fail(503,'printful_cost_not_ready','Printful is still pricing the order; try again in a minute.');
  if(cost>max_cost_cents) fail(409,'printful_cost_requires_review',`Printful charges $${(cost/100).toFixed(2)}, above the $${(max_cost_cents/100).toFixed(2)} allowed for this order.`);
  if(confirm && draft.status==='draft') {
    const confirmed=await printful.confirmOrder(draft.id);
    if(!confirmed || String(confirmed.id)!==String(draft.id)) fail(502,'printful_confirmation_not_ready');
    draft=confirmed;
  }
  return {printful_order_id:String(draft.id),status:draft.status,cost_cents:cost};
}

export async function merchOrderStatus({external_id},{printful}) {
  if(!EXTERNAL_ID.test(String(external_id || ''))) fail(400,'invalid_external_id');
  const order=await printful.findOrder(external_id);
  if(!order) return {found:false};
  const shipments=(Array.isArray(order.shipments)?order.shipments:[]).map(s=>({carrier:s.carrier || null,service:s.service || null,tracking_number:s.tracking_number || null,tracking_url:s.tracking_url || null,ship_date:s.ship_date || null}));
  return {found:true,printful_order_id:String(order.id),status:order.status,shipments};
}

// Removes a draft (self-test clean-up). A confirmed order is never deleted from here.
export async function deleteMerchDraft({external_id},{printful}) {
  if(!EXTERNAL_ID.test(String(external_id || ''))) fail(400,'invalid_external_id');
  const order=await printful.findOrder(external_id);
  if(!order) return {deleted:false,reason:'not_found'};
  if(order.status!=='draft') return {deleted:false,reason:`status_${order.status}`};
  await printful.deleteOrder(order.id);
  return {deleted:true};
}

// Two sizes of one shirt in one colour from the live catalog (Menu-made's staff merch self-test). Two small reads.
export async function merchSample(_args,{store}) {
  const generation=await store.activeGeneration();
  if(!generation) fail(503,'catalog_not_ready');
  const rows=await store.all(`SELECT product_id,id AS variant_id,json_extract(snapshot_json,'$.color') AS color,json_extract(snapshot_json,'$.size') AS size FROM catalog_variants WHERE generation=? AND product_id=(SELECT product_id FROM catalog_variants WHERE generation=? GROUP BY product_id,json_extract(snapshot_json,'$.color') HAVING COUNT(*)>=2 ORDER BY product_id LIMIT 1) ORDER BY id LIMIT 12`,generation,generation);
  const color=rows[0]?.color;
  const picked=rows.filter(r=>r.color===color).slice(0,2);
  if(picked.length<2) fail(503,'catalog_not_ready');
  return {variants:picked.map(r=>({product_id:String(r.product_id),variant_id:String(r.variant_id),color:r.color,size:r.size}))};
}

// Errors cross the service binding as plain objects so Menu-made can tell a buyer-facing problem from an outage.
export async function merchCall(fn,args,deps) {
  try { return {ok:true,...await fn(args,deps)}; }
  catch(error) {
    if(error instanceof HttpError) return {ok:false,status:error.status,error:error.code,message:error.message};
    return {ok:false,status:500,error:'merch_service_error',message:String(error?.message || error).slice(0,200)};
  }
}
