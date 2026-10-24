import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';

test('measurement rejects foreign origins, unknown fields and product IDs; respects privacy signals',async()=>{
  const f=await fixture();
  assert.equal((await f.request('/api/measurement',{event:'page_view'},{headers:{Origin:'https://other.example'}})).status,403);
  for(const payload of [{event:'purchase'}, {event:'page_view',email:'private@example.com'},{event:'page_view',product_id:'101'}, {event:'product_view',product_id:'buyer@example.com'}]) assert.equal((await f.request('/api/measurement',payload)).status,400);
  assert.equal((await f.request('/api/measurement',{event:'product_view',product_id:'999'})).body.recorded,false);
  assert.equal((await f.request('/api/measurement',{event:'page_view'},{headers:{DNT:'1'}})).body.recorded,false);
  assert.equal((await f.request('/api/measurement',{event:'page_view'},{headers:{'Sec-GPC':'1'}})).body.recorded,false);
  assert.equal((await f.request('/api/measurement',{event:'product_view',product_id:'101'})).body.recorded,true);
  const rows=await f.store.all('SELECT * FROM shopping_measurement');
  assert.equal(rows.length,1);assert.equal(rows[0].total,1);assert.deepEqual(Object.keys(rows[0]).sort(),['day','event','mode','product_id','total']);
});

test('measurement separates modes, caps daily writes and removes expired aggregates',async()=>{
  const f=await fixture();
  const old=new Date((f.now()-90*86400)*1000).toISOString().slice(0,10);
  await f.store.run("INSERT INTO shopping_measurement VALUES(?,'live','page_view','',2)",old);
  await f.request('/api/measurement',{event:'page_view'});
  f.env.STRIPE_MODE='test';await f.request('/api/measurement',{event:'page_view'});
  const rows=await f.store.all('SELECT * FROM shopping_measurement');
  assert.equal(rows.length,2);assert.equal(rows.reduce((sum,row)=>sum+row.total,0),2);
  await f.store.run("UPDATE shopping_measurement SET total=9999 WHERE mode='test'");
  assert.equal((await f.request('/api/measurement',{event:'checkout_attempt'})).body.recorded,false);
  assert.equal((await f.request('/api/measurement',{event:'page_view',extra:'x'.repeat(300)})).status,413);
});

test('admin report is protected; live purchases count once and retain their first verified payment day',async()=>{
  const f=await fixture({FULFILLMENT_ENABLED:'false',STRIPE_MODE:'test'});
  assert.equal((await f.request('/api/admin/measurement')).status,401);
  assert.equal((await f.checkout()).status,200);
  f.stripe.pay('cs_fixture_1');await f.webhook();
  const report=()=>f.request('/api/admin/measurement',undefined,{headers:{Authorization:'Bearer fixture_admin_not_a_token'}});
  assert.deepEqual((await report()).body.confirmed_live_purchases,[]);
  const live=await fixture();const purchase=await live.checkout();assert.equal(purchase.status,200);
  live.stripe.pay('cs_fixture_1');assert.equal((await live.webhook()).status,200);
  const paidAt=(await live.store.order(purchase.body.order_id)).paid_at;assert.equal(paidAt,live.now());
  live.advance(86400);await live.store.run('UPDATE commerce_orders SET updated_at=? WHERE id=?',live.now(),purchase.body.order_id);
  await live.webhook('checkout.session.completed','evt_duplicate');
  assert.equal((await live.store.order(purchase.body.order_id)).paid_at,paidAt);
  const result=await live.request('/api/admin/measurement',undefined,{headers:{Authorization:'Bearer fixture_admin_not_a_token'}});
  assert.equal(result.status,200);assert.equal(result.body.confirmed_live_purchases.length,1);assert.equal(result.body.confirmed_live_purchases[0].paid_orders,1);
});

test('scheduled retention cleanup works even before Printful credentials are configured',async()=>{
  const f=await fixture({PRINTFUL_ACCESS_TOKEN:'',PRINTFUL_STORE_ID:''});
  await f.store.run("INSERT INTO shopping_measurement VALUES('2000-01-01','live','page_view','',1)");
  await f.app.scheduled({cron:'0 10 * * *'},f.env);
  assert.equal((await f.store.all('SELECT * FROM shopping_measurement')).length,0);
});
