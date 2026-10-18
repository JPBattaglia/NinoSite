import {fail} from './common.mjs';

export const PRINTFUL_COUNTRY_CACHE_KEY='printful_shipping_countries_v1';
export const PRINTFUL_COUNTRY_CACHE_TTL=6*60*60;
const MAX_COUNTRIES=300;
const MAX_CACHE_BYTES=10000;

export function usesPrintfulCountries(env) {
  return typeof env.SHIPPING_COUNTRIES==='string' && env.SHIPPING_COUNTRIES.trim().toUpperCase()==='PRINTFUL';
}
function codes(value) {
  if(!Array.isArray(value) || !value.length || value.length>MAX_COUNTRIES || value.some(code=>typeof code!=='string' || !/^[A-Z]{2}$/.test(code)) || new Set(value).size!==value.length) return null;
  return [...value].sort();
}
function cachedCountries(raw,now) {
  if(typeof raw!=='string' || raw.length>MAX_CACHE_BYTES) return null;
  try {
    const cache=JSON.parse(raw);
    if(cache.version!==1 || !Number.isSafeInteger(cache.fetched_at) || cache.fetched_at<=0 || cache.fetched_at>now || now-cache.fetched_at>=PRINTFUL_COUNTRY_CACHE_TTL) return null;
    return codes(cache.countries);
  } catch {return null;}
}
function providerCountries(value) {
  if(!Array.isArray(value) || !value.length || value.length>MAX_COUNTRIES) return null;
  if(value.some(country=>!country || typeof country.name!=='string' || !country.name.trim() || country.name.length>150 || typeof country.code!=='string')) return null;
  return codes(value.map(country=>country.code));
}

export async function resolveShippingCountries(env,store,printful,now) {
  if(!usesPrintfulCountries(env)) return env;
  if(typeof env.PRINTFUL_ACCESS_TOKEN!=='string' || !env.PRINTFUL_ACCESS_TOKEN.trim()) fail(503,'shipping_countries_unavailable','Delivery destinations are not available right now.');
  try {
    const row=await store.first('SELECT value FROM commerce_settings WHERE key=?',PRINTFUL_COUNTRY_CACHE_KEY);
    let accepted=cachedCountries(row?.value,now);
    if(!accepted) {
      accepted=providerCountries(await printful.getCountries());
      if(!accepted) throw new Error('Invalid provider countries');
      const value=JSON.stringify({version:1,fetched_at:now,countries:accepted});
      if(value.length>MAX_CACHE_BYTES) throw new Error('Invalid country cache size');
      await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',PRINTFUL_COUNTRY_CACHE_KEY,value);
    }
    return {...env,SHIPPING_COUNTRIES:accepted.join(',')};
  } catch {
    fail(503,'shipping_countries_unavailable','Delivery destinations are not available right now.');
  }
}
