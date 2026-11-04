// The scheduled run adds checkout.session.expired to the shop's Stripe webhook once, keeping existing events.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureWebhookEvents} from '../src/webhook-events.mjs';

function store() {
  const rows=new Map();
  return {rows,
    async first(sql,key) { return rows.has(key) ? {value:rows.get(key)} : null; },
    async run(sql,key,value) { rows.set(key,value); }};
}
const env={STRIPE_MODE:'live',STRIPE_SECRET_KEY:'sk_live_x',COMMERCE_API_ORIGIN:'https://nino-printful-commerce-api.ijpbattaglia.workers.dev'};
const URL_='https://nino-printful-commerce-api.ijpbattaglia.workers.dev/api/webhooks/stripe';
const NOW=1793800000;

test('adds the missing event once, keeping the three already there', async () => {
  const s=store(); const updates=[];
  const stripe={ listWebhookEndpoints:async()=>({data:[{id:'we_1',url:URL_,enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed']}]}),
    updateWebhookEndpoint:async(id,params)=>{updates.push([id,params]);} };
  const r=await ensureWebhookEvents(s,stripe,env,NOW);
  assert.deepEqual(r,{ok:true,added:['checkout.session.expired']});
  assert.deepEqual(updates,[['we_1',{enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired']}]]);
  assert.deepEqual(await ensureWebhookEvents(s,stripe,env,NOW+300),{skipped:'done'});
  assert.equal(updates.length,1);
});

test('a refused key is recorded and retried after 6 hours, not every run', async () => {
  const s=store(); let calls=0;
  const stripe={ listWebhookEndpoints:async()=>{calls++; throw new Error('The provided key does not have the required permissions');}, updateWebhookEndpoint:async()=>{} };
  assert.equal((await ensureWebhookEvents(s,stripe,env,NOW)).ok,false);
  assert.match(s.rows.get('webhook_events_v2'),/^failed .*required permissions/);
  assert.deepEqual(await ensureWebhookEvents(s,stripe,env,NOW+600),{skipped:'recently failed'});
  await ensureWebhookEvents(s,stripe,env,NOW+7*3600);
  assert.equal(calls,2);
});

test('nothing happens outside live mode', async () => {
  assert.deepEqual(await ensureWebhookEvents(store(),{},{...env,STRIPE_MODE:'test'},NOW),{skipped:'not live'});
});
