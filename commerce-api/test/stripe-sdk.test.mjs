import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeClient} from '../src/providers.mjs';

async function signature(raw,secret,timestamp) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${raw}`)));
  return `t=${timestamp},v1=${[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}
test('actual Stripe SDK verifies raw payload signature, rejects tampering and expired timestamps without network calls',async()=>{
  const client=await createStripeClient({STRIPE_SECRET_KEY:'rk_test_fixture_not_a_real_key'});
  const raw=JSON.stringify({id:'evt_sdk_fixture',object:'event',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_fixture'}}});
  const secret='whsec_fixture_not_a_real_secret';const timestamp=Math.floor(Date.now()/1000);
  const header=await signature(raw,secret,timestamp);
  assert.equal((await client.verifyWebhook(raw,header,secret)).id,'evt_sdk_fixture');
  await assert.rejects(client.verifyWebhook(raw.replace('cs_fixture','cs_changed'),header,secret));
  await assert.rejects(client.verifyWebhook(raw,await signature(raw,secret,timestamp-600),secret));
});
