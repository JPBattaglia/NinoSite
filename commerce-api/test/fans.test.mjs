// Nino's Mobile App extras (src/fans.mjs): reward stamps, reward orders, 24-hour early access and the ideas board.
import test from 'node:test';
import assert from 'node:assert/strict';
import {D1Fixture,PrintfulFixture} from './fixtures.mjs';
import {Store} from '../src/db.mjs';
import * as fans from '../src/fans.mjs';
import {placedItems} from '../src/fulfillment.mjs';
import {storefrontProducts} from '../../catalog-sync.mjs';

const KEY = 'k'.repeat(40), OTHER = 'o'.repeat(40);
const env = {STOREFRONT_ORIGIN: 'https://ninobattaglia.com', OWNER_EMAIL: 'owner@example.com'};
const shirt = (qty, extra = {}) => ({product_id: '101', variant_id: '501', quantity: qty, kind: 'tshirt', title: 'Skull Wave T',
  variant: {catalog_variant_id: 4011, size: 'M', color: 'Navy', files: [{id: 900, type: 'default', hash: 'h'}]}, unit_price_cents: 2500, line_total_cents: 2500 * qty, ...extra});

async function setup() {
  const db = new D1Fixture(); const store = new Store(db);
  const mail = []; const e = {...env, MAILER: {send: async m => { mail.push(m); }}};
  return {db, store, mail, env: e};
}
async function order(store, id, lines, {member = KEY, live = 1, status = 'confirmed'} = {}) {
  const snapshot = {lines, subtotal_cents: 1, currency: 'usd', shipping: {method: 'STANDARD'}, ...(member ? {app_member_hash: await fans.memberHash(member)} : {})};
  await store.run(`INSERT INTO commerce_orders(id,request_key,request_hash,snapshot_json,receipt_token,live_mode,payment_status,fulfillment_status,recipient_json,customer_email,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'paid',?,?,?,1,1)`, id, `rk-${id}`, 'h', JSON.stringify(snapshot), 't', live, status, JSON.stringify({name: 'Fan', address1: '1 Main St', city: 'SF', state_code: 'CA', country_code: 'US', zip: '94102'}), 'fan@example.com');
  return store.order(id);
}

test('the ladder: a canvas at the 3rd shirt, a hoodie at the 6th, then it starts again', () => {
  assert.deepEqual(fans.rewardsCrossed(0, 2), []);
  assert.deepEqual(fans.rewardsCrossed(2, 3), ['canvas']);
  assert.deepEqual(fans.rewardsCrossed(0, 6), ['canvas', 'hoodie'], 'one big order earns both');
  assert.deepEqual(fans.rewardsCrossed(6, 9), ['canvas'], 'second round');
  assert.deepEqual(fans.ladder(4).next, {tier: 'hoodie', at: 6, remaining: 2});
  assert.deepEqual(fans.ladder(6).next, {tier: 'canvas', at: 3, remaining: 3});
  assert.equal(fans.validMember('short'), false);
  assert.equal(fans.validMember(KEY), true);
});

test('paid app orders count their shirts once; other products, test payments and non-app orders do not', async () => {
  const {store} = await setup();
  const o1 = await order(store, 'ord_1', [shirt(2), {...shirt(1), kind: 'mug'}]);
  assert.deepEqual((await fans.recordAppStamps(store, o1, 10)).rewards, []);
  assert.equal((await fans.recordAppStamps(store, o1, 11)).counted, false, 'a repeated webhook adds nothing');
  const o2 = await order(store, 'ord_2', [shirt(1)]);
  assert.deepEqual((await fans.recordAppStamps(store, o2, 12)).rewards, ['canvas']);
  assert.equal((await fans.recordAppStamps(store, await order(store, 'ord_t', [shirt(5)], {live: 0}), 13)).skipped, 'not_live');
  assert.equal((await fans.recordAppStamps(store, await order(store, 'ord_n', [shirt(5)], {member: null}), 13)).skipped, 'not_app');
  const card = await fans.memberCard(store, await fans.memberHash(KEY));
  assert.equal(card.shirts, 3);
  assert.deepEqual(card.next, {tier: 'hoodie', at: 6, remaining: 3});
  assert.deepEqual(card.rewards.map(r => [r.tier, r.status]), [['canvas', 'waiting']]);
});

