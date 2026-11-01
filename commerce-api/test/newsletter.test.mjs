import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {runNewsletter,addBuyerToNewsletter,NEWS_PER_RUN} from '../src/newsletter.mjs';

globalThis.fetch=async()=>Response.json({products:[{id:'101',description:'A fixture design.'}]});
const mailer=()=>({sent:[],async send(m){if(this.fail)throw new Error('down');this.sent.push(m);return {id:'m'};}});
const writer=()=>({briefs:[],async draft(b){this.briefs.push(b);return {subject:`Issue ${this.briefs.length}`,heading:'Fresh from the studio',intro:'Some designs.',cta_label:'See them'};}});
async function setup({address='PO Box 1, San Francisco, CA 94101',subscribers=3}={}){
  const MAILER=mailer(),WRITER=writer();
  const f=await fixture({MAILER,WRITER,OWNER_EMAIL:'owner@example.com',COMMERCE_API_ORIGIN:'https://api.example.com'});
  await f.store.run("INSERT INTO commerce_settings(key,value) VALUES('news_designs','101')");
  if(address) await f.store.run("INSERT INTO commerce_settings(key,value) VALUES('mailing_address',?)",address);
  for(let i=0;i<subscribers;i++) await f.store.run("INSERT INTO subscribers(email,status,token,created_at) VALUES(?, 'active', ?, 1)",`s${String(i).padStart(3,'0')}@example.com`,`${i}`.padStart(48,'a'));
  await f.store.run("INSERT INTO subscribers(email,status,token,created_at) VALUES('gone@example.com','unsubscribed',?,1)",'b'.repeat(48));
  return {...f,MAILER,WRITER};
}
const raw=(f,path,method='GET',body)=>f.app.fetch(new Request(`https://api.example.com${path}`,{method,body,redirect:'manual'}),f.env);
const issue=f=>f.store.first('SELECT * FROM newsletter_issues ORDER BY created_at DESC, rowid DESC LIMIT 1');
const linkOf=(mail,action)=>mail.text.match(new RegExp(`https://api\\.example\\.com(/api/newsletter/nl_[a-f0-9]{16}/${action}\\?t=[a-f0-9]{48})`))[1];
const draft=async(f,kind='monthly')=>{await f.store.run("INSERT INTO commerce_settings(key,value) VALUES('newsletter_draft_now',?)",kind);await runNewsletter(f.store,f.env,f.now());};

test('a draft goes only to the owner, with the real designs and prices and three approval links',async()=>{
  const f=await setup();
  await draft(f);
  assert.equal(f.MAILER.sent.length,1);
  const [mail]=f.MAILER.sent;
  assert.equal(mail.to,'owner@example.com');assert.match(mail.subject,/Newsletter ready for your OK: "Issue 1"/);
  assert.match(mail.html,/Fixture graphic shirt/);assert.match(mail.html,/Shirt from \$32/);assert.match(mail.html,/3 subscribers/);
  for(const a of ['approve','changes','skip']) assert.ok(linkOf(mail,a));
  assert.equal(f.WRITER.briefs[0].designs[0].description,'A fixture design.');
  assert.equal((await issue(f)).status,'awaiting');
  await runNewsletter(f.store,f.env,f.now());
  assert.equal(f.MAILER.sent.length,1,'nothing goes to subscribers before approval');
});

