import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {recoveryEmail} from '../src/emails.mjs';

const mailer=()=>({sent:[],async send(message){this.sent.push(message);return {id:`m${this.sent.length}`};}});
const RECOVERY='https://buy.stripe.com/r/live_fixtureRecovery';
// The checkout.session.expired event as Stripe sends it: the whole expired session, with the recovery link.
const expired=(f,overrides={})=>{
  const session=f.stripe.sessions.get('cs_fixture_1');
  return {id:'cs_fixture_1',object:'checkout.session',status:'expired',livemode:f.stripe.live,client_reference_id:session.params.client_reference_id,metadata:session.params.metadata,customer_details:{email:'buyer@example.com'},after_expiration:{recovery:{enabled:true,allow_promotion_codes:false,url:RECOVERY}},...overrides};
};
const send=(f,object,id='evt_expired_1',type='checkout.session.expired')=>f.request('/api/webhooks/stripe',{id,type,livemode:f.stripe.live,data:{object}},{headers:{'Stripe-Signature':'fixture-signature'}});

test('checkout sessions ask Stripe for a recovery link without promotion codes',async()=>{
  const f=await fixture();
  await f.checkout();
  assert.deepEqual(f.stripe.sessions.get('cs_fixture_1').params.after_expiration,{recovery:{enabled:true,allow_promotion_codes:false}});
});

test('checkout still opens if Stripe refuses the recovery link',async()=>{
  const f=await fixture();
  const create=f.stripe.createSession.bind(f.stripe);
  f.stripe.createSession=async(params,key)=>{if(params.after_expiration)throw Object.assign(new Error('Invalid after_expiration'),{type:'StripeInvalidRequestError',param:'after_expiration[recovery][enabled]'});return create(params,key);};
  const res=await f.checkout();
  assert.equal(res.status,200);assert.match(res.body.checkout_url,/^https:\/\/checkout\.stripe\.com\//);
  assert.equal(f.stripe.sessions.get('cs_fixture_1').params.after_expiration,undefined);
});

test('an expired unpaid checkout sends one Nino reminder with the recovery link',async()=>{
  const MAILER=mailer();
  const f=await fixture({MAILER});
  await f.checkout();
  assert.equal((await send(f,expired(f))).status,200);
  assert.equal(MAILER.sent.length,1);
  const [mail]=MAILER.sent;
  assert.equal(mail.to,'buyer@example.com');
  assert.equal(mail.subject,'Your Nino order is still waiting');
  assert.ok(mail.html.includes(`href="${RECOVERY}"`));assert.ok(mail.text.includes(RECOVERY));
  assert.match(mail.html,/email-nino-mark\.png/);assert.match(mail.html,/Fixture graphic shirt/);
  assert.match(mail.html,/Menu-Made, 706 Kearny St, San Francisco, CA 94108/);assert.match(mail.text,/Menu-Made, 706 Kearny St, San Francisco, CA 94108/);
  assert.match(mail.html,/one-time reminder/);assert.doesNotMatch(mail.html,/Etsy|→|&rarr;/);
  // Stripe redelivers the event, and a second (different) event for the same order arrives: still one email.
  await send(f,expired(f));await send(f,expired(f),'evt_expired_2');
  assert.equal(MAILER.sent.length,1);
});

test('no reminder without an email, a recovery link, live mode, or when the order was paid',async()=>{
  const MAILER=mailer();
  let f=await fixture({MAILER});await f.checkout();
  await send(f,expired(f,{customer_details:{email:null}}));
  await send(f,expired(f,{after_expiration:null}),'evt_2');
  await send(f,expired(f,{after_expiration:{recovery:{url:'https://evil.example.com/r/x'}}}),'evt_3');
  await send(f,expired(f,{id:'cs_someone_else'}),'evt_4');
  assert.equal(MAILER.sent.length,0);
  await send(f,expired(f,{customer_details:null,customer_email:'given@example.com'}),'evt_5');
  assert.deepEqual(MAILER.sent.map(m=>m.to),['given@example.com'],'customer_email is used when customer_details has none');

  const test=mailer();
  f=await fixture({MAILER:test,STRIPE_MODE:'test'});await f.checkout();
  await send(f,expired(f));
  assert.equal(test.sent.length,0,'test-mode checkouts never email');

  const paid=mailer();
  f=await fixture({MAILER:paid});await f.checkout();f.stripe.pay('cs_fixture_1');await f.webhook();
  const after=paid.sent.length;
  await send(f,expired(f),'evt_expired_paid');
  assert.equal(paid.sent.length,after,'a paid order gets no reminder');
});

test('no reminder when the same buyer has paid a newer order',async()=>{
  const MAILER=mailer();
  const f=await fixture({MAILER});
  await f.checkout();                                    // abandoned: cs_fixture_1
  await f.checkout();f.stripe.pay('cs_fixture_2');await f.webhook('checkout.session.completed','evt_paid','cs_fixture_2');
  const before=MAILER.sent.length;
  await send(f,expired(f));
  assert.equal(MAILER.sent.length,before);
});

test('a failed send is retried on redelivery and then sent once',async()=>{
  let down=true;const sent=[];
  const f=await fixture({MAILER:{async send(message){if(down)throw new Error('mailer down');sent.push(message);}}});
  await f.checkout();
  const first=await send(f,expired(f));
  assert.notEqual(first.status,200,'Stripe is told to redeliver');
  down=false;
  assert.equal((await send(f,expired(f))).status,200);
  assert.equal(sent.length,1);
});

test('paying through the recovery link fulfils the original order',async()=>{
  const MAILER=mailer();
  const f=await fixture({MAILER});
  await f.checkout();
  const original=await f.store.orderBySession('cs_fixture_1');
  await send(f,expired(f));
  // Stripe copies the expired session into a new one when the buyer opens the recovery link.
  const copy=structuredClone(f.stripe.sessions.get('cs_fixture_1'));
  f.stripe.sessions.set('cs_recovered_1',{...copy,id:'cs_recovered_1',recovered_from:'cs_fixture_1'});
  f.stripe.pay('cs_recovered_1');
  const res=await send(f,{id:'cs_recovered_1',object:'checkout.session',recovered_from:'cs_fixture_1',client_reference_id:original.id,livemode:true},'evt_recovered_paid','checkout.session.completed');
  assert.equal(res.status,200);
  const order=await f.store.order(original.id);
  assert.equal(order.stripe_session_id,'cs_recovered_1');assert.equal(order.payment_status,'paid');assert.equal(order.fulfillment_status,'confirmed');
  assert.equal(f.printful.confirmCalls,1);
});

test('a recovered session for another order is not attached',async()=>{
  const f=await fixture();
  await f.checkout();
  const res=await send(f,{id:'cs_recovered_x',recovered_from:'cs_fixture_1',client_reference_id:'ord_not_this_one',livemode:true},'evt_x','checkout.session.completed');
  assert.equal(res.status,200);
  assert.equal((await f.store.orderBySession('cs_fixture_1')).payment_status,'pending');
});

test('reminder content is escaped',()=>{
  const order={id:'ord_abc',snapshot_json:JSON.stringify({subtotal_cents:2600,shipping:{name:'Flat'},lines:[{title:'Shirt <i>',quantity:1,line_total_cents:2600,variant:{color:'Black',size:'M'}}]})};
  const mail=recoveryEmail(order,'b@example.com','https://buy.stripe.com/r/live_x?a=1&b=2');
  assert.doesNotMatch(mail.html,/Shirt <i>/);assert.match(mail.html,/Shirt &lt;i&gt;/);assert.match(mail.html,/a=1&amp;b=2/);
});