async function catalog(store) {
  await store.run("INSERT INTO catalog_sync_runs(id,product_ids_json,status,created_at,updated_at) VALUES('g1','[]','complete',1,1)");
  await store.run("INSERT INTO commerce_settings(key,value) VALUES('active_catalog','g1')");
  await store.run("INSERT INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES('g1','202','nx-hoodie-101','Skull Wave Hoodie','x',1)");
  for (const [id, size, color] of [['601', 'M', 'Black'], ['602', 'L', 'Black'], ['603', 'M', 'Navy']])
    await store.run("INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES('g1',?,'202',4000,'usd',?)", id, JSON.stringify({id, size, color, catalog_variant_id: 9000 + Number(id), files: [{id: 950, type: 'default', hash: 'hh'}]}));
}

test('a hoodie reward ships on its own Printful order, in the shirt\'s size and color, once the paying order is confirmed', async () => {
  const {store, env: e} = await setup(); await catalog(store);
  const printful = new PrintfulFixture();
  const o = await order(store, 'ord_h', [shirt(6)], {status: 'queued'});
  await fans.recordAppStamps(store, o, 1);
  assert.deepEqual((await fans.processRewards(store, e, printful, 5, {placedItems})).idle, true, 'waits for the paying order');
  await store.run("UPDATE commerce_orders SET fulfillment_status='confirmed' WHERE id='ord_h'");
  // The canvas is first (older ladder step); make Printful's catalog have none so it goes to the owner.
  const noCanvas = async url => Response.json({code: 200, result: String(url).endsWith('/products') ? [] : {}});
  const first = await fans.processRewards(store, e, printful, 5, {placedItems, fetcher: noCanvas});
  assert.ok(first.failed && /canvas_not_in_catalog/.test(first.error));
  const second = await fans.processRewards(store, e, printful, 6, {placedItems});
  assert.equal(second.tier, 'hoodie');
  assert.equal(printful.confirmCalls, 1, 'hoodies go out on their own');
  const item = printful.lastItems[0];
  assert.equal(item.variant_id, 9603, 'Navy M, like the shirt');
  assert.equal(item.retail_price, '0.00');
  assert.ok(!printful.lastItems.some(i => i.external_id === 'gift_sticker'), 'no extra sticker on a reward');
});

test('a canvas reward is placed as a draft for the owner to confirm, with the design on Printful\'s 8x10 canvas', async () => {
  const {store, mail, env: e} = await setup(); await catalog(store);
  const printful = new PrintfulFixture();
  await fans.recordAppStamps(store, await order(store, 'ord_c', [shirt(3)]), 1);
  const fetcher = async url => {
    const u = String(url);
    if (u.endsWith('/products')) return Response.json({code: 200, result: [{id: 3, type: 'CANVAS', type_name: 'Canvas', title: 'Canvas (in)', model: 'Canvas'}, {id: 4, type: 'FRAMED-POSTER', title: 'Framed poster'}]});
    if (u.endsWith('/products/3')) return Response.json({code: 200, result: {variants: [{id: 19, size: '12″×16″', price: '30', availability_status: [{region: 'US', status: 'in_stock'}]}, {id: 823, size: '8″×10″', price: '22', availability_status: [{region: 'US', status: 'in_stock'}]}]}});
    if (u.includes('/printfiles/3')) return Response.json({code: 200, result: {variant_printfiles: [{variant_id: 823, placements: {default: 7}}], printfiles: [{printfile_id: 7, width: 1500, height: 1200}]}});
    return Response.json({code: 404}, {status: 404});
  };
  const done = await fans.processRewards(store, e, printful, 5, {placedItems, fetcher});
  assert.equal(done.draft_only, true);
  assert.equal(printful.confirmCalls, 0);
  assert.equal(printful.lastItems[0].variant_id, 823);
  assert.equal(printful.lastItems[0].files[0].position.area_width, 1500);
  assert.match(mail[0].subject, /Confirm a free canvas print/);
  assert.match(mail[0].html, /Confirm order/);
  await store.run("INSERT INTO commerce_settings(key,value) VALUES('reward_canvas_auto','on')");
  await fans.recordAppStamps(store, await order(store, 'ord_c2', [shirt(6)]), 2);
  await store.run("UPDATE app_rewards SET status='sent' WHERE tier='hoodie'");
  const auto = await fans.processRewards(store, e, printful, 9, {placedItems, fetcher});
  assert.equal(auto.draft_only, false, 'once the owner switches it on, canvases go out on their own');
});

