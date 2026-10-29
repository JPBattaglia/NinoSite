// Logo merch for Menu-made's staff merch page (owner decision Oct 28, 2026, 9:02 pm): the buyer uploads their logo
// first and sees it on typical restaurant merch; Nino's designs stay an option on the shirts.
//
// This file knows the products (Printful catalog items, all stocked in the US), builds the data the page needs to draw
// mockups instantly in the browser (Printful's own mockup templates and print areas), and turns a cart of logo items
// into Printful order items with the logo placed exactly as the mockup showed it. Everything that needs the Printful
// token stays here; Menu-made reaches it through the NinoMerch entrypoint (main.mjs).
import {HttpError,fail,cents} from './common.mjs';

// scale: logo width as a share of the print area's width; align: where it sits in the area.
export const LOGO_PRODUCTS=Object.freeze([
  {key:'tee',id:438,title:'T-shirt',group:'Apparel',placement:'front',fileType:'default',technique:'dtg',scale:0.5,align:'top',nino:true},
  {key:'hoodie',id:146,title:'Hoodie',group:'Apparel',placement:'front',fileType:'default',technique:'dtg',scale:0.5,align:'top'},
  {key:'polo',id:670,title:'Polo shirt (embroidered)',group:'Apparel',placement:'embroidery_chest_left',fileType:'embroidery_chest_left',technique:'embroidery',scale:1,align:'center',threadOptions:['thread_colors_chest_left']},
  {key:'apron',id:297,title:'Apron (embroidered)',group:'Kitchen',placement:'front',fileType:'default',technique:'embroidery',scale:1,align:'center',threadOptions:['thread_colors_apparel']},
  {key:'cap',id:206,title:'Cap (embroidered)',group:'Hats',placement:'front',fileType:'default',technique:'embroidery',scale:1,align:'center',threadOptions:['thread_colors'],flat:true},
  {key:'beanie',id:266,title:'Beanie (embroidered)',group:'Hats',placement:'front',fileType:'default',technique:'embroidery',scale:1,align:'center',threadOptions:['thread_colors'],flat:true},
  {key:'mug',id:19,title:'Mug',group:'Tableware',placement:'default',fileType:'default',technique:'sublimation',scale:0.4,align:'center'},
  {key:'coaster',id:611,title:'Cork coaster',group:'Tableware',placement:'default',fileType:'default',technique:'sublimation',scale:0.8,align:'center'},
  {key:'tote',id:367,title:'Tote bag',group:'Extras',placement:'front',fileType:'default',technique:'dtg',scale:0.6,align:'center'},
  {key:'stickers',id:358,title:'Stickers',group:'Extras',placement:'default',fileType:'default',technique:'digital',scale:1,align:'center'}
]);
// Printful's embroidery threads (catalog option values). Embroidered items must say which threads the logo uses.
export const THREAD_COLORS=Object.freeze(['#FFFFFF','#000000','#96A1A8','#A67843','#FFCC00','#E25C27','#CC3366','#CC3333','#660000','#333366','#005397','#3399FF','#6B5294','#01784E','#7BA35A']);
const MAX_THREADS=6;
export function cleanThreads(list){
  const seen=[...new Set((Array.isArray(list)?list:[]).map(c=>String(c).toUpperCase()).filter(c=>THREAD_COLORS.includes(c)))];
  return seen.slice(0,MAX_THREADS);
}
// No thread list from the page: one thread that stands out on the item (white on dark, black on light).
function contrastThread(hex){
  const m=/^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if(!m) return '#000000';
  const n=parseInt(m[1],16),r=n>>16,g=(n>>8)&255,b=n&255;
  return (0.299*r+0.587*g+0.114*b)<140?'#FFFFFF':'#000000';
}
const BY_KEY=new Map(LOGO_PRODUCTS.map(p=>[p.key,p]));
export const productByKey=key=>BY_KEY.get(String(key || ''))||null;
const CACHE_KEY='merch_logo_products_v1';
const CACHE_SECONDS=86400;

