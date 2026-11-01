import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixtures.mjs';
import {PRODUCTS_EDGE_TTL} from '../src/worker.mjs';

const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const planOf=(db,sql,...values)=>db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row=>row.detail).join(' | ');

// D1 bills every row a query scans. The every-minute schedule polls these tables, so each poll must be an index lookup.
test('the every-minute polling queries use indexes instead of scanning whole tables',()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_printful_commerce.sql','0002_measurement.sql','0003_printful_probe.sql','0004_mockups.sql','0005_read_indexes.sql']) db.exec(migration(name));
  const polls=[
    ["SELECT * FROM mockup_jobs WHERE status='submitted' ORDER BY updated_at LIMIT 1",'mockup_jobs'],
    ["SELECT * FROM mockup_jobs WHERE status='pending' ORDER BY priority DESC, attempts, product_id LIMIT 1",'mockup_jobs'],
    ["SELECT * FROM printful_probe WHERE status='pending' ORDER BY created_at LIMIT 3",'printful_probe'],
    ["SELECT * FROM catalog_sync_runs WHERE status='running'",'catalog_sync_runs'],
    ['SELECT COUNT(*) AS n,MAX(synced_at) AS changed FROM catalog_products WHERE generation=?','catalog_products','g']
  ];
  for(const [sql,table,...values] of polls) {
    const plan=planOf(db,sql,...values);
    assert.match(plan,/USING (COVERING )?INDEX/,`${table} poll must use an index: ${plan}`);
    assert.doesNotMatch(plan,new RegExp(`SCAN ${table}`),`${table} poll must not scan the table: ${plan}`);
    assert.doesNotMatch(plan,/USE TEMP B-TREE/,`${table} poll must not sort: ${plan}`);
  }
  db.close();
});

test('the migration can be applied twice without error',()=>{
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_printful_commerce.sql','0002_measurement.sql','0003_printful_probe.sql','0004_mockups.sql','0005_read_indexes.sql']) db.exec(migration(name));
  db.exec(migration('0005_read_indexes.sql'));
  db.close();
});

class KVStore { constructor(){this.data=new Map();this.puts=0;} async put(k,v,o={}){this.puts++;this.data.set(k,{value:v,metadata:o.metadata||null});} async get(k){return this.data.get(k)?.value ?? null;} async getWithMetadata(k){const e=this.data.get(k);return e?{value:e.value,metadata:e.metadata}:{value:null,metadata:null};} }

test('the built /api/products body is stored in KV so repeat visits read only two rows from D1 (workers.dev has no edge cache)',async()=>{
  const f=await fixture(); f.env.MOCKUPS=new KVStore();
  let prepares=0; const prepare=f.db.prepare.bind(f.db); f.db.prepare=sql=>{prepares++;return prepare(sql);};
  const first=await f.app.fetch(new Request('https://api.example.com/api/products'),f.env,{});
  assert.equal(first.status,200);
  assert.equal(first.headers.get('Cache-Control'),'no-store');
  const firstBody=await first.json();
  assert.ok(prepares>4,'the first request builds the catalog from D1');
  assert.equal(f.env.MOCKUPS.puts,1,'and stores it');
  prepares=0;
  const second=await f.app.fetch(new Request('https://api.example.com/api/products?cachebust=1',{headers:{Origin:'https://evil.example'}}),f.env,{});
  assert.ok(prepares<=4,`a repeat request makes only the version and readiness lookups, not a catalog rebuild (made ${prepares})`);
  assert.deepEqual(await second.json(),firstBody,'same body, readiness fields included');
  assert.ok('checkout_ready' in firstBody && 'products' in firstBody);
  // A finished sync changes the version, so a new design is served immediately.
  await f.store.run("UPDATE catalog_sync_runs SET updated_at=updated_at+60 WHERE id='initial'");
  await f.store.run("UPDATE catalog_products SET title='Brand new title' WHERE generation='initial'");
  prepares=0;
  const third=await f.app.fetch(new Request('https://api.example.com/api/products'),f.env,{});
  assert.ok(prepares>4,'a new sync version rebuilds the catalog');
  assert.equal((await third.json()).products[0].title,'Brand new title');
});

test('the 5-minute run refreshes the stored catalog at most hourly when new model photos arrive',async()=>{
  const {refreshCatalogSnapshot,catalogSnapshot}=await import('../src/catalog-snapshot.mjs');
  const f=await fixture(); f.env.MOCKUPS=new KVStore();
  f.db.db.exec(readFileSync(new URL('../migrations/0004_mockups.sql',import.meta.url),'utf8'));
  assert.equal(await refreshCatalogSnapshot(f.store,f.env,f.now()),'none','nothing stored yet: visitors build it once');
  const now=f.now();
  await catalogSnapshot(f.store,f.env,now,'https://api.example.com');
  assert.equal(await refreshCatalogSnapshot(f.store,f.env,now+60),'recent');
  assert.equal(await refreshCatalogSnapshot(f.store,f.env,now+3700),'current','no new photos: nothing to rebuild');
  await f.store.run("INSERT INTO mockup_jobs(product_id,layer_json,status,colors_json,updated_at) VALUES('101','{}','done','[\"Black\"]',?)",now+3000);
  assert.equal(await refreshCatalogSnapshot(f.store,f.env,now+3700),'rebuilt');
  const body=JSON.parse(f.env.MOCKUPS.data.get('catalog:snapshot').value);
  assert.match(body.products[0].variants[0].image,/\/api\/mockups\/101\/black\.jpg$/,'the new photo is in the stored list');
});

test('an unsynced catalog is not cached, so the first real sync shows up immediately',async()=>{
  const entries=new Map();
  globalThis.caches={default:{async match(request){return entries.get(request.url)?.clone();},async put(request,response){entries.set(request.url,response);}}};
  try {
    const f=await fixture();
    await f.store.run("DELETE FROM commerce_settings WHERE key='active_catalog'");
    const pending=[];
    const response=await f.app.fetch(new Request('https://api.example.com/api/products'),f.env,{waitUntil:promise=>pending.push(promise)});
    await Promise.all(pending);
    assert.equal(response.status,200);
    assert.equal((await response.json()).catalog_ready,false);
    assert.equal(entries.size,0);
  } finally { delete globalThis.caches; }
});