test('early access: designs remember when they first appeared; the first run marks today\'s catalog as released', async () => {
  const {store} = await setup();
  const first = await fans.releaseTimes(store, ['1', '2'], 1000);
  assert.equal(first.get('1'), 0);
  const later = await fans.releaseTimes(store, ['1', '2', '3'], 5000);
  assert.equal(later.get('3'), 5000);
  assert.equal(later.get('1'), 0);
  const live = new Map([['3', {id: '3', title: 'New One', image: 'https://x/y.png', released_at: 5000, variants: new Map()}]]);
  assert.equal(storefrontProducts([], live, true)[0].released_at, 5000, 'the site keeps released_at for its 24-hour check');
});

async function call(store, e, method, path, body, origin = 'capacitor://localhost', now = 100000, ip = '') {
  const url = new URL(`https://api.example${path}`);
  const request = new Request(url, {method, headers: {Origin: origin, ...(ip ? {'CF-Connecting-IP': ip} : {}), ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  return fans.fansRoute(request, url, store, e, now, {'Cache-Control': 'no-store'});
}

test('ideas: fans post (shown after the owner OKs it from the email), vote once, and see their own pending ones', async () => {
  const {store, mail, env: e} = await setup();
  const posted = await call(store, e, 'POST', '/api/ideas', {member: KEY, name: 'Sam', text: 'A skeleton surfing the Golden Gate'});
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get('Access-Control-Allow-Origin'), 'capacitor://localhost');
  const {id} = await posted.json();
  let board = await (await call(store, e, 'GET', `/api/ideas?member=${KEY}`)).json();
  assert.equal(board.ideas.length, 0, 'not public until approved');
  assert.equal(board.pending.length, 1);
  const link = /href="([^"]+do=live)"/.exec(mail[0].html)[1].replace(/&amp;/g, '&');
  const reviewUrl = new URL(link);
  const look = await fans.fansRoute(new Request(reviewUrl), reviewUrl, store, e, 1, {});
  assert.match(await look.text(), /Show this idea\?/, 'opening the link only asks');
  const yes = await fans.fansRoute(new Request(reviewUrl, {method: 'POST'}), reviewUrl, store, e, 1, {});
  assert.match(await yes.text(), /on the Ideas board/);
  const bad = new URL(link.replace(/k=[a-f0-9]+/, 'k=wrong'));
  assert.equal((await fans.fansRoute(new Request(bad, {method: 'POST'}), bad, store, e, 1, {})).status, 401);
  assert.equal((await (await call(store, e, 'POST', '/api/ideas/vote', {member: OTHER, id})).json()).votes, 1);
  board = await (await call(store, e, 'GET', `/api/ideas?member=${OTHER}`)).json();
  assert.deepEqual(board.ideas.map(i => [i.text, i.votes, i.voted]), [['A skeleton surfing the Golden Gate', 1, true]]);
  assert.equal((await (await call(store, e, 'POST', '/api/ideas/vote', {member: OTHER, id})).json()).votes, 0, 'tapping again takes the vote back');
  const link2 = await call(store, e, 'POST', '/api/ideas', {member: KEY, text: 'see https://spam.example'});
  assert.equal(link2.status, 400);
  assert.equal(link2.headers.get('Access-Control-Allow-Origin'), 'capacitor://localhost', 'errors are readable by the app');
  for (let i = 0; i < 2; i++) await call(store, e, 'POST', '/api/ideas', {member: KEY, text: `Another idea number ${i}`});
  assert.equal((await call(store, e, 'POST', '/api/ideas', {member: KEY, text: 'One idea too many'})).status, 429);
  assert.equal((await call(store, e, 'GET', '/api/app/card?member=bad')).status, 400);
  assert.equal((await (await call(store, e, 'GET', `/api/app/card?member=${KEY}`)).json()).next.tier, 'canvas');
  assert.equal((await call(store, e, 'GET', '/api/ideas', null, 'https://evil.example')).headers.get('Access-Control-Allow-Origin'), null);
});

test('the app\'s new-designs list: designs from the last 7 days with their lowest shirt price', async () => {
  const {store, env: e} = await setup(); await catalog(store);
  await store.run("INSERT INTO catalog_products(generation,id,external_id,title,image,synced_at) VALUES('g1','303',NULL,'Fresh Drop T','https://img/x.png',1)");
  await store.run("INSERT INTO catalog_variants(generation,id,product_id,price_cents,currency,snapshot_json) VALUES('g1','701','303',2500,'usd','{}'),('g1','702','303',2700,'usd','{}')");
  await fans.releaseTimes(store, ['202'], 10);
  await fans.releaseTimes(store, ['202', '303'], 1800000000);
  const res = await call(store, e, 'GET', '/api/releases', null, 'https://anything.example', 1800000100);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.deepEqual(body.designs, [{id: '303', title: 'Fresh Drop', image: 'https://img/x.png', price_cents: 2500, released_at: 1800000000}]);
});