test('opening a link changes nothing; approving sends to active subscribers only, in batches, with unsubscribe',async()=>{
  const f=await setup({subscribers:NEWS_PER_RUN+5});
  await draft(f);const approve=linkOf(f.MAILER.sent[0],'approve');
  const page=await raw(f,approve);assert.equal(page.status,200);assert.match(await page.text(),/Send “Issue 1”\?/);
  assert.equal((await issue(f)).status,'awaiting');
  await raw(f,approve,'POST');assert.equal((await issue(f)).status,'sending');
  await runNewsletter(f.store,f.env,f.now());
  let news=f.MAILER.sent.filter(m=>m.kind==='news');
  assert.equal(news.length,NEWS_PER_RUN);
  assert.ok(news.every(m=>/\/api\/unsubscribe\?t=[a-f0-9]{48}$/.test(m.unsubscribe)&&m.html.includes(m.unsubscribe)&&m.html.includes('PO Box 1')));
  await runNewsletter(f.store,f.env,f.now());
  news=f.MAILER.sent.filter(m=>m.kind==='news');
  assert.equal(news.length,NEWS_PER_RUN+5);assert.equal(new Set(news.map(m=>m.to)).size,NEWS_PER_RUN+5);
  assert.ok(!news.some(m=>m.to==='gone@example.com'));
  assert.equal((await issue(f)).status,'sent');assert.equal((await issue(f)).sent_count,NEWS_PER_RUN+5);
  assert.match(f.MAILER.sent.at(-1).subject,/^Newsletter sent/);
  assert.match(await (await raw(f,approve,'POST')).text(),/was sent to 25 subscribers/);
});

test('no mailing address: approval is refused and nothing is sent',async()=>{
  const f=await setup({address:null});
  await draft(f);
  assert.match(f.MAILER.sent[0].html,/Can’t send yet/);
  const res=await raw(f,linkOf(f.MAILER.sent[0],'approve'),'POST');
  assert.equal(res.status,409);assert.equal((await issue(f)).status,'awaiting');
});

test('ask for changes redrafts with the note; skip and wrong tokens send nothing',async()=>{
  const f=await setup();
  await draft(f);
  const form=new FormData();form.set('note','use a funnier subject');
  await raw(f,linkOf(f.MAILER.sent[0],'changes'),'POST',form);
  assert.equal(f.WRITER.briefs[1].ownerNote,'use a funnier subject');
  assert.equal(f.MAILER.sent.length,2);assert.match(f.MAILER.sent[1].html,/Your changes:<\/b> use a funnier subject/);
  assert.equal((await f.store.first("SELECT COUNT(*) AS n FROM newsletter_issues WHERE status='replaced'")).n,1);
  const skip=linkOf(f.MAILER.sent[1],'skip');
  assert.equal((await raw(f,skip.replace(/t=[a-f0-9]+/,'t='+'0'.repeat(48)),'POST')).status,404);
  await raw(f,skip,'POST');assert.equal((await issue(f)).status,'skipped');
  await runNewsletter(f.store,f.env,f.now());
  assert.equal(f.MAILER.sent.filter(m=>m.kind==='news').length,0);
});

test('the template is used when the writer is down, and unanswered drafts expire',async()=>{
  const f=await setup();f.env.WRITER={async draft(){throw new Error('cap');}};
  await f.store.run("INSERT INTO commerce_settings(key,value) VALUES('news_holiday_designs','101')");
  await draft(f,'holiday');
  assert.match(f.MAILER.sent[0].subject,/The Nino holiday drop is here/);
  f.advance(8*86400);await runNewsletter(f.store,f.env,f.now(),{daily:true});
  assert.equal((await f.store.first('SELECT status FROM newsletter_issues')).status,'expired');
});

test('U.S. buyers join the list; other countries and unsubscribed addresses do not',async()=>{
  const f=await setup();
  const order=(email,country)=>({customer_email:email,recipient_json:JSON.stringify({country_code:country})});
  assert.equal(await addBuyerToNewsletter(f.store,order('Buyer@Example.com','US'),1),'added');
  assert.equal((await f.store.first("SELECT status,source FROM subscribers WHERE email='buyer@example.com'")).source,'order');
  assert.equal(await addBuyerToNewsletter(f.store,order('ca@example.com','CA'),1),'skipped');
  assert.equal(await addBuyerToNewsletter(f.store,order('gone@example.com','US'),1),'exists');
  assert.equal((await f.store.first("SELECT status FROM subscribers WHERE email='gone@example.com'")).status,'unsubscribed');
});
