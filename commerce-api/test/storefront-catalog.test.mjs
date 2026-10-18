import test from 'node:test';
import assert from 'node:assert/strict';
import {storefrontProducts} from '../../catalog-sync.mjs';
import {fixture} from './fixtures.mjs';
import {normalizeVariant} from '../src/catalog.mjs';
import {rawVariant} from './fixtures.mjs';

const base = [{id:'101',title:'Original',image:'assets/curated.webp',gallery:['assets/curated.webp'],featured:true,price:{amount:1,currency:'USD'}}];
const record = (id, variants=[]) => ({id,title:`Design ${id}`,image:`https://example.com/${id}.jpg`,variants:new Map(variants.map(v=>[v.id,v]))});

test('a completed sync adds future products, removes deleted designs and retains curated photos',()=>{
  const live = new Map([['101',record('101',[{id:'501',purchasable:true,price:{amount:3200,currency:'USD'}}])],['102',record('102')]]);
  const products=storefrontProducts([...base,{id:'deleted',title:'Removed design'}],live,true);
  assert.deepEqual(products.map(p=>p.id),['101','102']);
  assert.equal(products[0].image,'assets/curated.webp');
  assert.equal(products[0].price.amount,3200);
  assert.equal(products[1].image,'https://example.com/102.jpg');
  assert.equal('price' in products[1],false);
});

test('missing initial sync keeps all curated designs; a completed empty store does not resurrect deleted products',()=>{
  assert.equal(storefrontProducts(base,new Map(),false),base);
  assert.deepEqual(storefrontProducts(base,new Map(),true),[]);
});

test('an unavailable variant never supplies a storefront price',()=>{
  const products=storefrontProducts(base,new Map([['101',record('101',[{id:'501',purchasable:false,price:{amount:3200,currency:'USD'}}])]]),true);
  assert.equal('price' in products[0],false);
});

test('future product images do not depend on Etsy, including its image CDN',async()=>{
  const external=record('102'); external.image='https://i.etsystatic.com/product.jpg';
  const products=storefrontProducts(base,new Map([['102',external]]),true);
  assert.equal(products[0].image,'assets/brand-mark.webp');
  assert.equal(products[0].imageUnavailable,true);
  const variant=await normalizeVariant({...rawVariant(),files:[...rawVariant().files,{type:'preview',preview_url:'https://files.cdn.printful.com/mockup.jpg'}]},{id:101,thumbnail_url:'https://i.etsystatic.com/thumbnail.jpg'});
  assert.equal(variant.image,'https://files.cdn.printful.com/mockup.jpg');
});

test('completed public catalog includes designs without sellable variants but keeps checkout closed',async()=>{
  const f=await fixture();
  await f.store.run('DELETE FROM catalog_variants');
  const result=await f.request('/api/products');
  assert.equal(result.body.catalog_complete,true);
  assert.equal(result.body.products.length,1);
  assert.deepEqual(result.body.products[0].variants,[]);
  assert.equal(result.body.checkout_ready,false);
});
