import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Store} from '../src/db.mjs';
import {normalizeVariant} from '../src/catalog.mjs';
import {HttpError} from '../src/common.mjs';
import {createApp} from '../src/worker.mjs';

export class D1Fixture {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(readFileSync(new URL('../migrations/0001_printful_commerce.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('../migrations/0002_measurement.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('../migrations/0006_subscribers.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('../migrations/0007_newsletter.sql',import.meta.url),'utf8'));}
  prepare(sql){
    const database=this.db;
    return {bind(...values){return {
      async first(){return database.prepare(sql).get(...values) || null;},
      async all(){return {results:database.prepare(sql).all(...values)};},
      async run(){const result=database.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}
    };}};
  }
  async batch(statements){this.db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());this.db.exec('COMMIT');return results;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
export function rawVariant(id=501,product=101){return {id,sync_product_id:product,external_id:`external-${id}`,synced:true,is_ignored:false,availability_status:'active',variant_id:4011,retail_price:'32.00',currency:'USD',name:'Fixture shirt / Black / M',size:'M',color:'Black',files:[{id:900,type:'default',hash:'fixture-artwork-v1',url:'https://example.com/fixture-print.png',status:'ok'}],options:[]};}
export class PrintfulFixture {
  constructor(){this.variants=new Map([['501',rawVariant()]]);this.products=new Map([['101',{sync_product:{id:101,external_id:'listing-137',name:'Fixture graphic shirt',thumbnail_url:'https://example.com/mockup.png'},sync_variants:[rawVariant()]}]]);this.orders=new Map();this.createCalls=0;this.confirmCalls=0;this.rateCalls=0;this.cost='12.00';this.createTimeout=false;this.confirmTimeout=false;}
  async getVariant(id){return structuredClone(this.variants.get(String(id)) || null);}
  async getFile(id){return {id,width:1880,height:1555,dpi:360};}
  async listProducts(offset,limit){const list=[...this.products.values()].map(p=>p.sync_product);return {result:list.slice(offset,offset+limit),paging:{total:list.length}};}
  async getProduct(id){return structuredClone(this.products.get(String(id)) || null);}
  async shippingRates(){this.rateCalls++;return [{id:'STANDARD',name:'Standard fixture delivery',rate:'7.25',currency:'USD'}];}
  async deleteOrder(id){this.deleted=(this.deleted||[]);this.deleted.push(String(id));for(const [key,order] of this.orders) if(String(order.id)===String(id)) this.orders.delete(key);return {id};}
  async findOrder(id){return structuredClone(this.orders.get(id) || null);}
  async createDraft(payload){
    this.createCalls++;
    const draft={id:1001,external_id:payload.external_id,store:77,status:'draft',recipient:structuredClone(payload.recipient),costs:{total:this.cost,currency:'USD'},items:payload.items.map(item=>({...item,variant_id:item.variant_id || 4011,files:item.files ? item.files.map(file=>({...structuredClone([...this.variants.values()].flatMap(v=>v.files).find(f=>f.id===file.id) || {}),...file,status:'ok'})) : structuredClone(this.variants.get(String(item.sync_variant_id)).files)}))};this.lastItems=structuredClone(payload.items);
    this.orders.set(payload.external_id,draft);
    if(this.createTimeout){this.createTimeout=false;throw new HttpError(502,'printful_request_failed');}
    return structuredClone(draft);
  }
  async confirmOrder(id){
    this.confirmCalls++;
    const draft=[...this.orders.values()].find(order=>order.id===id);draft.status='pending';
    if(this.confirmTimeout){this.confirmTimeout=false;throw new HttpError(502,'printful_request_failed');}
    return structuredClone(draft);
  }
}
export class StripeFixture {
  constructor(){this.sessions=new Map();this.keys=new Map();this.calls=0;this.live=true;this.timeout=false;this.retrieveFailure=false;}
  async createSession(params,key){
    this.calls++;
    // Mirrors Stripe's live refusal seen on Oct 28, 2026 (req_6kVk1t61CdZfjH).
    if(params.automatic_tax?.enabled && params.payment_intent_data?.shipping) throw Object.assign(new Error('You cannot enable automatic tax calculation with `payment_intent_data[shipping]` set.'),{type:'StripeInvalidRequestError',code:'parameter_invalid'});
    if(this.refuse) throw Object.assign(new Error(this.refuse),{type:'StripeInvalidRequestError'});
    if(!this.keys.has(key)){
      const id=`cs_fixture_${this.keys.size+1}`;
      this.keys.set(key,id);this.sessions.set(id,{params:structuredClone(params),id,url:`https://checkout.stripe.com/c/pay/${id}`,expires_at:params.expires_at,livemode:this.live,payment_status:'unpaid',status:'open'});
    }
    const session=this.sessions.get(this.keys.get(key));
    if(this.timeout){this.timeout=false;throw new HttpError(503,'stripe_unavailable');}
    return structuredClone(session);
  }
  pay(id){
    const session=this.sessions.get(id);const p=session.params;
    const subtotal=p.line_items.reduce((sum,line)=>sum+line.quantity*line.price_data.unit_amount,0);
    const shipping=p.shipping_options[0].shipping_rate_data.fixed_amount.amount;
    Object.assign(session,{automatic_tax:p.automatic_tax?{status:'complete'}:undefined,payment_status:'paid',status:'complete',currency:'usd',client_reference_id:p.client_reference_id,metadata:p.metadata,amount_subtotal:subtotal,amount_total:subtotal+shipping,total_details:{amount_shipping:shipping,amount_tax:0,amount_discount:0},customer_details:{email:'buyer@example.com'},collected_information:{shipping_details:{name:'Test Customer',address:{line1:'123 Test Street',line2:null,city:'Test City',state:'CA',country:'US',postal_code:'90001'}}},payment_intent:{id:`pi_${id}`,status:'succeeded',currency:'usd',amount_received:subtotal+shipping,metadata:p.payment_intent_data.metadata,shipping:p.payment_intent_data.shipping,latest_charge:{id:'ch_fixture',paid:true,refunded:false,amount_refunded:0}}});
  }
  async retrieveSession(id){if(this.retrieveFailure){this.retrieveFailure=false;throw new HttpError(503,'stripe_unavailable');}return structuredClone(this.sessions.get(id));}
  async listLineItems(id){return {has_more:false,data:this.sessions.get(id).params.line_items.map(line=>({quantity:line.quantity,amount_subtotal:line.quantity*line.price_data.unit_amount,price:{unit_amount:line.price_data.unit_amount,currency:'usd',product:{metadata:line.price_data.product_data.metadata}}}))};}
  async verifyWebhook(raw,signature){if(signature!=='fixture-signature')throw new Error('Invalid signature');return JSON.parse(raw);}
  async createCustomer(){return {id:'cus_fixture'};}
  async retrieveAccount(){return {id:this.accountId || 'acct_fixtureNino'};}
  async listWebhookEndpoints(){return {data:this.endpoints || [{id:'we_fixture',url:'https://api.example.com/api/webhooks/stripe',status:'enabled',enabled_events:['checkout.session.completed']}]};}
  async listEvents(){return {data:this.events || []};}
}
export async function fixture(overrides={}){
  let time=Math.floor(Date.now()/1000);
  const db=new D1Fixture();const store=new Store(db);const stripe=new StripeFixture();const printful=new PrintfulFixture();
  const env={DB:db,STOREFRONT_ORIGIN:'https://shop.example.com',STRIPE_MODE:'live',CHECKOUT_ENABLED:'true',FULFILLMENT_ENABLED:'true',STRIPE_SECRET_KEY:`rk_${overrides.STRIPE_MODE || 'live'}_fixture_not_a_key`,STRIPE_WEBHOOK_SECRET:'whsec_fixture_not_a_key',PRINTFUL_ACCESS_TOKEN:'fixture_not_a_token',PRINTFUL_STORE_ID:'77',ADMIN_API_TOKEN:'fixture_admin_not_a_token',SHIPPING_MODE:'flat',SHIPPING_COUNTRIES:'US',SHIPPING_RATE_CENTS:'500',STRIPE_TAX_MODE:'none',...overrides};
  stripe.live=env.STRIPE_MODE==='live';
  await store.run("INSERT INTO catalog_sync_runs(id,product_ids_json,status,created_at,updated_at) VALUES('initial','[101]','complete',?,?)",time,time);
  await store.run("INSERT INTO commerce_settings(key,value) VALUES('active_catalog','initial')");
  await store.run("INSERT INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES('initial','101','listing-137','Fixture graphic shirt','https://example.com/mockup.png',?)",time);
  const variant=await normalizeVariant(rawVariant(),{id:101,thumbnail_url:'https://example.com/mockup.png'});
  await store.run("INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES('initial','501','101',3200,'usd',?)",JSON.stringify(variant));
  const app=createApp({stripe,printful,now:()=>time});
  const request=async(path,body,options={})=>{
    const response=await app.fetch(new Request(`https://api.example.com${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:env.STOREFRONT_ORIGIN,'Content-Type':'application/json',...options.headers},body:body===undefined?undefined:JSON.stringify(body)}),env,options.ctx);
    return {status:response.status,body:await response.json()};
  };
  const items=[{product_id:'101',variant_id:'501',quantity:1}];
  const checkout=async(extra={})=>request('/api/checkout',{items,request_id:crypto.randomUUID(),...extra});
  const webhook=async(type='checkout.session.completed',id='evt_fixture_1',session='cs_fixture_1',headers={})=>request('/api/webhooks/stripe',{id,type,livemode:stripe.live,data:{object:{id:session}}},{headers:{'Stripe-Signature':'fixture-signature',...headers}});
  return {db,store,stripe,printful,env,app,request,items,checkout,webhook,advance:seconds=>{time+=seconds;},now:()=>time};
}
