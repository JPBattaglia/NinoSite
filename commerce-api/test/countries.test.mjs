import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {createApp} from '../src/worker.mjs';
import {PrintfulClient} from '../src/providers.mjs';
import {resolveShippingCountries,PRINTFUL_COUNTRY_CACHE_KEY,PRINTFUL_COUNTRY_CACHE_TTL} from '../src/countries.mjs';

const accepted=[{code:'US',name:'United States',states:[{code:'CA',name:'California'}]},{code:'CA',name:'Canada',states:[{code:'ON',name:'Ontario'}]},{code:'DE',name:'Germany',states:[]}];
function closedPublicRead(result) {
  assert.equal(result.status,200);assert.equal(result.body.checkout_ready,false);assert.deepEqual(result.body.shipping_countries,[]);
}
const address={name:'Fixture Customer',address1:'123 Fixture Street',city:'Fixture City',state_code:'ON',country_code:'CA',zip:'A1A 1A1'};
function installCountries(f,value=accepted) {
  let calls=0;
  f.printful.getCountries=async()=>{calls++;return structuredClone(value);};
  return ()=>calls;
}
async function cache(f,value) {
  await f.store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',PRINTFUL_COUNTRY_CACHE_KEY,typeof value==='string'?value:JSON.stringify(value));
}

test('PRINTFUL destinations use the real read-only countries endpoint and a bounded fresh cache without constructing Stripe',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL',CHECKOUT_ENABLED:'false',FULFILLMENT_ENABLED:'false',STRIPE_SECRET_KEY:'',STRIPE_TAX_MODE:''});
  let requests=0,stripeConstructed=0;
  const printful=new PrintfulClient(f.env,async(url,options)=>{
    requests++;assert.equal(url,'https://api.printful.com/countries');assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    return Response.json({code:200,result:accepted});
  });
  const app=createApp({printful,stripeFactory:async()=>{stripeConstructed++;throw new Error('Must not construct Stripe');},now:f.now});
  for(const path of ['/api/products','/api/commerce-config']) {
    const response=await app.fetch(new Request('https://api.example.com'+path),f.env);
    assert.equal(response.status,200);const data=await response.json();
    assert.deepEqual(data.shipping_countries,['CA','DE','US']);assert.equal(data.checkout_ready,false);
  }
  assert.equal(requests,1);assert.equal(stripeConstructed,0);
  const stored=JSON.parse((await f.store.first('SELECT value FROM commerce_settings WHERE key=?',PRINTFUL_COUNTRY_CACHE_KEY)).value);
  assert.deepEqual(stored.countries,['CA','DE','US']);assert.equal(stored.fetched_at,f.now());assert.equal(stored.version,1);
  assert.equal(f.env.SHIPPING_COUNTRIES,'PRINTFUL');assert.equal(f.env.STRIPE_TAX_MODE,'');assert.equal(f.env.CHECKOUT_ENABLED,'false');assert.equal(f.env.FULFILLMENT_ENABLED,'false');
});

test('explicit destination lists retain their behavior and never request provider countries',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'CA,US'});
  f.printful.getCountries=async()=>{throw new Error('Not needed for an explicit list');};
  assert.deepEqual((await f.request('/api/products')).body.shipping_countries,['CA','US']);
  assert.equal((await f.checkout()).status,200);
  assert.deepEqual(f.stripe.sessions.get('cs_fixture_1').params.shipping_address_collection.allowed_countries,['CA','US']);
});

test('dynamic calculated quotes reject countries absent from Printful and accepted quotes keep the actual countries through payment and fulfillment',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL',SHIPPING_MODE:'calculated'});const calls=installCountries(f);
  const denied=await f.request('/api/shipping-quotes',{items:f.items,recipient:{...address,country_code:'ZZ'}});
  assert.equal(denied.status,400);assert.equal(denied.body.error,'shipping_country_unavailable');assert.equal(f.printful.rateCalls,0);assert.equal(f.stripe.calls,0);
  const quote=await f.request('/api/shipping-quotes',{items:f.items,recipient:address});assert.equal(quote.status,200);
  const checkout=await f.checkout({shipping_quote_id:quote.body.quote_id,shipping_rate_id:quote.body.rates[0].id});assert.equal(checkout.status,200);
  const order=await f.store.order(checkout.body.order_id);assert.deepEqual(JSON.parse(order.snapshot_json).shipping.countries,['CA','DE','US']);
  f.stripe.pay('cs_fixture_1');assert.equal((await f.webhook()).status,200);
  assert.equal((await f.store.order(order.id)).fulfillment_status,'confirmed');assert.equal(f.printful.createCalls,1);assert.equal(calls(),1);
});

test('missing Printful token keeps catalog reads available and checkout closed even when a fresh country cache exists',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL'});const calls=installCountries(f);
  await resolveShippingCountries(f.env,f.store,f.printful,f.now());f.env.PRINTFUL_ACCESS_TOKEN='';
  for(const path of ['/api/products','/api/commerce-config']) closedPublicRead(await f.request(path));
  assert.equal((await f.checkout()).status,503);assert.equal(calls(),1);assert.equal(f.stripe.calls,0);
});

