import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {runSelfCheck,lastSelfCheck} from '../src/selfcheck.mjs';

const ENV={STRIPE_ACCOUNT_ID:'acct_fixtureNino',COMMERCE_API_ORIGIN:'https://api.example.com'};
const setup=async()=>{const f=await fixture(ENV);const now=Math.floor(Date.now()/1000);return {f,now,run:()=>runSelfCheck(f.store,f.stripe,f.printful,f.env,now)};};
const failed=result=>result.checks.filter(c=>!c.ok).map(c=>`${c.name}: ${c.detail}`).join(' | ');

test('a healthy shop passes every check and leaves no Printful order behind',async()=>{
  const {f,run}=await setup();
  const result=await run();
  assert.equal(result.ok,true,failed(result));
  assert.equal(result.checks.length,5);
  assert.equal(f.printful.confirmCalls,0,'the test draft is never confirmed');
  assert.deepEqual(f.printful.deleted,['1001']);assert.equal(f.printful.orders.size,0);
  assert.equal((await lastSelfCheck(f.store)).ok,true);
  const health=(await f.request('/api/health')).body;assert.deepEqual(health.selfcheck.failed,[]);assert.equal(health.selfcheck.ok,true);
});

test('a Stripe key from another account fails the check (Oct 28: menu-made key in the shirt shop)',async()=>{
  const {f,run}=await setup();f.stripe.accountId='acct_menuMade';
  assert.match(failed(await run()),/key belongs to acct_menuMade, not acct_fixtureNino/);
});

test('a missing or disabled webhook fails the check',async()=>{
  const {f,run}=await setup();f.stripe.endpoints=[{id:'we_other',url:'https://menu-made.com/api/stripe-webhook',status:'enabled',enabled_events:['checkout.session.completed']}];
  assert.match(failed(await run()),/no webhook in the Stripe account points at https:\/\/api\.example\.com\/api\/webhooks\/stripe/);
});

test('a paid checkout the shop never processed fails the check (Oct 28: wrong webhook secret)',async()=>{
  const {f,now,run}=await setup();
  f.stripe.events=[{id:'evt_missed',created:now-3600,livemode:true},{id:'evt_too_new',created:now-60,livemode:true}];
  const result=await run();
  assert.match(failed(result),/1 paid checkout\(s\) never reached the shop \(evt_missed\).*STRIPE_WEBHOOK_SECRET/);
  await f.store.run("INSERT INTO commerce_webhook_events(id,event_type,payload_hash,status,lease_until,attempts,created_at,processed_at) VALUES('evt_missed','checkout.session.completed','x','processed',0,1,?,?)",now,now);
  assert.equal((await run()).ok,true);
});

test('a paid order not sent to Printful within 2 hours fails the check',async()=>{
  const {f,now,run}=await setup();
  await f.store.run("INSERT INTO commerce_orders(id,request_key,request_hash,snapshot_json,receipt_token,live_mode,payment_status,fulfillment_status,last_error,created_at,updated_at) VALUES('ord_stuck','k','h','{}','t',1,'paid','retry','printful_request_failed: POST /orders 401',?,?)",now-3*3600,now);
  assert.match(failed(await run()),/ord_stuck is retry \(printful_request_failed: POST \/orders 401\)/);
});

test('a Printful token that cannot create orders fails the check',async()=>{
  const {f,run}=await setup();f.printful.createDraft=async()=>{const e=new Error('POST /orders 401: Unauthorized');e.code='printful_request_failed';throw e;};
  assert.match(failed(await run()),/Printful accepts orders.*401: Unauthorized/);
});