async function api(env,method,path,body,fetcher){
  const response=await fetcher(`https://api.printful.com${path}`,{method,body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${env.PRINTFUL_ACCESS_TOKEN}`,'X-PF-Store-Id':env.PRINTFUL_STORE_ID,'Content-Type':'application/json'}});
  const text=await response.text();
  let json=null; try{json=JSON.parse(text);}catch{}
  if(!response.ok) throw new HttpError(response.status===429?503:502,'printful_request_failed',`${method} ${path.split('?')[0]} ${response.status}: ${String(json?.error?.message || json?.result || text).slice(0,200)}`);
  return json;
}

const num=v=>Number.isFinite(Number(v))?Number(v):null;
// Mockup templates differ a little between products; keep only what the page needs, with safe fallbacks.
export function normalizeTemplate(t){
  if(!t) return null;
  const w=num(t.template_width),h=num(t.template_height);
  const box={width:num(t.print_area_width),height:num(t.print_area_height),top:num(t.print_area_top),left:num(t.print_area_left)};
  if(!w || !h || !box.width || !box.height || box.top==null || box.left==null) return null;
  return {image:t.image_url || null,background:t.background_url || null,background_color:t.background_color || null,overlay:t.template_positioning==='overlay',width:w,height:h,box,placement:t.placement || null,variant_ids:(t.catalog_variant_ids || []).map(Number)};
}

// Builds the page's product list from Printful (US stock, base prices, mockup templates, print file sizes).
export async function buildLogoProducts(env,fetcher=(...a)=>fetch(...a)){
  const products=[];
  for(const p of LOGO_PRODUCTS){
    try{
      const catalog=(await api(env,'GET',`/products/${p.id}`,null,fetcher))?.result;
      const variants=(catalog?.variants || []).filter(v=>(v.availability_status || []).some(a=>a.region==='US' && a.status==='in_stock')).map(v=>({id:Number(v.id),color:v.color || '',color_code:v.color_code || null,size:v.size || 'One size',base_cents:cents(String(v.price),true),image:v.image || null})).filter(v=>v.base_cents);
      if(!variants.length) continue;
      let templates=[];
      try{
        const t=await api(env,'GET',`/v2/catalog-products/${p.id}/mockup-templates?limit=100`,null,fetcher);
        templates=(t?.data || []).map(normalizeTemplate).filter(Boolean);
      }catch{/* no templates: the page shows the product photo with the logo on it */}
      let printfile=null;
      try{
        const pf=(await api(env,'GET',`/mockup-generator/printfiles/${p.id}${p.technique==='embroidery'?'?technique=EMBROIDERY':''}`,null,fetcher))?.result;
        const id=pf?.variant_printfiles?.find(v=>Number(v.variant_id)===variants[0].id)?.placements?.[p.fileType] ?? pf?.variant_printfiles?.[0]?.placements?.[p.fileType];
        const file=(pf?.printfiles || []).find(f=>f.printfile_id===id);
        if(file) printfile={width:Number(file.width),height:Number(file.height),dpi:Number(file.dpi) || null};
      }catch{}
      const pick=templates.filter(t=>[p.placement,p.fileType,'front','default'].includes(t.placement));
      products.push({key:p.key,title:p.title,group:p.group,technique:p.technique,nino:Boolean(p.nino),scale:p.scale,align:p.align,printfile,
        templates:(pick.length?pick:templates).slice(0,40),variants});
    }catch(error){ console.error(`merch product ${p.key} unavailable: ${error.message}`); }
  }
  if(!products.length) fail(503,'merch_catalog_unavailable','Merch products are not available right now.');
  return {built_at:Math.floor(Date.now()/1000),products};
}

// Cached once a day in commerce_settings: one small read per page load (Menu-made also caches it at the edge).
export async function logoProducts(store,env,now,fetcher){
  const row=await store.first('SELECT value FROM commerce_settings WHERE key=?',CACHE_KEY);
  const cached=row?JSON.parse(row.value):null;
  if(cached && now-cached.built_at<CACHE_SECONDS) return cached;
  try{
    const fresh=await buildLogoProducts(env,fetcher);
    await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',CACHE_KEY,JSON.stringify(fresh));
    return fresh;
  }catch(error){ if(cached) return cached; throw error; }
}

// Where the logo goes in Printful's print file: the same share of the area, alignment and aspect as the mockup.
export function logoPosition(product,printfile,logo){
  if(!printfile?.width || !printfile?.height || !logo?.width || !logo?.height) return null;
  const aw=printfile.width,ah=printfile.height;
  let w=Math.round(aw*product.scale),h=Math.round(w*logo.height/logo.width);
  if(h>ah*(product.align==='top'?0.45:1)){h=Math.round(ah*(product.align==='top'?0.45:1));w=Math.round(h*logo.width/logo.height);}
  const left=Math.round((aw-w)/2),top=product.align==='top'?Math.round(ah*0.08):Math.round((ah-h)/2);
  return {area_width:aw,area_height:ah,width:w,height:h,top,left,limit_to_print_area:true};
}

// lines: [{key, variant_id, quantity}] -> Printful order items with the logo file.
export function logoOrderItems(lines,catalog,logo){
  return lines.map((line,i)=>{
    const product=catalog.products.find(p=>p.key===line.key);
    const def=productByKey(line.key);
    if(!product || !def) fail(400,'unknown_merch_product');
    const variant=product.variants.find(v=>v.id===Number(line.variant_id));
    if(!variant) fail(422,'variant_unavailable','A chosen item is no longer available.');
    const position=logoPosition(product,product.printfile,logo);
    const threads=cleanThreads(logo.thread_colors);
    const options=def.threadOptions?[
      ...def.threadOptions.map(id=>({id,value:threads.length?threads:[contrastThread(variant.color_code)]})),
      ...(def.flat?[{id:'embroidery_type',value:'flat'}]:[])
    ]:null;
    return {external_id:`logo_${i+1}`,variant_id:variant.id,quantity:line.quantity,name:`${product.title} (${[variant.color,variant.size].filter(Boolean).join(', ')})`.slice(0,100),
      files:[{type:def.fileType,url:logo.url,...(position?{position}:{})}],...(options?{options}:{})};
  });
}
