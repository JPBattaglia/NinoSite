import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {PRINTFUL_COUNTRY_CACHE_KEY} from '../src/countries.mjs';
import {BLOCKED_COUNTRIES} from '../src/common.mjs';

const address={name:'Fixture Customer',address1:'123 Fixture Street',city:'Fixture City',state_code:'ON',country_code:'CA',zip:'A1A 1A1'};
const auth=f=>({headers:{Authorization:`Bearer ${f.env.ADMIN_API_TOKEN}`}});

test('embargoed destinations are never offered, even from an explicit or provider-supplied list',async()=>{
  assert.deepEqual([...BLOCKED_COUNTRIES],['CU','IR','KP','SY']);
  const explicit=await fixture({SHIPPING_COUNTRIES:'US,CU,IR,KP,SY,CA'});
  assert.deepEqual((await explicit.request('/api/products')).body.shipping_countries,['US','CA']);
  assert.equal((await explicit.checkout()).status,200);
  assert.deepEqual(explicit.stripe.sessions.get('cs_fixture_1').params.shipping_address_collection.allowed_countries,['US','CA']);

  const dynamic=await fixture({SHIPPING_COUNTRIES:'PRINTFUL',SHIPPING_MODE:'calculated'});
  dynamic.printful.getCountries=async()=>['US','CA','IR','KP','SY','CU','DE'].map(code=>({code,name:code,states:[]}));
  assert.deepEqual((await dynamic.request('/api/commerce-config')).body.shipping_countries,['CA','DE','US']);
  for(const country_code of ['IR','KP','SY','CU']) {
    const denied=await dynamic.request('/api/shipping-quotes',{items:dynamic.items,recipient:{...address,country_code}});
    assert.equal(denied.status,400);assert.equal(denied.body.error,'shipping_country_unavailable');
  }
  assert.equal(dynamic.printful.rateCalls,0);
  const allowed=await dynamic.request('/api/shipping-quotes',{items:dynamic.items,recipient:address});
  assert.equal(allowed.status,200);
});

test('a list containing only embargoed countries leaves checkout closed',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'IR,KP'});
  const config=await f.request('/api/commerce-config');
  assert.equal(config.body.checkout_ready,false);assert.deepEqual(config.body.shipping_countries,[]);
  assert.equal((await f.checkout()).status,503);assert.equal(f.stripe.calls,0);
});

test('an order the webhook sent to review is fulfilled by the admin retry once the payment verifies',async()=>{
  const f=await fixture();const id=(await f.checkout()).body.order_id;f.stripe.pay('cs_fixture_1');
  const session=f.stripe.sessions.get('cs_fixture_1');const real=session.amount_total;
  session.amount_total=real+1; // a total mismatch the webhook treats as a review case
  assert.equal((await f.webhook()).status,200);
  let order=await f.store.order(id);
  assert.equal(order.payment_status,'paid');assert.equal(order.fulfillment_status,'review');
  assert.equal(order.recipient_json,null);assert.equal(order.customer_email,null);assert.equal(f.printful.createCalls,0);
  // Still mismatched: the retry must keep holding it and must not invent an address.
  assert.equal((await f.request(`/api/admin/orders/${id}/retry`,{},auth(f))).status,200);
  order=await f.store.order(id);assert.equal(order.fulfillment_status,'review');assert.equal(order.recipient_json,null);assert.equal(f.printful.createCalls,0);
  // Cause resolved: the retry verifies the payment, stores the verified details and confirms exactly once.
  session.amount_total=real;
  const retry=await f.request(`/api/admin/orders/${id}/retry`,{},auth(f));
  assert.equal(retry.status,200);assert.equal(retry.body.confirmed,true);
  order=await f.store.order(id);
  assert.equal(order.fulfillment_status,'confirmed');assert.equal(order.customer_email,'buyer@example.com');
  assert.equal(JSON.parse(order.recipient_json).country_code,'US');assert.equal(order.paid_total_cents,real);
  assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
  assert.equal((await f.request(`/api/admin/orders/${id}/retry`,{},auth(f))).status,409);
});
