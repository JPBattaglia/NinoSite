import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {normalizeEmail,SIGNUP_DAILY_CAP,SIGNUP_IP_CAP} from '../src/subscribers.mjs';

const mailer=()=>({sent:[],async send(message){this.sent.push(message);return {id:`m${this.sent.length}`};}});
const setup=async()=>{const MAILER=mailer();const f=await fixture({MAILER,COMMERCE_API_ORIGIN:'https://api.example.com'});return {...f,MAILER};};
const tokenFrom=message=>message.text.match(/t=([a-f0-9]{48})/)[1];
const raw=(f,path,method='GET')=>f.app.fetch(new Request(`https://api.example.com${path}`,{method,redirect:'manual'}),f.env);

test('addresses are checked and lower-cased',()=>{
  assert.equal(normalizeEmail('  Fan@Example.COM '),'fan@example.com');
  for(const bad of ['','fan','fan@','fan@example','a b@example.com','<x>@example.com','fan@-example.com']) assert.equal(normalizeEmail(bad),null,bad);
});

test('signup is double opt-in: pending, confirmation email, then active on the link',async()=>{
  const f=await setup();
  const r=await f.request('/api/subscribe',{email:'Fan@Example.com',source:'footer/index'});
  assert.deepEqual([r.status,r.body],[200,{ok:true}]);
  let row=await f.store.first('SELECT * FROM subscribers');
  assert.equal(row.email,'fan@example.com');assert.equal(row.status,'pending');assert.equal(row.source,'footer/index');
  assert.equal(f.MAILER.sent.length,1);
  const [mail]=f.MAILER.sent;
  assert.equal(mail.to,'fan@example.com');assert.match(mail.subject,/Confirm your email/);
  assert.match(mail.html,/https:\/\/api\.example\.com\/api\/subscribe\/confirm\?t=[a-f0-9]{48}/);
  const res=await raw(f,`/api/subscribe/confirm?t=${tokenFrom(mail)}`);
  assert.equal(res.status,303);assert.equal(res.headers.get('Location'),'https://shop.example.com/?signup=confirmed');
  row=await f.store.first('SELECT * FROM subscribers');assert.equal(row.status,'active');assert.ok(row.confirmed_at);
  await f.request('/api/subscribe',{email:'fan@example.com'});
  assert.equal(f.MAILER.sent.length,1,'an active address gets no new email');
});

test('signup refuses other sites, bad addresses, and quietly drops bots',async()=>{
  const f=await setup();
  assert.equal((await f.request('/api/subscribe',{email:'fan@example.com'},{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await f.request('/api/subscribe',{email:'not-an-email'})).status,400);
  const bot=await f.request('/api/subscribe',{email:'bot@example.com',website:'http://spam'});
  assert.equal(bot.status,200);
  assert.equal(f.MAILER.sent.length,0);assert.equal(await f.store.first('SELECT * FROM subscribers'),null);
});

test('confirmation emails are capped per address, per visitor and per day',async()=>{
  const f=await setup();
  await f.request('/api/subscribe',{email:'fan@example.com'});
  await f.request('/api/subscribe',{email:'fan@example.com'});
  assert.equal(f.MAILER.sent.length,1,'one confirmation a day per address');
  f.advance(86401);
  await f.request('/api/subscribe',{email:'fan@example.com'});
  assert.equal(f.MAILER.sent.length,2,'a resend after a day');
  const g=await setup();
  for(let i=0;i<SIGNUP_IP_CAP+2;i++) await g.request('/api/subscribe',{email:`ip${i}@example.com`},{headers:{'CF-Connecting-IP':'203.0.113.9'}});
  assert.equal(g.MAILER.sent.length,SIGNUP_IP_CAP);
  const h=await setup();
  for(let i=0;i<SIGNUP_DAILY_CAP+3;i++) await h.request('/api/subscribe',{email:`d${i}@example.com`},{headers:{'CF-Connecting-IP':`198.51.100.${i}`}});
  assert.equal(h.MAILER.sent.length,SIGNUP_DAILY_CAP);
});

test('unsubscribe: GET only shows a button, POST unsubscribes, and re-joining needs a new confirmation',async()=>{
  const f=await setup();
  await f.request('/api/subscribe',{email:'fan@example.com'});
  const token=tokenFrom(f.MAILER.sent[0]);
  await raw(f,`/api/subscribe/confirm?t=${token}`);
  const page=await raw(f,`/api/unsubscribe?t=${token}`);
  assert.equal(page.status,200);assert.match(await page.text(),/<form method="post"/);
  assert.equal((await f.store.first('SELECT status FROM subscribers')).status,'active','opening the link changes nothing');
  const done=await raw(f,`/api/unsubscribe?t=${token}`,'POST');
  assert.equal(done.status,303);assert.equal(done.headers.get('Location'),'https://shop.example.com/?signup=unsubscribed');
  assert.equal((await f.store.first('SELECT status FROM subscribers')).status,'unsubscribed');
  assert.equal((await raw(f,`/api/subscribe/confirm?t=${token}`)).headers.get('Location'),'https://shop.example.com/?signup=expired');
  f.advance(86401);
  await f.request('/api/subscribe',{email:'fan@example.com'});
  assert.equal((await f.store.first('SELECT status FROM subscribers')).status,'pending');
  assert.notEqual(tokenFrom(f.MAILER.sent[1]),token,'a new token');
  assert.equal((await raw(f,'/api/unsubscribe?t=bad')).status,400);
});
