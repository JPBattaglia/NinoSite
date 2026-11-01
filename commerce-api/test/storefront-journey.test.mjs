import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {runSmoke} from '../scripts/smoke.mjs';

// These replace placing real or Stripe test orders by hand: the whole purchase journey runs against in-memory
// stand-ins for D1, Stripe and Printful, so no card is charged and no Printful order can be created.
const address={name:'Fixture Customer',address1:'123 Fixture Street',city:'Fixture City',state_code:'CA',country_code:'US',zip:'90001'};

test('full journey: quote, checkout, payment webhook, fulfillment, receipt, and a replayed webhook',async()=>{
  const f=await fixture({SHIPPING_MODE:'calculated'});
  const quote=await f.request('/api/shipping-quotes',{items:f.items,recipient:address});
  assert.equal(quote.status,200);
  const checkout=await f.checkout({shipping_quote_id:quote.body.quote_id,shipping_rate_id:quote.body.rates[0].id});
  assert.equal(checkout.status,200);assert.match(checkout.body.checkout_url,/^https:\/\/checkout\.stripe\.com\//);
  const before=await f.request(`/api/orders/${checkout.body.order_id}?token=${checkout.body.receipt_token}`);
  assert.equal(before.body.payment_status,'pending');
  f.stripe.pay('cs_fixture_1');
  assert.equal((await f.webhook()).status,200);
  const receipt=await f.request(`/api/orders/${checkout.body.order_id}?token=${checkout.body.receipt_token}`);
  assert.equal(receipt.body.payment_status,'paid');assert.equal(receipt.body.fulfillment_status,'confirmed');
  assert.equal(receipt.body.total_cents,3200+725);
  assert.equal((await f.request(`/api/orders/${checkout.body.order_id}?token=wrong`)).status,404);
  assert.equal((await f.webhook()).body.duplicate,true);
  assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
});

test('test-mode payments never create a Printful order',async()=>{
  const f=await fixture({STRIPE_MODE:'test'});
  const checkout=await f.checkout();assert.equal(checkout.status,200);
  f.stripe.pay('cs_fixture_1');assert.equal((await f.webhook()).status,200);
  const order=await f.store.order(checkout.body.order_id);
  assert.equal(order.payment_status,'paid');assert.equal(order.fulfillment_status,'test_paid');
  assert.equal(f.printful.createCalls,0);assert.equal(f.printful.confirmCalls,0);
});

test('a cancelled or unpaid checkout never reaches fulfillment, and a tampered price is rejected before Stripe',async()=>{
  const f=await fixture();
  assert.equal((await f.request('/api/checkout',{items:[{product_id:'101',variant_id:'501',quantity:1,price:1}],request_id:crypto.randomUUID()})).status,400);
  assert.equal(f.stripe.calls,0);
  const checkout=await f.checkout();assert.equal(checkout.status,200);
  assert.equal((await f.webhook()).status,200); // session still unpaid
  assert.equal((await f.store.order(checkout.body.order_id)).payment_status,'pending');
  assert.equal(f.printful.createCalls,0);
});

function fakeSite({products=130,countries=['US','CA'],checkoutReady=true,drop='',selfcheck={ok:true,checked_at:Math.floor(Date.now()/1000)-3600,failed:[]}}={}) {
  const list=Array.from({length:products},(_,i)=>({title:`Design ${i}`,image:`https://img.example.com/${i}.jpg`,variants:[{available:true}]}));
  return async url=>{
    url=String(url);
    if(url.includes(drop)&&drop) return new Response('gone',{status:500});
    if(url.endsWith('/api/health')) return Response.json({ok:true,payment_mode:'live',selfcheck});
    if(url.endsWith('/api/commerce-config')) return Response.json({catalog_ready:true,checkout_ready:checkoutReady,shipping_countries:countries});
    if(url.endsWith('/api/products')) return Response.json({products:list});
    if(url.includes('/api/unsubscribe?')) return new Response('bad link',{status:400});
    if(url.includes('/api/subscribe/confirm?')) return new Response(null,{status:303,headers:{location:'https://ninobattaglia.com/?signup=expired'}});
    if(url.endsWith('/index.html')) return new Response('<script src="signup.js?v=1" defer></script>',{status:200});
    if(url.startsWith('https://img.example.com/')) return new Response('x',{status:200,headers:{'content-type':'image/jpeg'}});
    return new Response('ok',{status:200});
  };
}

test('smoke check passes on a healthy shop and reports each kind of breakage',async()=>{
  const ok=await runSmoke(fakeSite());
  assert.equal(ok.every(result=>result.ok),true,JSON.stringify(ok.filter(result=>!result.ok)));
  const failing=async(options,pattern)=>{
    const results=await runSmoke(fakeSite(options));
    const bad=results.filter(result=>!result.ok);
    assert.equal(bad.length>0,true,`expected a failure for ${JSON.stringify(options)}`);
    assert.match(bad.map(result=>result.detail).join(' '),pattern);
  };
  await failing({checkoutReady:false},/checkout is not ready/);
  await failing({countries:['US','IR']},/embargoed countries offered: IR/);
  await failing({products:20},/only 20 products/);
  await failing({drop:'/quiz.html'},/quiz\.html answered 500/);
  await failing({drop:'/api/unsubscribe'},/unsubscribe with a bad link answered 500/);
  await failing({selfcheck:{ok:false,checked_at:Math.floor(Date.now()/1000),failed:['Recent payments reached the shop']}},/failed: Recent payments reached the shop/);
  await failing({selfcheck:{ok:true,checked_at:Math.floor(Date.now()/1000)-30*3600,failed:[]}},/last ran 30 hours ago/);
  await failing({selfcheck:null},/has not run yet/);
});
