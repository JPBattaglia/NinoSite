import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {deliveryEstimate,buyerEmail,ownerEmail} from '../src/emails.mjs';

const mailer=()=>({sent:[],async send(message){this.sent.push(message);return {id:`m${this.sent.length}`};}});
const recipient={name:'Test Customer',address1:'123 Test Street',city:'Test City',state_code:'CA',country_code:'US',zip:'90001'};

test('the delivery estimate comes from Printful\'s rate name',()=>{
  assert.equal(deliveryEstimate('Flat Rate (Estimated delivery: Nov 3⁠–5) '),'Nov 3–5');
  assert.equal(deliveryEstimate('Standard'),null);
});

test('a confirmed order emails the buyer and the owner once each',async()=>{
  const MAILER=mailer();
  const f=await fixture({SHIPPING_MODE:'calculated',OWNER_EMAIL:'owner@example.com',MAILER});
  const quote=(await f.request('/api/shipping-quotes',{items:f.items,recipient})).body;
  await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'});
  f.stripe.pay('cs_fixture_1');await f.webhook();
  assert.equal(f.printful.confirmCalls,1);
  assert.deepEqual(MAILER.sent.map(m=>m.to),['buyer@example.com','owner@example.com']);
  const [buyer,owner]=MAILER.sent;
  assert.match(buyer.subject,/order is confirmed/);assert.match(buyer.html,/email-nino-mark\.png/);assert.match(buyer.html,/Fixture graphic shirt/);
  assert.match(buyer.html,/Thank you, Test!/);assert.match(buyer.text,/Total paid \$/);
  assert.match(owner.subject,/^New shirt sale — \$/);assert.match(owner.html,/sent to Printful automatically as order <strong>1001<\/strong>/);
  await f.webhook();
  assert.equal(MAILER.sent.length,2,'a repeated webhook sends nothing new');
});

test('an order sent to review alerts the owner and does not confirm to the buyer',async()=>{
  const MAILER=mailer();
  const f=await fixture({SHIPPING_MODE:'calculated',OWNER_EMAIL:'owner@example.com',MAILER});
  const quote=(await f.request('/api/shipping-quotes',{items:f.items,recipient})).body;
  await f.checkout({shipping_quote_id:quote.quote_id,shipping_rate_id:'STANDARD'});
  f.stripe.pay('cs_fixture_1');f.stripe.sessions.get('cs_fixture_1').payment_intent.shipping.address.country='CA';
  await f.webhook();
  assert.deepEqual(MAILER.sent.map(m=>m.to),['owner@example.com']);
  assert.match(MAILER.sent[0].subject,/needs attention/);assert.match(MAILER.sent[0].html,/not<\/strong> sent to Printful/);
});

test('a mailer failure never blocks fulfilment',async()=>{
  const MAILER={async send(){throw new Error('mailer down');}};
  const f=await fixture({OWNER_EMAIL:'owner@example.com',MAILER});
  await f.checkout();f.stripe.pay('cs_fixture_1');await f.webhook();
  assert.equal(f.printful.confirmCalls,1);
  assert.equal((await f.store.orderBySession('cs_fixture_1')).fulfillment_status,'confirmed');
});

test('names and addresses are escaped in the email',()=>{
  const order={id:'ord_abc',payment_status:'paid',paid_total_cents:3319,paid_tax_cents:224,paid_shipping_cents:495,customer_email:'b@example.com',
    recipient_json:JSON.stringify({...recipient,name:'<b>Eve</b>'}),snapshot_json:JSON.stringify({subtotal_cents:2600,shipping:{name:'Flat (Estimated delivery: Nov 3–5)'},lines:[{title:'Shirt <i>',quantity:1,line_total_cents:2600,variant:{color:'Black',size:'M'}}]})};
  const html=buyerEmail(order).html+ownerEmail(order,'o@example.com').html;
  assert.doesNotMatch(html,/<b>Eve|Shirt <i>/);assert.match(html,/&lt;b&gt;Eve/);assert.match(buyerEmail(order).subject,/arriving Nov 3–5/);
});
