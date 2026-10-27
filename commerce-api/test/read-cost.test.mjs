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

test('a built /api/products response is shared through the edge cache so repeat visits read nothing from D1',async()=>{
  const entries=new Map();
  globalThis.caches={default:{async match(request){const hit=entries.get(request.url);return hit?hit.clone():undefined;},async put(request,response){entries.set(request.url,response);}}};
  try {
    const f=await fixture();
    let prepares=0; const prepare=f.db.prepare.bind(f.db); f.db.prepare=sql=>{prepares++;return prepare(sql);};
    const pending=[]; const ctx={waitUntil:promise=>pending.push(promise)};
    const first=await f.app.fetch(new Request('https://api.example.com/api/products'),f.env,ctx);
    await Promise.all(pending);
    assert.equal(first.status,200);
    assert.equal(first.headers.get('Cache-Control'),'no-store');
    const firstBody=await first.json();
    assert.ok(prepares>0,'the first request builds the catalog from D1');
    const stored=entries.get('https://api.example.com/api/products');
    assert.equal(stored.headers.get('Cache-Control'),`public, max-age=${PRODUCTS_EDGE_TTL}`);
    prepares=0;
    const second=await f.app.fetch(new Request('https://api.example.com/api/products?cachebust=1',{headers:{Origin:'https://evil.example'}}),f.env,ctx);
    assert.equal(prepares,0,'a repeat request is served from the edge cache with zero D1 queries');
    assert.equal(second.status,200);
    assert.equal(second.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await second.json(),firstBody);
  } finally { delete globalThis.caches; }
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
