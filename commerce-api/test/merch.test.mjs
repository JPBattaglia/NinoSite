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

// ---------- Logo merch (logo first, Oct 28 9:02 pm) ----------
import {buildLogoProducts,logoPosition,LOGO_PRODUCTS,productByKey} from '../src/merch-products.mjs';

function printfulApi(){
  const calls=[];
  const fetcher=async(url)=>{
    const u=new URL(url); calls.push(u.pathname);
    let m;
    if((m=u.pathname.match(/^\/products\/(\d+)$/))) return Response.json({code:200,result:{product:{id:Number(m[1])},variants:[
      {id:Number(m[1])*10+1,color:'Black',color_code:'#000000',size:'M',price:'12.50',image:`https://img.example/${m[1]}.jpg`,availability_status:[{region:'US',status:'in_stock'}]},
      {id:Number(m[1])*10+2,color:'Red',size:'M',price:'12.50',availability_status:[{region:'EU',status:'in_stock'}]}]}});
    if((m=u.pathname.match(/^\/v2\/catalog-products\/(\d+)\/mockup-templates$/))) return Response.json({data:[{catalog_variant_ids:[Number(m[1])*10+1],placement:'front',image_url:'https://img.example/t.png',background_url:'https://img.example/bg.png',template_width:1000,template_height:1000,print_area_width:400,print_area_height:500,print_area_top:200,print_area_left:300,template_positioning:'overlay'}]});
    if((m=u.pathname.match(/^\/mockup-generator\/printfiles\/(\d+)$/))) return Response.json({code:200,result:{printfiles:[{printfile_id:1,width:1800,height:2400,dpi:150}],variant_printfiles:[{variant_id:Number(m[1])*10+1,placements:{default:1,front:1,embroidery_chest_left:1}}]}});
    return new Response('nope',{status:404});
  };
  return {fetcher,calls};
}

test('logo products: only US stock, Printful templates and print files, for every product in the lineup',async()=>{
  const {fetcher}=printfulApi();
  const built=await buildLogoProducts({PRINTFUL_ACCESS_TOKEN:'x',PRINTFUL_STORE_ID:'1'},fetcher);
  assert.equal(built.products.length,LOGO_PRODUCTS.length);
  const tee=built.products.find(p=>p.key==='tee');
  assert.equal(tee.variants.length,1,'EU-only colour left out');
  assert.equal(tee.variants[0].base_cents,1250);
  assert.deepEqual(tee.templates[0].box,{width:400,height:500,top:200,left:300});
  assert.equal(tee.printfile.width,1800);
  assert.equal(tee.nino,true);
  for(const key of ['apron','cap','beanie','mug','coaster','tote','hoodie','polo','stickers']) assert.ok(built.products.some(p=>p.key===key),key);
});

test('the logo is placed in the print file the same way the mockup shows it',()=>{
  const tee=productByKey('tee');
  const pos=logoPosition(tee,{width:1800,height:2400},{width:1000,height:500});
  assert.equal(pos.width,900); assert.equal(pos.height,450); assert.equal(pos.left,450); assert.equal(pos.top,192);
  const cap=logoPosition(productByKey('cap'),{width:1200,height:600},{width:500,height:500});
  assert.equal(cap.height,600); assert.equal(cap.width,600); assert.equal(cap.left,300);
});

test('a logo cart is quoted with Printful\'s estimate and ordered with the logo file on every item',async()=>{
  const f=await fixture();
  const {fetcher}=printfulApi();
  const built=await buildLogoProducts({PRINTFUL_ACCESS_TOKEN:'x',PRINTFUL_STORE_ID:'1'},fetcher);
  await f.store.run("INSERT INTO commerce_settings(key,value) VALUES('merch_logo_products_v1',?)",JSON.stringify({...built,built_at:f.now()}));
  let estimated; f.printful.call=async(method,path,body)=>{estimated={path,body};return {code:200,result:{costs:{subtotal:'40.00',digitization:'6.50',additional_fee:'0.00'}}};};
  const logo={url:'https://menu-made.com/api/merch-upload/x?t=y',width:1000,height:500};
  const quote=await merchQuote({items:[{product_id:'101',variant_id:'501',quantity:2}],logo_items:[{key:'cap',variant_id:2061,quantity:3},{key:'mug',variant_id:191,quantity:4}],logo,recipient:address},deps(f));
  assert.equal(estimated.path,'/orders/estimate-costs');
  assert.equal(estimated.body.items.length,3);
  assert.deepEqual(estimated.body.items[0].files.at(-1).type,'back','Nino shirt carries the logo on the back');
  assert.equal(quote.costs.digitization_cents,650);
  assert.equal(quote.logo_lines[0].base_cents,1250);
  let payload; f.printful.createDraft=async p=>{payload=p;const d={id:3,external_id:p.external_id,status:'draft',costs:{total:'60.00'}};f.printful.orders.set(p.external_id,d);return d;};
  const placed=await placeMerchOrder({external_id:'mmlogocart123',lines:quote.lines.map(l=>({...l,retail_cents:3700})),logo_lines:quote.logo_lines.map(l=>({...l,retail_cents:2499})),logo,recipient:address,email:'a@b.co',shipping_method:'STANDARD',max_cost_cents:20000,confirm:false},deps(f));
  assert.equal(placed.status,'draft');
  const cap=payload.items.find(i=>i.external_id==='logo_1');
  assert.equal(cap.variant_id,2061); assert.equal(cap.files[0].url,logo.url); assert.equal(cap.retail_price,'24.99');
  assert.deepEqual(cap.options.find(o=>o.id==='thread_colors')?.value.length,1,'embroidery names its thread (contrast with the cap when the page sent none)');
  assert.equal(cap.options.find(o=>o.id==='embroidery_type')?.value,'flat');
  assert.equal(payload.items.find(i=>i.external_id==='logo_2').options,undefined,'printed items carry no thread options');
  const threaded=await merchQuote({logo_items:[{key:'cap',variant_id:2061,quantity:1}],logo:{...logo,thread_colors:['#cc3333','#123456','#FFFFFF']},recipient:address},deps(f));
  assert.ok(threaded);
  assert.deepEqual(estimated.body.items[0].options[0].value,['#CC3333','#FFFFFF'],'only Printful threads, upper-cased');
  await assert.rejects(merchQuote({logo_items:[{key:'cap',variant_id:2061,quantity:1}],recipient:address},deps(f)),{code:'logo_required'});
});
