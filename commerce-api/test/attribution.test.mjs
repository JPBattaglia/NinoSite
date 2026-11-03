import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {checkoutAttribution} from '../src/checkout.mjs';

// Marketing plan v4 (Nov 3, 2026): a paid order records which ad campaign brought it, labels only.
test('checkout keeps campaign labels on the order snapshot and the Stripe session',async()=>{
  const f=await fixture();
  const response=await f.checkout({attribution:{source:'google',medium:'cpc',campaign:'nino-shop'}});
  assert.equal(response.status,200);
  const order=await f.store.first('SELECT snapshot_json FROM commerce_orders');
  assert.deepEqual(JSON.parse(order.snapshot_json).attribution,{source:'google',medium:'cpc',campaign:'nino-shop'});
  const session=[...f.stripe.sessions.values()][0];
  assert.equal(session.params.metadata.utm_campaign,'nino-shop');
  assert.equal(session.params.metadata.utm_source,'google');
});

test('checkout without attribution is unchanged, and malformed labels are dropped instead of failing',async()=>{
  const f=await fixture();
  assert.equal((await f.checkout()).status,200);
  let order=await f.store.first('SELECT snapshot_json FROM commerce_orders');
  assert.equal(JSON.parse(order.snapshot_json).attribution,undefined);
  const g=await fixture();
  assert.equal((await g.checkout({attribution:{source:'<script>',campaign:'x'.repeat(80),email:'a@b.c'}})).status,200);
  order=await g.store.first('SELECT snapshot_json FROM commerce_orders');
  assert.equal(JSON.parse(order.snapshot_json).attribution,undefined);
  assert.equal([...g.stripe.sessions.values()][0].params.metadata.utm_campaign,undefined);
});

test('attribution parser accepts only short lowercase-able tokens for source, medium and campaign',()=>{
  assert.deepEqual(checkoutAttribution({source:'Google',medium:'shopping_feed'}),{source:'google',medium:'shopping_feed'});
  assert.equal(checkoutAttribution({medium:'cpc'}),null);
  assert.equal(checkoutAttribution('google'),null);
  assert.equal(checkoutAttribution([{source:'google'}]),null);
  assert.deepEqual(checkoutAttribution({source:'google',campaign:'nino shop'}),{source:'google'});
});
