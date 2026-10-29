import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {merchCall,merchQuote,placeMerchOrder,merchOrderStatus,deleteMerchDraft,normalizeMerchItems,LOGO_POSITION} from '../src/merch.mjs';

const address={name:'Proof Cafe',address1:'1 Main St',city:'Oakland',state_code:'CA',country_code:'US',zip:'94612'};
const deps=f=>({store:f.store,printful:f.printful,env:f.env,now:f.now()});

test('staff merch quotes today\'s Nino price and Printful delivery for large quantities',async()=>{
  const f=await fixture();
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:24}],recipient:address},deps(f));
  assert.equal(quote.lines[0].unit_price_cents,3200);
  assert.equal(quote.lines[0].quantity,24);
  assert.equal(quote.lines[0].color,'Black');
  assert.equal(quote.rates[0].amount_cents,725);
  assert.ok(quote.lines[0].fingerprint);
});

test('merch carts are limited and validated',()=>{
  assert.throws(()=>normalizeMerchItems([]),/Choose between/);
  assert.throws(()=>normalizeMerchItems([{product_id:'1',variant_id:'2',quantity:101}]),{code:'invalid_merch_item'});
  assert.throws(()=>normalizeMerchItems([{product_id:'1',variant_id:'2',quantity:100},{product_id:'1',variant_id:'3',quantity:100},{product_id:'1',variant_id:'4',quantity:1}]),{code:'quantity_limit'});
});

test('a merch order without a logo is a sync-variant Printful order, idempotent, confirmed only when asked',async()=>{
  const f=await fixture();
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:3}],recipient:address},deps(f));
  const args={external_id:'mmabc12345def',lines:quote.lines.map(l=>({...l,retail_cents:3200})),recipient:address,email:'owner@proof.example',shipping_method:'STANDARD',max_cost_cents:5000,confirm:false};
  const draft=await placeMerchOrder(args,deps(f));
  assert.equal(draft.status,'draft');
  assert.equal(f.printful.confirmCalls,0);
  const again=await placeMerchOrder({...args,confirm:true},deps(f));
  assert.equal(f.printful.createCalls,1,'the same external id never creates a second order');
  assert.equal(again.status,'pending');
  const status=await merchOrderStatus({external_id:'mmabc12345def'},deps(f));
  assert.equal(status.found,true);
  assert.deepEqual(await deleteMerchDraft({external_id:'mmabc12345def'},deps(f)),{deleted:false,reason:'status_pending'},'a confirmed order is never deleted');
});

test('a merch order with a logo uses the catalog variant, Nino\'s artwork and the logo on the back',async()=>{
  const f=await fixture();
  let payload;
  f.printful.createDraft=async p=>{payload=p;const d={id:2002,external_id:p.external_id,status:'draft',costs:{total:'40.00',currency:'USD'}};f.printful.orders.set(p.external_id,d);return d;};
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:2}],recipient:address},deps(f));
  const result=await placeMerchOrder({external_id:'mmlogo1234567',lines:quote.lines.map(l=>({...l,retail_cents:3700})),recipient:address,email:'owner@proof.example',shipping_method:'STANDARD',logo_url:'https://menu-made.com/api/merch-logo/x?t=y',max_cost_cents:10000,confirm:false},deps(f));
  assert.equal(result.cost_cents,4000);
  const item=payload.items[0];
  assert.equal(item.variant_id,4011);
  assert.equal(item.sync_variant_id,undefined);
  assert.deepEqual(item.files[0],{type:'front',id:900});
  assert.deepEqual(item.files[1],{type:'back',url:'https://menu-made.com/api/merch-logo/x?t=y',position:LOGO_POSITION});
  assert.equal(payload.recipient.email,'owner@proof.example');
  assert.equal((await deleteMerchDraft({external_id:'mmlogo1234567'},deps(f))).deleted,true);
});

test('Printful costing more than the order allows is held for review, not confirmed',async()=>{
  const f=await fixture();
  f.printful.cost='99.00';
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:1}],recipient:address},deps(f));
  const result=await merchCall(placeMerchOrder,{external_id:'mmcost1234567',lines:quote.lines.map(l=>({...l,retail_cents:3200})),recipient:address,email:'a@b.co',shipping_method:'STANDARD',max_cost_cents:3000,confirm:true},deps(f));
  assert.equal(result.ok,false);
  assert.equal(result.error,'printful_cost_requires_review');
  assert.equal(f.printful.confirmCalls,0);
});

test('a changed shirt is refused at order time',async()=>{
  const f=await fixture();
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:1}],recipient:address},deps(f));
  const result=await merchCall(placeMerchOrder,{external_id:'mmchg12345678',lines:quote.lines.map(l=>({...l,fingerprint:'other',retail_cents:3200})),recipient:address,email:'a@b.co',shipping_method:'STANDARD',max_cost_cents:9000,confirm:false},deps(f));
  assert.equal(result.error,'catalog_changed');
});

test('the merch sample picks two sizes of one shirt in one colour',async()=>{
  const f=await fixture();
  const v=JSON.parse((await f.store.first("SELECT snapshot_json FROM catalog_variants WHERE id='501'")).snapshot_json);
  await f.store.run("INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES('initial','502','101',3200,'usd',?)",JSON.stringify({...v,id:'502',size:'L'}));
  const {merchSample}=await import('../src/merch.mjs');
  const r=await merchSample({},deps(f));
  assert.deepEqual(r.variants.map(x=>x.size),['M','L']);
});