test('ideas on the website: same board, the site\'s own CORS, and the owner\'s email says where the idea came from', async () => {
  const {store, mail, env: e} = await setup();
  const site = 'https://ninobattaglia.com';
  const pre = await fans.fansRoute(new Request('https://api.example/api/ideas', {method: 'OPTIONS', headers: {Origin: site}}), new URL('https://api.example/api/ideas'), null, e, 0, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), site);
  const posted = await call(store, e, 'POST', '/api/ideas', {member: KEY, text: 'A cable car doing a kickflip', source: 'site'}, site);
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get('Access-Control-Allow-Origin'), site);
  assert.equal(mail[0].subject, 'New design idea from ninobattaglia.com');
  assert.match(mail[0].html, /suggested on ninobattaglia\.com/);
  await call(store, e, 'POST', '/api/ideas', {member: OTHER, text: 'A grumpy frog on a Vespa'});
  assert.equal(mail[1].subject, 'New design idea from the Nino app', 'the app is unchanged');
  const noKey = await call(store, e, 'POST', '/api/ideas', {text: 'No key from the website', source: 'site'}, site);
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json()).message, 'Reload the page and try again.', 'no "open the app" message on the website');
  assert.equal((await call(store, e, 'POST', '/api/ideas', [1, 2], site)).status, 400);
});

test('ideas spam guards: the honeypot saves nothing, and visitors and the whole board have daily caps', async () => {
  const {store, mail, env: e} = await setup();
  const site = 'https://ninobattaglia.com';
  const bot = await call(store, e, 'POST', '/api/ideas', {member: KEY, text: 'Buy cheap followers now', website: 'x', source: 'site'}, site);
  assert.equal(bot.status, 200, 'bots see the normal answer');
  assert.equal((await store.first('SELECT COUNT(*) AS n FROM app_ideas')).n, 0);
  assert.equal(mail.length, 0);
  // One visitor IP, many fresh keys: stops at the per-IP cap.
  const key = i => `ip${String(i).padStart(38, '0')}`;
  for (let i = 0; i < fans.MAX_IDEAS_PER_IP; i++) assert.equal((await call(store, e, 'POST', '/api/ideas', {member: key(i), text: `Idea number ${i} from one place`, source: 'site'}, site, 100000, '203.0.113.9')).status, 200);
  const over = await call(store, e, 'POST', '/api/ideas', {member: key(99), text: 'One more from the same place', source: 'site'}, site, 100000, '203.0.113.9');
  assert.equal(over.status, 429);
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM signup_limits WHERE k LIKE 'idea-ip:%' AND k NOT LIKE '%203.0.113.9%'")).n, 1, 'the IP is stored hashed');
  // Many places: stops at the board's daily total, which also caps the owner emails.
  let n = fans.MAX_IDEAS_PER_IP;
  for (let i = 0; n < fans.MAX_IDEAS_IN_ALL; i++, n++) assert.equal((await call(store, e, 'POST', '/api/ideas', {member: key(200 + i), text: `Idea number ${n} from elsewhere`}, 'capacitor://localhost', 100000, `198.51.100.${i}`)).status, 200);
  const full = await call(store, e, 'POST', '/api/ideas', {member: key(300), text: 'Too late for today'}, 'capacitor://localhost', 100000, '192.0.2.1');
  assert.equal(full.status, 429);
  assert.equal((await full.json()).error, 'ideas_full');
  assert.equal(mail.length, fans.MAX_IDEAS_IN_ALL);
  const nextDay = await call(store, e, 'POST', '/api/ideas', {member: key(300), text: 'A new day, a new idea'}, 'capacitor://localhost', 100000 + 86400, '192.0.2.1');
  assert.equal(nextDay.status, 200, 'the caps reset each day');
});

test('the ideas page\'s reads use indexes (D1 bills every row a query scans)', async () => {
  const {readFileSync} = await import('node:fs');
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  for (const name of ['0008_app_fans.sql', '0009_idea_votes_member.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const plan = sql => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill('x')).map(r => r.detail).join(' | ');
  for (const [name, sql] of Object.entries(fans.IDEA_SQL)) {
    assert.match(plan(sql), /USING (COVERING )?INDEX/, `${name}: ${plan(sql)}`);
    assert.doesNotMatch(plan(sql), /SCAN app_/, `${name}: ${plan(sql)}`);
  }
  db.close();
});
