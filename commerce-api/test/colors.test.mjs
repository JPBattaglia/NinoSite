import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {refreshPalette,loadPalette,SEED_PALETTE} from '../src/colors.mjs';

test('the products API gives every variant a swatch hex from the palette',async()=>{
  const f=await fixture();
  const product=(await f.request('/api/products')).body.products.find(p=>p.id==='101');
  assert.equal(product.variants[0].color,'Black');
  assert.equal(product.variants[0].color_hex,SEED_PALETTE.Black);
});

test('a new garment color is learned from Printful once, with the rest of that garment\'s colors',async()=>{
  const f=await fixture();
  await f.store.run("UPDATE catalog_variants SET snapshot_json=json_set(snapshot_json,'$.color','Heather Mauve')");
  const calls=[];
  const printful={async call(method,path){calls.push(path);
    if(path==='/products/variant/4011') return {code:200,result:{variant:{id:4011,product_id:438,color:'Heather Mauve',color_code:'#B8949A'},product:{id:438}}};
    if(path==='/products/438') return {code:200,result:{variants:[{color:'Heather Mauve',color_code:'#b8949a'},{color:'Cornsilk',color_code:'#F0EC74'},{color:'Black',color_code:'#000000'}]}};
    return null;}};
  const result=await refreshPalette(f.store,printful);
  assert.deepEqual(result.added.sort(),['Cornsilk','Heather Mauve']);
  const palette=await loadPalette(f.store);
  assert.equal(palette['Heather Mauve'],'#b8949a');assert.equal(palette.Cornsilk,'#f0ec74');
  assert.equal(palette.Black,SEED_PALETTE.Black,'curated colors are not overwritten');
  calls.length=0;assert.deepEqual((await refreshPalette(f.store,printful)).added,[]);assert.equal(calls.length,0,'nothing is fetched once every color is known');
  const product=(await f.request('/api/products')).body.products.find(p=>p.id==='101');
  assert.equal(product.variants[0].color_hex,'#b8949a');
});
