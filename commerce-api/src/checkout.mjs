import {fail,hash,canonical,cents,normalizeCart,recipient,shippingConfig,checkoutConfiguration,stripeShipping,nowSeconds} from './common.mjs';
import {validatedLines} from './catalog.mjs';
import {resolveShippingCountries} from './countries.mjs';

export async function shippingQuote(body,store,printful,env,now) {
  env=await resolveShippingCountries(env,store,printful,now);
  const config=shippingConfig(env);
  if (config.mode !== 'calculated') fail(409,'calculated_shipping_not_selected');
  if (!env.PRINTFUL_ACCESS_TOKEN || !env.PRINTFUL_STORE_ID) fail(503,'shipping_not_configured');
  const items=normalizeCart(body); const address=recipient(body.recipient,config.countries);
  const lines=await validatedLines(store,printful,env,items,now);
  const received=await printful.shippingRates({recipient:address,items:lines.map(line=>({variant_id:line.variant.catalog_variant_id,quantity:line.quantity})),currency:'USD'});
  if (!Array.isArray(received)) fail(502,'shipping_quote_failed');
  const rates=received.map(rate=>({id:String(rate.id || ''),name:String(rate.name || 'Shipping').slice(0,100),amount:cents(rate.rate,true),currency:String(rate.currency || '').toLowerCase()})).filter(rate=>rate.id && rate.id.length<=100 && rate.amount!==null && rate.currency==='usd');
  if (!rates.length) fail(422,'shipping_unavailable','No delivery service is available for that address and cart.');
  const id=crypto.randomUUID(); const expires=now+900;
  await store.run('INSERT INTO shipping_quotes(id,cart_hash,recipient_json,rates_json,created_at,expires_at) VALUES(?,?,?,?,?,?)',id,await hash(items),JSON.stringify(address),JSON.stringify(rates),now,expires);
  return {quote_id:id,expires_at:expires,rates};
}
async function resolveShipping(body,items,store,config,now) {
  if(config.mode!=='calculated') return {mode:config.mode,amount:config.amount,name:config.name,method:'STANDARD',countries:config.countries};
  if(typeof body.shipping_quote_id!=='string' || typeof body.shipping_rate_id!=='string') fail(400,'shipping_quote_required','Review a delivery address and shipping quote before checkout.');
  const quote=await store.first('SELECT * FROM shipping_quotes WHERE id=?',body.shipping_quote_id);
  if(!quote || quote.expires_at<=now || quote.cart_hash!==await hash(items)) fail(409,'shipping_quote_expired','Request a new shipping quote for this cart.');
  const rate=JSON.parse(quote.rates_json).find(rate=>rate.id===body.shipping_rate_id);
  if(!rate) fail(400,'invalid_shipping_rate');
  return {mode:'calculated',amount:rate.amount,name:rate.name,method:rate.id,countries:config.countries,recipient:recipient(JSON.parse(quote.recipient_json),config.countries),quote_id:quote.id};
}
function returnUrl(env,key,fallback) {
  const path=env[key] || fallback;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) fail(503,'return_url_not_configured');
  return new URL(path,env.STOREFRONT_ORIGIN).href.replaceAll('%7BCHECKOUT_SESSION_ID%7D','{CHECKOUT_SESSION_ID}');
}
function paidRecipient(input,countries) {
  try { return recipient(input,countries); } catch { fail(409,'payment_shipping_address_unverified'); }
}
export async function createCheckout(body,request,store,stripe,printful,env,now) {
  env=await resolveShippingCountries(env,store,printful,now);
  const shippingPolicy=checkoutConfiguration(env);
  const items=normalizeCart(body);
  if(Object.keys(body).some(key=>!['items','request_id','shipping_quote_id','shipping_rate_id'].includes(key))) fail(400,'invalid_checkout_fields','Prices and totals are calculated by the server.');
  const requestKey=request.headers.get('Idempotency-Key') || body.request_id || crypto.randomUUID();
  if(typeof requestKey!=='string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) fail(400,'invalid_request_id');
  const requestHash=await hash({items,shipping_quote_id:body.shipping_quote_id || null,shipping_rate_id:body.shipping_rate_id || null});
  let order=await store.first('SELECT * FROM commerce_orders WHERE request_key=?',requestKey);
  if(order) {
    if(order.request_hash!==requestHash) fail(409,'request_id_reused','Use a new request ID when the cart changes.');
    if(order.payment_status==='paid') fail(409,'order_already_paid');
    if(now-order.created_at>1800) fail(409,'checkout_expired','Start a new checkout attempt.');
    if(order.checkout_url && order.checkout_expires_at>now) return {checkout_url:order.checkout_url,order_id:order.id,receipt_token:order.receipt_token,request_id:requestKey};
    if(order.stripe_session_id) fail(409,'checkout_expired','Start a new checkout attempt.');
  } else {
    const lines=await validatedLines(store,printful,env,items,now);
    const shipping=await resolveShipping(body,items,store,shippingPolicy,now);
    const subtotal=lines.reduce((sum,line)=>sum+line.line_total_cents,0);
    if(subtotal+shipping.amount>1000000) fail(400,'order_total_limit');
    const id=`ord_${(await hash(requestKey)).slice(0,24)}`;
    const snapshot={lines,subtotal_cents:subtotal,currency:'usd',shipping,tax_mode:env.STRIPE_TAX_MODE,created_at:now};
    const token=crypto.randomUUID()+crypto.randomUUID();
    await store.run('INSERT OR IGNORE INTO commerce_orders(id,request_key,request_hash,snapshot_json,receipt_token,live_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',id,requestKey,requestHash,JSON.stringify(snapshot),token,env.STRIPE_MODE==='live'?1:0,now,now);
    order=await store.order(id);
    if(order.request_hash!==requestHash) fail(409,'request_id_reused');
  }
  const snapshot=JSON.parse(order.snapshot_json);
  const integrationSuffix=(await hash(order.id)).slice(0,16).match(/../g).map(pair=>String.fromCharCode(97+parseInt(pair,16)%26)).join('');
  const params={
    mode:'payment',ui_mode:'hosted_page',client_reference_id:order.id,
    integration_identifier:`nino-native-checkout-${integrationSuffix}`,
    success_url:returnUrl(env,'CHECKOUT_SUCCESS_PATH','/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID}'),
    cancel_url:returnUrl(env,'CHECKOUT_CANCEL_PATH','/shop.html?checkout=cancelled'),
    expires_at:order.created_at+3600,
    metadata:{order_id:order.id,cart_hash:order.request_hash},
    payment_intent_data:{metadata:{order_id:order.id}},
    line_items:snapshot.lines.map(line=>({quantity:line.quantity,price_data:{currency:'usd',unit_amount:line.unit_price_cents,tax_behavior:'exclusive',product_data:{name:line.title,description:line.variant.name || undefined,images:line.image?[line.image]:undefined,metadata:{sync_variant_id:line.variant_id,sync_product_id:line.product_id}}}})),
    shipping_options:[{shipping_rate_data:{display_name:snapshot.shipping.name,type:'fixed_amount',fixed_amount:{amount:snapshot.shipping.amount,currency:'usd'},tax_behavior:'exclusive'}}]
  };
  if(snapshot.tax_mode==='automatic') params.automatic_tax={enabled:true};
  if(snapshot.shipping.mode==='calculated') {
    params.payment_intent_data.shipping=stripeShipping(snapshot.shipping.recipient);
    params.custom_text={submit:{message:'Delivery uses the address you reviewed on our site before payment.'}};
    if(snapshot.tax_mode==='automatic') {
      const customer=await stripe.createCustomer({name:snapshot.shipping.recipient.name,shipping:stripeShipping(snapshot.shipping.recipient)},`${order.id}:customer`);
      params.customer=customer.id;
    }
  } else params.shipping_address_collection={allowed_countries:snapshot.shipping.countries};
  const session=await stripe.createSession(params,`${order.id}:checkout`);
  if(!session?.id || !session.url || session.livemode!==(env.STRIPE_MODE==='live')) fail(502,'invalid_checkout_session');
  try { const url=new URL(session.url); if(url.protocol!=='https:' || url.hostname!=='checkout.stripe.com') fail(502,'invalid_checkout_session'); } catch { fail(502,'invalid_checkout_session'); }
  await store.run('UPDATE commerce_orders SET stripe_session_id=?,checkout_url=?,checkout_expires_at=?,updated_at=? WHERE id=?',session.id,session.url,session.expires_at || order.created_at+3600,now,order.id);
  return {checkout_url:session.url,order_id:order.id,receipt_token:order.receipt_token,request_id:requestKey};
}
export async function checkedPaidSession(order,session,lineItems) {
  const snapshot=JSON.parse(order.snapshot_json);
  if(session.payment_status!=='paid') return null;
  const shipping=session.total_details?.amount_shipping; const tax=session.total_details?.amount_tax; const discount=session.total_details?.amount_discount || 0;
  if(session.id!==order.stripe_session_id || session.status!=='complete' || session.client_reference_id!==order.id || session.metadata?.order_id!==order.id || session.metadata?.cart_hash!==order.request_hash || session.currency!=='usd' || session.amount_subtotal!==snapshot.subtotal_cents || session.livemode!==(order.live_mode===1)) fail(409,'payment_snapshot_mismatch');
  if(!Number.isSafeInteger(tax) || tax<0 || shipping!==snapshot.shipping.amount || discount!==0 || session.amount_total!==snapshot.subtotal_cents+shipping+tax) fail(409,'payment_total_mismatch');
  if(snapshot.tax_mode==='none' && tax!==0 || snapshot.tax_mode==='automatic' && session.automatic_tax?.status!=='complete') fail(409,'payment_tax_mismatch');
  const intent=session.payment_intent;
  if(!intent || typeof intent!=='object' || intent.status!=='succeeded' || intent.currency!=='usd' || intent.amount_received<session.amount_total || intent.metadata?.order_id!==order.id) fail(409,'payment_intent_unverified');
  if(!intent.latest_charge || typeof intent.latest_charge!=='object' || intent.latest_charge.paid!==true || intent.latest_charge.refunded!==false || intent.latest_charge.amount_refunded!==0) fail(409,'payment_refunded_or_unverified');
  if(!lineItems || lineItems.has_more || !Array.isArray(lineItems.data) || lineItems.data.length!==snapshot.lines.length) fail(409,'payment_items_mismatch');
  const seen=new Set();
  for(const paid of lineItems.data) {
    const id=paid.price?.product?.metadata?.sync_variant_id;
    const expected=snapshot.lines.find(line=>line.variant_id===id);
    if(!expected || seen.has(id) || paid.quantity!==expected.quantity || paid.amount_subtotal!==expected.line_total_cents || paid.price?.unit_amount!==expected.unit_price_cents || paid.price?.currency!=='usd') fail(409,'payment_items_mismatch');
    seen.add(id);
  }
  let address=snapshot.shipping.recipient;
  if(!address) {
    const collected=session.collected_information?.shipping_details || session.shipping_details || intent.shipping;
    const a=collected?.address;
    address=paidRecipient({name:collected?.name,address1:a?.line1,address2:a?.line2,city:a?.city,state_code:a?.state,country_code:a?.country,zip:a?.postal_code},snapshot.shipping.countries);
  }
  if(snapshot.shipping.recipient && canonical(intent.shipping)!==canonical(stripeShipping(snapshot.shipping.recipient))) {
    // Stripe can add optional fields, but must not change the quoted destination.
    const a=intent.shipping?.address;
    const actual=paidRecipient({name:intent.shipping?.name,address1:a?.line1,address2:a?.line2,city:a?.city,state_code:a?.state,country_code:a?.country,zip:a?.postal_code},snapshot.shipping.countries);
    if(canonical(actual)!==canonical(snapshot.shipping.recipient)) fail(409,'quoted_address_mismatch');
  }
  const email=session.customer_details?.email || session.customer_email;
  if(typeof email!=='string' || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(409,'customer_email_missing');
  return {recipient:address,email,total:session.amount_total,tax,shipping,payment_intent_id:intent.id};
}
