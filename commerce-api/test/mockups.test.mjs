import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures.mjs';
import {processMockups,serveMockup,MEN_STYLE,WOMEN_STYLE} from '../src/mockups.mjs';

class KV { constructor(){this.data=new Map();} async put(k,v){this.data.set(k,v instanceof Uint8Array?v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength):v);} async get(k){return this.data.get(k)||null;} }

async function setup(){
  const f=await fixture();
  f.db.db.exec(readFileSync(new URL('../migrations/0004_mockups.sql',import.meta.url),'utf8'));
  f.env.MOCKUPS=new KV();
  await f.store.run("INSERT INTO mockup_jobs(product_id,layer_json) VALUES('101','{\"width\":5,\"height\":4,\"top\":5,\"left\":3.5}')");
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});
    if(url.endsWith('/v2/mockup-tasks')&&init.method==='POST') return new Response(JSON.stringify({data:[{id:77,status:'pending'}]}));
    if(url.includes('/v2/mockup-tasks?id=77')) return new Response(JSON.stringify({data:[{id:77,status:'completed',catalog_variant_mockups:[{catalog_variant_id:4011,mockups:[{placement:'front',style_id:MEN_STYLE,mockup_url:'https://printful-upload.example/tmp/a.jpg'}]}]}]}));
    if(url==='https://printful-upload.example/tmp/a.jpg') return new Response(new Uint8Array([0xff,0xd8,1,2,3,0xff,0xd9]));
    return new Response('{}',{status:404});
  };
  return {f,calls,fetcher};
}

test('submits a shirt with its exact print placement, alternating men and women by color',async()=>{
  const {f,calls,fetcher}=await setup();
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'submitted');
  const body=calls[0].body;
  assert.equal(body.products[0].mockup_style_ids[0],MEN_STYLE);
  assert.deepEqual(body.products[0].catalog_variant_ids,[4011]);
  assert.deepEqual(body.products[0].placements[0].layers[0].position,{width:5,height:4,top:5,left:3.5});
  assert.match(body.products[0].placements[0].layers[0].url,/^https:\/\/files\.cdn\.printful\.com\/files\/fix\/fixture-artwork-v1_preview\.png$/);
  assert.ok(!body.products.some(p=>p.mockup_style_ids[0]===WOMEN_STYLE));
  assert.equal((await f.store.first("SELECT status FROM mockup_jobs WHERE product_id='101'")).status,'submitted');
});

test('collects finished photos into KV, serves them per color and switches the product API to them',async()=>{
  const {f,fetcher}=await setup();
  await processMockups(f.store,f.env,f.now(),fetcher);
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'collected');
  const response=await serveMockup(f.env,'101','black');
  assert.equal(response.headers.get('Content-Type'),'image/jpeg');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0xff,0xd8,1,2,3,0xff,0xd9]);
  assert.equal(await serveMockup(f.env,'101','white'),null);
  const products=await f.request('/api/products');
  assert.equal(products.body.products[0].variants[0].image,'https://api.example.com/api/mockups/101/black.jpg');
  const image=await f.app.fetch(new Request('https://api.example.com/api/mockups/101/black.jpg'),f.env,{waitUntil(){}});
  assert.equal(image.status,200);
});

test('a failed submission is retried and then parked without blocking other work',async()=>{
  const {f}=await setup();
  const failing=async()=>new Response('nope',{status:500});
  for(let i=0;i<3;i++) assert.equal(await processMockups(f.store,f.env,f.now(),failing),'submit_failed');
  assert.equal((await f.store.first("SELECT status FROM mockup_jobs WHERE product_id='101'")).status,'error');
  assert.equal(await processMockups(f.store,f.env,f.now(),failing),'idle');
});
test('layers wider or taller than the print area are scaled and kept inside it',async()=>{
  const {fitPrintArea}=await import('../src/mockups.mjs');
  assert.deepEqual(fitPrintArea({width:13.28,height:10.989,top:1.753,left:-0.527}),{width:12,height:9.93,top:2.283,left:0});
  assert.deepEqual(fitPrintArea({width:5,height:4,top:5,left:3.5}),{width:5,height:4,top:5,left:3.5});
});