test('expired countries are refreshed from the provider and never served stale after provider failure',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL'});const calls=installCountries(f);
  assert.equal((await f.request('/api/products')).status,200);assert.equal(calls(),1);
  f.advance(PRINTFUL_COUNTRY_CACHE_TTL);
  f.printful.getCountries=async()=>{throw new Error('Provider unavailable');};
  const failed=await f.request('/api/products');closedPublicRead(failed);assert.equal(failed.body.products.length,1);assert.equal(f.stripe.calls,0);
  f.printful.getCountries=async()=>[{code:'CA',name:'Canada',states:[]}];
  const refreshed=await f.request('/api/products');assert.equal(refreshed.status,200);assert.deepEqual(refreshed.body.shipping_countries,['CA']);
});

test('malformed, overlarge, future-dated and expired cache data cannot bypass provider validation or fall back on failure',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL'});
  const invalid=['{malformed',JSON.stringify({version:1,fetched_at:f.now()+1,countries:['US']}),JSON.stringify({version:1,fetched_at:f.now(),countries:['US','US']}),JSON.stringify({version:1,fetched_at:f.now(),countries:['USA']}),JSON.stringify({version:1,fetched_at:f.now()-PRINTFUL_COUNTRY_CACHE_TTL,countries:['US']}),' '.repeat(10001)];
  f.printful.getCountries=async()=>{throw new Error('Provider unavailable');};
  for(const value of invalid) {await cache(f,value);const response=await f.request('/api/commerce-config');closedPublicRead(response);}
  await cache(f,{version:1,fetched_at:f.now()+1,countries:['US']});installCountries(f,[{code:'DE',name:'Germany'}]);
  assert.deepEqual((await f.request('/api/products')).body.shipping_countries,['DE']);
});

test('empty, duplicate, oversized or malformed provider lists never create a destination cache or payable checkout',async()=>{
  for(const value of [[],{},[{code:'US'}],[{code:'USA',name:'Invalid'}],[{code:'US',name:'One'},{code:'US',name:'Duplicate'}],Array.from({length:301},()=>({code:'US',name:'Oversized'}))]) {
    const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL'});installCountries(f,value);
    const result=await f.request('/api/products');closedPublicRead(result);
    assert.equal(await f.store.first('SELECT value FROM commerce_settings WHERE key=?',PRINTFUL_COUNTRY_CACHE_KEY),null);
    assert.equal((await f.checkout()).status,503);assert.equal(f.stripe.calls,0);assert.equal(f.printful.createCalls,0);
  }
});

test('a newly removed destination holds an existing paid order for review before supplier mutations',async()=>{
  const f=await fixture();const checkout=await f.checkout();f.stripe.pay('cs_fixture_1');
  f.env.SHIPPING_COUNTRIES='PRINTFUL';installCountries(f,[{code:'CA',name:'Canada'}]);
  assert.equal((await f.webhook()).status,200);
  const order=await f.store.order(checkout.body.order_id);assert.equal(order.payment_status,'paid');assert.equal(order.fulfillment_status,'review');assert.equal(order.last_error,'shipping_country_requires_review');
  assert.equal(f.printful.createCalls,0);assert.equal(f.printful.confirmCalls,0);
});

test('country-provider failure preserves paid webhook state and scheduled fulfillment resolves fresh destinations before recovering',async()=>{
  const f=await fixture();const checkout=await f.checkout();f.stripe.pay('cs_fixture_1');f.env.SHIPPING_COUNTRIES='PRINTFUL';
  f.printful.getCountries=async()=>{throw new Error('Provider unavailable');};
  assert.equal((await f.webhook()).status,200);
  let order=await f.store.order(checkout.body.order_id);assert.equal(order.payment_status,'paid');assert.equal(order.fulfillment_status,'retry');assert.equal(order.last_error,'shipping_countries_unavailable');assert.equal(f.printful.createCalls,0);
  f.advance(61);installCountries(f);
  await f.app.scheduled({cron:'*/5 * * * *'},f.env);
  order=await f.store.order(order.id);assert.equal(order.fulfillment_status,'confirmed');assert.equal(f.printful.createCalls,1);assert.equal(f.printful.confirmCalls,1);
});


test('PRINTFUL public reads without a token retain catalog and calculated readiness JSON without any provider calls',async()=>{
  const f=await fixture({SHIPPING_COUNTRIES:'PRINTFUL',SHIPPING_MODE:'calculated',PRINTFUL_ACCESS_TOKEN:''});
  const calls=installCountries(f);let stripeConstructed=0;
  const app=createApp({printful:f.printful,stripeFactory:async()=>{stripeConstructed++;throw new Error('Must not construct Stripe');},now:f.now});
  for(const path of ['/api/products','/api/commerce-config']) {
    const response=await app.fetch(new Request('https://api.example.com'+path),f.env);
    const result={status:response.status,body:await response.json()};closedPublicRead(result);assert.equal(result.body.shipping_mode,'calculated');
    if(path==='/api/products') assert.equal(result.body.products.length,1);else assert.equal(result.body.catalog_ready,true);
  }
  assert.equal(calls(),0);assert.equal(stripeConstructed,0);assert.equal(f.stripe.calls,0);
  assert.equal((await f.request('/api/shipping-quotes',{items:f.items,recipient:address})).status,503);assert.equal((await f.checkout()).status,503);assert.equal(calls(),0);
});
