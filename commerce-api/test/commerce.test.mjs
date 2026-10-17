import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rawVariant} from './fixtures.mjs';
import {normalizeVariant} from '../src/catalog.mjs';
import {fulfillOrder} from '../src/fulfillment.mjs';
import {createApp} from '../src/worker.mjs';

function providerConstructionSpy(f) {
  let constructed=0;
  const app=createApp({stripeFactory:async()=>{constructed++;throw new Error('Provider must not be constructed');},printful:f.printful,now:f.now});
  return {
    constructed:()=>constructed,
    async request(path,origin=f.env.STOREFRONT_ORIGIN) {
      const response=await app.fetch(new Request(`https://api.example.com${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Stripe-Signature':'fixture-signature'},body:JSON.stringify({items:f.items,request_id:crypto.randomUUID()})}),f.env);
      return {status:response.status,body:await response.json()};
    }
  };
}

test('missing checkout credentials return503 before SDK construction, while foreign origins still return403 first',async()=>{
  const f=await fixture({STRIPE_SECRET_KEY:''});const spy=providerConstructionSpy(f);
  for(const path of ['/api/checkout','/api/shipping-quotes']) {
    assert.equal((await spy.request(path)).status,503);
    assert.equal((await spy.request(path,'https://untrusted.example.com')).status,403);
  }
  assert.equal(spy.constructed(),0);assert.equal(f.printful.rateCalls,0);assert.equal(f.stripe.calls,0);
});
test('webhook checks key/signing-secret configuration before SDK construction',async()=>{
  for(const missing of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET']) {
    const f=await fixture({[missing]:''});const spy=providerConstructionSpy(f);
    assert.equal((await spy.request('/api/webhooks/stripe')).status,503);
    assert.equal(spy.constructed(),0);assert.equal(f.printful.createCalls,0);
  }
});
test('mismatched or unsupported Stripe key prefixes cannot construct a provider or create a payable session',async()=>{
  const cases=[['test','sk_live_fixture'],['test','rk_live_fixture'],['live','sk_test_fixture'],['live','rk_test_fixture'],['live','pk_live_fixture'],['test','unprefixed_fixture']];
  for(const [mode,key] of cases) {
    const f=await fixture({STRIPE_MODE:mode,STRIPE_SECRET_KEY:key});const spy=providerConstructionSpy(f);
    for(const path of ['/api/checkout','/api/shipping-quotes','/api/webhooks/stripe']) assert.equal((await spy.request(path)).status,503);
    assert.equal(spy.constructed(),0);assert.equal(f.stripe.calls,0);assert.equal(f.printful.rateCalls,0);assert.equal(f.printful.createCalls,0);
    assert.equal((await f.request('/api/products')).body.checkout_ready,false);
  }
  for(const [mode,key] of [['test','sk_test_fixture'],['test','rk_test_fixture'],['live','sk_live_fixture'],['live','rk_live_fixture']]) {
    const f=await fixture({STRIPE_MODE:mode,STRIPE_SECRET_KEY:key});assert.equal((await f.checkout()).status,200);assert.equal(f.stripe.calls,1);
  }
});
test('turning checkout off does not block verification or fulfillment of an existing paid order',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');
  f.env.CHECKOUT_ENABLED='false';f.env.SHIPPING_MODE='';f.env.STRIPE_TAX_MODE='';
  assert.equal((await f.checkout()).status,503);
  assert.equal((await f.webhook()).status,200);
  assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'confirmed');assert.equal(f.printful.confirmCalls,1);
});

test('preview/localhost can read public catalog/config/health while writes and private routes stay protected',async()=>{
  const f=await fixture();
  for(const origin of ['https://private-preview.example.com','http://localhost:4173']) {
    for(const path of ['/api/products','/api/commerce-config','/api/health']) {
      const response=await f.app.fetch(new Request(`https://api.example.com${path}`,{headers:{Origin:origin}}),f.env);
      assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
    }
    for(const path of ['/api/checkout','/api/shipping-quotes']) {
      const response=await f.app.fetch(new Request(`https://api.example.com${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({items:f.items})}),f.env);
      assert.equal(response.status,403);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    }
  }
  const privateResponse=await f.app.fetch(new Request('https://api.example.com/api/admin/orders',{headers:{Origin:'https://private-preview.example.com'}}),f.env);
  assert.equal(privateResponse.status,401);assert.equal(privateResponse.headers.get('Access-Control-Allow-Origin'),null);
  const receipt=await f.app.fetch(new Request('https://api.example.com/api/orders/ord_000000000000000000000000?token=wrong',{headers:{Origin:'https://private-preview.example.com'}}),f.env);
  assert.equal(receipt.status,404);assert.equal(receipt.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await f.checkout()).status,200);assert.equal(f.stripe.calls,1);
});

test('public catalog exposes only explicit USD retail prices and usable synced variants',async()=>{
  const f=await fixture(); const response=await f.request('/api/products');
  const v=response.body.products[0].variants[0];
  assert.equal(response.body.checkout_ready,true);
  assert.equal(v.price.amount,3200);assert.equal(v.available,true);assert.equal(v.max_quantity,10);
  assert.equal(response.body.products[0].external_id,'listing-137');assert.equal(v.size,'M');
  assert.equal(JSON.stringify(response.body).includes('fixture-print'),false);
  for(const change of [{synced:false},{is_ignored:true},{retail_price:null},{currency:'EUR'},{availability_status:'out_of_stock'},{files:[]}]) assert.equal(await normalizeVariant({...rawVariant(),...change},{id:101}),null);
});
test('server calculates price and shipping; rejects client price tampering',async()=>{
  const f=await fixture();
  assert.equal((await f.checkout({items:[{...f.items[0],price:1}]})).status,400);
  assert.equal((await f.checkout({amount:1})).status,400);
  assert.equal(f.stripe.calls,0);
  const result=await f.checkout();assert.equal(result.status,200);
  const params=f.stripe.sessions.get('cs_fixture_1').params;
  assert.equal(params.line_items[0].price_data.unit_amount,3200);
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount,500);
  assert.equal(params.ui_mode,'hosted_page');assert.equal('payment_method_types' in params,false);
  assert.match(params.integration_identifier,/-[a-z]{8}$/);
});
test('invalid variants, unsynced variants, unavailable stock and changed price never create Checkout',async()=>{
  const f=await fixture();
  assert.equal((await f.checkout({items:[{...f.items[0],variant_id:'999'}]})).status,422);
  f.printful.variants.get('501').synced=false;assert.equal((await f.checkout()).status,422);
  f.printful.variants.get('501').synced=true;f.printful.variants.get('501').retail_price='33.00';
  assert.equal((await f.checkout()).status,409);assert.equal(f.stripe.calls,0);
});
test('quantity bounds and duplicate variants cannot bypass cart validation',async()=>{
  const f=await fixture();
  for(const quantity of [0,-1,1.1,11,'1'])assert.equal((await f.checkout({items:[{...f.items[0],quantity}]})).status,400);
  assert.equal((await f.checkout({items:[...f.items,...f.items]})).status,400);
  assert.equal(f.stripe.calls,0);
});
test('missing shipping/tax decisions and untrusted origins block checkout without inventing charges',async()=>{
  const f=await fixture({SHIPPING_MODE:''});assert.equal((await f.checkout()).status,503);
  assert.equal((await f.request('/api/commerce-config')).body.checkout_ready,false);
  assert.equal((await f.request('/api/products')).body.checkout_ready,false);
  f.env.SHIPPING_MODE='free';f.env.STRIPE_TAX_MODE='automatic';assert.equal((await f.checkout()).status,503);
  f.env.STRIPE_TAX_MODE='none';
  assert.equal((await f.request('/api/checkout',{items:f.items},{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal(f.stripe.calls,0);
});
test('readiness is server-authoritative on products and closes for disabled fulfillment or stale catalog',async()=>{
  const f=await fixture();assert.equal((await f.request('/api/products')).body.checkout_ready,true);
  f.env.FULFILLMENT_ENABLED='false';assert.equal((await f.request('/api/products')).body.checkout_ready,false);
  f.env.FULFILLMENT_ENABLED='true';f.advance(86401);
  const response=await f.request('/api/products');assert.equal(response.body.checkout_ready,false);assert.equal(response.body.products[0].variants[0].available,false);
});
test('unchanged retry returns the same order/session; changed cart cannot reuse request key',async()=>{
  const f=await fixture();const request_id=crypto.randomUUID();
  const a=await f.checkout({request_id});const b=await f.checkout({request_id});
  assert.equal(a.body.checkout_url,b.body.checkout_url);assert.equal(a.body.order_id,b.body.order_id);assert.equal(f.stripe.calls,1);
  assert.equal((await f.checkout({request_id,items:[{...f.items[0],quantity:2}]})).status,409);
  assert.equal((await f.store.all('SELECT id FROM commerce_orders')).length,1);
});
test('an ambiguous Stripe creation timeout recovers the same idempotent session',async()=>{
  const f=await fixture();const request_id=crypto.randomUUID();f.stripe.timeout=true;
  assert.equal((await f.checkout({request_id})).status,503);
  assert.equal((await f.checkout({request_id})).status,200);
  assert.equal(f.stripe.sessions.size,1);assert.equal((await f.store.all('SELECT id FROM commerce_orders')).length,1);
});
test('database rejects mutation of an existing order snapshot',async()=>{
  const f=await fixture();const order=(await f.checkout()).body.order_id;
  await assert.rejects(f.store.run("UPDATE commerce_orders SET snapshot_json='{}' WHERE id=?",order),/immutable/);
});
test('invalid signature, unrelated events and unpaid completion never fulfill',async()=>{
  const f=await fixture();await f.checkout();
  assert.equal((await f.webhook(undefined,undefined,undefined,{'Stripe-Signature':'bad'})).status,400);
  assert.equal((await f.webhook('payment_intent.succeeded','evt_other')).status,200);
  assert.equal((await f.webhook()).status,200);
  assert.equal(f.printful.createCalls,0);assert.equal((await f.store.orderBySession('cs_fixture_1')).payment_status,'pending');
});
test('paid webhook creates and confirms one Printful order; duplicate and separate paid events stay idempotent',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');
  assert.equal((await f.webhook()).status,200);assert.equal((await f.webhook()).body.duplicate,true);
  assert.equal((await f.webhook('checkout.session.async_payment_succeeded','evt_second')).status,200);
  assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
  assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'confirmed');
});
test('concurrent delivery of the same paid event is leased and still confirms once',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');
  const results=await Promise.all([f.webhook(),f.webhook()]);
  assert.equal(results.some(result=>result.status===200),true);
  assert.equal(results.every(result=>[200,503].includes(result.status)),true);
  assert.equal((await f.webhook()).status,200);assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
});
test('expired worker lease recovers a durably queued paid order after a crashed attempt',async()=>{
  const f=await fixture();const id=(await f.checkout()).body.order_id;f.stripe.pay('cs_fixture_1');
  f.env.FULFILLMENT_ENABLED='false';await f.webhook();
  await f.store.run("UPDATE commerce_orders SET fulfillment_status='processing',lease_until=?,claim_id='crashed-worker' WHERE id=?",f.now()+300,id);
  f.env.FULFILLMENT_ENABLED='true';await f.app.scheduled({cron:'* * * * *'},f.env);assert.equal(f.printful.createCalls,0);
  f.advance(301);await f.app.scheduled({cron:'* * * * *'},f.env);assert.equal((await f.store.order(id)).fulfillment_status,'confirmed');assert.equal(f.printful.confirmCalls,1);
});
test('asynchronous payment waits until the session is paid',async()=>{
  const f=await fixture();await f.checkout();await f.webhook();assert.equal(f.printful.createCalls,0);
  f.stripe.pay('cs_fixture_1');await f.webhook('checkout.session.async_payment_succeeded','evt_async');assert.equal(f.printful.confirmCalls,1);
});
test('failed payment cannot be retried into fulfillment',async()=>{
  const f=await fixture();const id=(await f.checkout()).body.order_id;
  await f.webhook('checkout.session.async_payment_failed');
  assert.equal((await f.store.order(id)).payment_status,'failed');
  const result=await f.request(`/api/admin/orders/${id}/retry`,{}, {headers:{Authorization:`Bearer ${f.env.ADMIN_API_TOKEN}`}});
  assert.equal(result.status,409);assert.equal(f.printful.createCalls,0);
});
test('Stripe retrieval failure leaves webhook retryable; retry queues fulfillment once',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');f.stripe.retrieveFailure=true;
  assert.equal((await f.webhook()).status,503);assert.equal(f.printful.createCalls,0);
  assert.equal((await f.webhook()).status,200);assert.equal(f.printful.confirmCalls,1);
  assert.equal((await f.store.first('SELECT attempts FROM commerce_webhook_events WHERE id=?','evt_fixture_1')).attempts,2);
});
test('ambiguous draft creation is recovered by external ID without creating a second order',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');f.printful.createTimeout=true;
  await f.webhook();let order=await f.store.orderBySession('cs_fixture_1');assert.equal(order.fulfillment_status,'retry');
  f.advance(61);await f.app.scheduled({cron:'* * * * *'},f.env);
  order=await f.store.order(order.id);assert.equal(order.fulfillment_status,'confirmed');assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
});
test('ambiguous confirmation is recovered from supplier status without a second confirmation',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');f.printful.confirmTimeout=true;
  await f.webhook();assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'retry');
  f.advance(61);await f.app.scheduled({cron:'* * * * *'},f.env);
  assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'confirmed');assert.equal(f.printful.confirmCalls,1);assert.equal(f.printful.createCalls,1);
});
test('a supplier draft with an altered recipient is held rather than confirmed',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');f.printful.createTimeout=true;
  await f.webhook();const order=await f.store.orderBySession('cs_fixture_1');
  f.printful.orders.get(order.id).recipient.address1='456 Changed Address';
  f.advance(61);await f.app.scheduled({cron:'* * * * *'},f.env);
  assert.equal((await f.store.order(order.id)).fulfillment_status,'review');assert.equal(f.printful.confirmCalls,0);
});
test('changed artwork and supplier costs above the collected net amount require review before confirmation',async()=>{
  for(const change of ['artwork','cost']){
    const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');
    if(change==='artwork')f.printful.variants.get('501').files[0].hash='different-artwork';else f.printful.cost='99.00';
    await f.webhook();assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'review');assert.equal(f.printful.confirmCalls,0);
  }
});
test('test-mode Stripe payments never create real Printful drafts even when fulfillment flag is enabled',async()=>{
  const f=await fixture({STRIPE_MODE:'test'});await f.checkout();f.stripe.pay('cs_fixture_1');await f.webhook();
  assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'test_paid');assert.equal(f.printful.createCalls,0);
});
test('refunded or partially refunded payments never reach Printful',async()=>{
  const f=await fixture();await f.checkout();f.stripe.pay('cs_fixture_1');
  f.stripe.sessions.get('cs_fixture_1').payment_intent.latest_charge.amount_refunded=100;
  await f.webhook();assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'review');assert.equal(f.printful.createCalls,0);
});
test('calculated quote is bound to cart and exact recipient, with no second Stripe shipping collection',async()=>{
  const f=await fixture({SHIPPING_MODE:'calculated'});
  const recipient={name:'Test Customer',address1:'123 Test Street',address2:'',city:'Test City',state_code:'CA',country_code:'US',zip:'90001'};
  const quote=(await f.request('/api/shipping-quotes',{items:f.items,recipient})).body;
  assert.equal(quote.rates[0].amount,725);
  assert.equal((await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'UNKNOWN'})).status,400);
  assert.equal((await f.checkout({items:[{...f.items[0],quantity:2}],shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'})).status,409);
  assert.equal((await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'})).status,200);
  const params=f.stripe.sessions.get('cs_fixture_1').params;
  assert.equal(params.shipping_address_collection,undefined);assert.equal(params.payment_intent_data.shipping.address.line1,recipient.address1);
  assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount,725);
  f.stripe.pay('cs_fixture_1');await f.webhook();assert.equal(f.printful.confirmCalls,1);
});
test('expired shipping quotes and altered shipping destinations cannot reach fulfillment',async()=>{
  const f=await fixture({SHIPPING_MODE:'calculated'});
  const recipient={name:'Test Customer',address1:'123 Test Street',city:'Test City',state_code:'CA',country_code:'US',zip:'90001'};
  const quote=(await f.request('/api/shipping-quotes',{items:f.items,recipient})).body;
  await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'});
  f.stripe.pay('cs_fixture_1');f.stripe.sessions.get('cs_fixture_1').payment_intent.shipping.address.country='CA';
  await f.webhook();assert.equal(f.printful.confirmCalls,0);assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'review');
  f.advance(901);assert.equal((await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'})).status,409);
});
test('catalog generation stays unchanged until all resumable batches finish',async()=>{
  const f=await fixture();f.printful.products.clear();
  for(let i=201;i<=212;i++)f.printful.products.set(String(i),{sync_product:{id:i,external_id:`external-${i}`,name:`Fixture ${i}`,thumbnail_url:'https://example.com/mockup.png'},sync_variants:[rawVariant(i+1000,i)]});
  const auth={headers:{Authorization:`Bearer ${f.env.ADMIN_API_TOKEN}`}};
  const first=await f.request('/api/admin/catalog/sync',{},auth);assert.equal(first.body.complete,false);assert.equal(first.body.processed,10);
  assert.equal((await f.request('/api/products')).body.products[0].id,'101');
  const second=await f.request(`/api/admin/catalog/sync/${first.body.sync_id}`,{},auth);assert.equal(second.body.complete,true);
  assert.equal((await f.request('/api/products')).body.products.length,12);
});