test('a Printful task stuck pending is resubmitted instead of blocking the queue',async()=>{
  const {f}=await setup();
  const {STALL_SECONDS}=await import('../src/mockups.mjs');
  const stuck=async(url,init={})=>url.endsWith('/v2/mockup-tasks')&&init.method==='POST'?new Response(JSON.stringify({data:[{id:88,status:'pending'}]})):new Response(JSON.stringify({data:[{id:88,status:'pending'}]}));
  await f.store.run("INSERT INTO mockup_jobs(product_id,layer_json) VALUES('202','{\"width\":5,\"height\":4,\"top\":5,\"left\":3.5}')");
  const start=f.now();
  assert.equal(await processMockups(f.store,f.env,start,stuck),'submitted');
  assert.equal(await processMockups(f.store,f.env,start+60,stuck),'waiting');
  await processMockups(f.store,f.env,start+STALL_SECONDS+61,stuck);
  const jobs=await f.store.all("SELECT product_id,status,attempts,last_error FROM mockup_jobs ORDER BY product_id");
  // The stuck shirt goes back in the queue behind untried ones, and the next shirt is attempted.
  assert.equal(jobs[0].status,'pending');
  assert.equal(jobs[0].last_error,'printful_task_stalled');
  assert.equal(jobs[0].attempts,1);
  assert.equal(jobs[1].attempts,1);
});

test('one 5-minute run collects a finished job and submits the next pending one',async()=>{
  const {f,fetcher}=await setup();
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'submitted');
  await f.store.run("INSERT INTO mockup_jobs(product_id,layer_json) VALUES('101-next','{\"width\":5,\"height\":4,\"top\":5,\"left\":3.5}')");
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'collected');
  assert.equal((await f.store.first("SELECT status FROM mockup_jobs WHERE product_id='101'")).status,'done');
  // The next job was attempted in the same run (this fixture product has no artwork, so Printful is never called).
  const next=await f.store.first("SELECT attempts,last_error FROM mockup_jobs WHERE product_id='101-next'");
  assert.equal(next.attempts,1);
  assert.equal(next.last_error,'no_variants_or_artwork');
});

test('a photo made on a larger size of the same color (stickers) is still collected',async()=>{
  const {f}=await setup();
  const gen=(await f.store.first("SELECT value FROM commerce_settings WHERE key='active_catalog'")).value;
  const row=await f.store.first('SELECT * FROM catalog_variants WHERE generation=? AND product_id=?',gen,'101');
  const snap=JSON.parse(row.snapshot_json); snap.catalog_variant_id=4013; snap.size='XL';
  await f.store.run('INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES(?,?,?,?,?,?)',gen,'999','101',row.price_cents,row.currency,JSON.stringify(snap));
  const fetcher=async(url,init={})=>{
    if(url.endsWith('/v2/mockup-tasks')&&init.method==='POST') return new Response(JSON.stringify({data:[{id:78,status:'pending'}]}));
    if(url.includes('/v2/mockup-tasks?id=78')) return new Response(JSON.stringify({data:[{id:78,status:'completed',catalog_variant_mockups:[{catalog_variant_id:4013,mockups:[{placement:'default',mockup_url:'https://printful-upload.example/tmp/b.jpg'}]}]}]}));
    if(url==='https://printful-upload.example/tmp/b.jpg') return new Response(new Uint8Array([0xff,0xd8,9,0xff,0xd9]));
    return new Response('{}',{status:404});
  };
  await f.store.run(`UPDATE mockup_jobs SET layer_json='{"catalog":358,"placement":"default","technique":"digital","catalog_variant_ids":[4013],"position_in":{"width":5,"height":4,"top":0.5,"left":0.2}}' WHERE product_id='101'`);
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'submitted');
  assert.equal(await processMockups(f.store,f.env,f.now(),fetcher),'collected');
  assert.ok(await serveMockup(f.env,'101','black'));
});

test('a rebuilt product waits for the catalog to show its new colors before photos are made', async () => {
  const {f, calls, fetcher} = await setup();
  await f.store.run(`UPDATE mockup_jobs SET layer_json='{"catalog":146,"placement":"front","technique":"dtg","catalog_variant_ids":null,"colors":["Black","Forest Green"],"position_in":{"width":10,"height":8,"top":1,"left":2}}' WHERE product_id='101'`);
  const now = f.now();
  assert.equal(await processMockups(f.store, f.env, now, fetcher), 'submitted');
  assert.equal(calls.length, 0, 'nothing sent to Printful');
  const held = await f.store.first("SELECT status,last_error FROM mockup_jobs WHERE product_id='101'");
  assert.deepEqual({...held}, {status: 'hold', last_error: 'waiting_for_catalog_colors'});
  assert.equal(await processMockups(f.store, f.env, now + 600, fetcher), 'idle', 'not retried within the hour');
  await f.store.run(`UPDATE mockup_jobs SET layer_json=json_set(layer_json,'$.colors',json('["Black"]')) WHERE product_id='101'`);
  assert.equal(await processMockups(f.store, f.env, now + 3700, fetcher), 'submitted');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'colors match: photo requested');
});
