// Nino's Mobile App extras (owner decisions, Nov 8, 2026). The app is built by Menu-made (MENU repo, app-shell/ and
// booking-api/src/store-app/hybrid.js); everything about Nino's customers stays here, in the shop's own database.
//
// 1. Rewards for shirts bought through the app. The app keeps a random member key on the phone and opens the shop
//    with ?app=<key>; the site keeps it (site.js) and sends it with the checkout (commerce.js -> checkout.mjs, stored
//    as the key's SHA-256 in the order snapshot). When the order is paid, each shirt in it counts (recordAppStamps).
//    Ladder: the 3rd shirt earns a free 8x10 canvas, the 6th a free hoodie, then it starts again. Shirts only, and
//    one canvas and one hoodie at most per order. A reward is its own Printful order at $0 to the buyer's address,
//    sent once its paying order is confirmed at Printful (processRewards, from the 5-minute run). The hoodie: the
//    design of the order's first shirt, in that shirt's size and color (black, else the first color, when the hoodie
//    doesn't come in it). The canvas: that design's artwork on Printful's 8x10in canvas; it is placed as a DRAFT and
//    the owner is emailed to confirm it in Printful until he switches commerce_settings 'reward_canvas_auto' to 'on'
//    (the first canvases are checked by eye; Printful's canvas has never been printed for this shop).
//    Owner: cost per reward, Nov 8 estimates: canvas ~$32-35 delivered, hoodie ~$25-38; a shirt earns ~$13-15.
// 2. 24-hour early access: design_releases records when each design first appeared (catalog.mjs publicCatalog adds
//    released_at to /api/products). The website hides a design for its first 24 hours unless the visitor came from
//    the app (site.js); the app shows it at once with an "App first" badge, and Menu-made's worker sends the push.
// 3. Ideas board: fans post a design idea (shown once Nino OKs it from an emailed link) and vote on others.
//    One board, two doors (Nov 9, 2026): the app's Ideas tab and ninobattaglia.com/ideas.html (ideas.js). A website
//    visitor gets their own random key in that browser, kept apart from the app's key so it never counts toward app
//    rewards; a visitor who came from the app uses the app's key. The site sends source 'site', so error messages and
//    the owner's email say where the idea came from. Spam guards, because the website form is open to anyone (and the
//    owner emails go through Menu-made's mail quota): a hidden honeypot field, 3 ideas a day per key, 10 a day per
//    visitor IP (hashed, never stored raw) and 25 a day in all.
//
// Routes (CORS: the app's own origins and the shop):
//   GET  /api/app/card?member=<key>          the member's shirts, next reward and reward history
//   GET  /api/ideas?member=<key>             live ideas (most votes first), which ones this member voted for, own pending
//   POST /api/ideas         {member,text,name?,source?}   a new idea, pending until approved (source 'site' or 'app')
//   POST /api/ideas/vote    {member,id,source?}           vote / take back a vote
//   GET|POST /api/ideas/review?k=<key>&id=<id>&do=live|hidden   the owner's emailed approve / hide link
//   GET  /api/releases                       designs that appeared in the last 7 days (the app's "new" list; public)
import {HttpError,fail,hash,requestJson} from './common.mjs';
import {position,api as printfulApi,catalogVariants} from './expand.mjs';
import {withinLimit,dayOf} from './subscribers.mjs';

export const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'https://localhost']);
export const CANVAS_AT = 3, HOODIE_AT = 6, CYCLE = 6;
export const EARLY_SECONDS = 86400;
const MEMBER = /^[A-Za-z0-9_-]{32,64}$/;
const REVIEW_KEY = 'ideas_review_key';
const CANVAS_KEY = 'reward_canvas';
const CANVAS_AUTO = 'reward_canvas_auto';
const MAX_IDEAS_PER_DAY = 3;
export const MAX_IDEAS_PER_IP = 10, MAX_IDEAS_IN_ALL = 25;
const fromSite = body => body?.source === 'site';
const randomHex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export const validMember = key => typeof key === 'string' && MEMBER.test(key);
export const memberHash = key => hash(`nino-app-member:${key}`);

// Rewards earned going from `before` to `after` shirts (at most one of each tier per order).
export function rewardsCrossed(before, after) {
  const tiers = new Set();
  for (let n = before + 1; n <= after; n++) {
    if (n % CYCLE === CANVAS_AT) tiers.add('canvas');
    if (n % CYCLE === HOODIE_AT % CYCLE) tiers.add('hoodie');
  }
  return [...tiers];
}
export function ladder(shirts) {
  const pos = shirts % CYCLE;
  const next = pos < CANVAS_AT ? {tier: 'canvas', at: CANVAS_AT, remaining: CANVAS_AT - pos} : {tier: 'hoodie', at: HOODIE_AT, remaining: HOODIE_AT - pos};
  return {shirts, position: pos, cycle: CYCLE, next};
}

// From the Stripe webhook, once an order is paid. Live orders only (test payments never earn rewards). Never throws.
export async function recordAppStamps(store, order, now) {
  try {
    if (!order || order.live_mode !== 1) return {skipped: 'not_live'};
    const snapshot = JSON.parse(order.snapshot_json || '{}');
    const member = snapshot.app_member_hash;
    if (typeof member !== 'string' || !/^[a-f0-9]{64}$/.test(member)) return {skipped: 'not_app'};
    const shirts = (snapshot.lines || []).filter(line => !line.kind || line.kind === 'tshirt').reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
    const added = await store.run('INSERT OR IGNORE INTO app_stamps(order_id,member_hash,shirts,created_at) VALUES(?,?,?,?)', order.id, member, shirts, now);
    if (!added?.meta?.changes || !shirts) return {shirts, counted: false};
    await store.run('INSERT INTO app_members(member_hash,shirts,created_at,updated_at) VALUES(?,0,?,?) ON CONFLICT(member_hash) DO NOTHING', member, now, now);
    const row = await store.first('SELECT shirts FROM app_members WHERE member_hash=?', member);
    const before = Number(row?.shirts || 0), after = before + shirts;
    const statements = [['UPDATE app_members SET shirts=?,updated_at=? WHERE member_hash=? AND shirts=?', after, now, member, before]];
    const tiers = rewardsCrossed(before, after);
    for (const tier of tiers) statements.push(['INSERT OR IGNORE INTO app_rewards(id,member_hash,order_id,tier,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', `rw_${(await hash(`${order.id}:${tier}`)).slice(0, 24)}`, member, order.id, tier, 'waiting', now, now]);
    await store.batch(statements);
    return {shirts, counted: true, before, after, rewards: tiers};
  } catch (error) {
    console.error('app stamps not recorded', error?.message || error);
    return {error: true};
  }
}

export async function memberCard(store, member) {
  const row = await store.first('SELECT shirts FROM app_members WHERE member_hash=?', member);
  const rewards = await store.all('SELECT tier,status,created_at FROM app_rewards WHERE member_hash=? ORDER BY created_at DESC LIMIT 10', member);
  return {...ladder(Number(row?.shirts || 0)), rewards: rewards.map(r => ({tier: r.tier, status: r.status === 'failed' ? 'sent' : r.status, at: r.created_at})),
    rules: {canvas: `A free 8x10 canvas print with your ${CANVAS_AT}rd shirt`, hoodie: `A free hoodie with your ${HOODIE_AT}th shirt`, repeat: 'Then it starts again. Only shirts bought in the app count.'}};
}

// ---- reward orders ----
async function setting(store, key) { return (await store.first('SELECT value FROM commerce_settings WHERE key=?', key))?.value ?? null; }
const putSetting = (store, key, value) => store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);

// Printful's 8x10in canvas: its catalog variant and print file size, looked up once a week (name match, so a catalog
// renumbering doesn't break it). Throws when Printful has no such canvas, so the reward goes to the owner.
export async function canvasVariant(store, env, now, fetcher = (...a) => fetch(...a)) {
  const cached = await setting(store, CANVAS_KEY);
  if (cached) { try { const c = JSON.parse(cached); if (now - c.at < 7 * 86400 && c.variant_id && c.area) return c; } catch {} }
  const list = (await printfulApi(env, 'GET', '/products', null, fetcher))?.result || [];
  const candidates = list.filter(p => /canvas/i.test(`${p.type} ${p.type_name} ${p.title} ${p.model}`) && !/framed|poster|tote|bag|shoe|sneaker/i.test(`${p.title} ${p.model} ${p.type_name}`));
  for (const product of candidates) {
    const variants = await catalogVariants(store, env, product.id, now, fetcher);
    const v = variants.find(x => /^\s*8\D{0,3}[x×]\D{0,3}10\b/i.test(x.size || '') && x.in_stock);
    if (!v) continue;
    const pf = (await printfulApi(env, 'GET', `/mockup-generator/printfiles/${product.id}`, null, fetcher))?.result;
    const placements = pf?.variant_printfiles?.find(p => Number(p.variant_id) === v.id)?.placements || {};
    const file = (pf?.printfiles || []).find(f => f.printfile_id === (placements.default ?? Object.values(placements)[0]));
    if (!file) continue;
    const found = {at: now, product_id: Number(product.id), variant_id: v.id, size: v.size, area: [Number(file.width), Number(file.height)], cost: v.price};
    await putSetting(store, CANVAS_KEY, JSON.stringify(found));
    return found;
  }
  fail(409, 'canvas_not_in_catalog', 'Printful has no 8x10 canvas in stock right now.');
}

const shirtLine = snapshot => (snapshot.lines || []).find(line => !line.kind || line.kind === 'tshirt');
const designTitle = line => String(line?.title || 'Nino design').replace(/\s+T$/, '');

async function hoodieItem(store, line) {
  const generation = await store.activeGeneration();
  const product = await store.first('SELECT id,title FROM catalog_products WHERE generation=? AND external_id=?', generation, `nx-hoodie-${line.product_id}`);
  if (!product) fail(409, 'hoodie_not_made_for_design', `${designTitle(line)} has no hoodie yet.`);
  const rows = await store.all('SELECT id,price_cents,snapshot_json FROM catalog_variants WHERE generation=? AND product_id=?', generation, product.id);
  const variants = rows.map(r => ({...r, s: JSON.parse(r.snapshot_json)}));
  const size = line.variant?.size, color = line.variant?.color;
  const pick = variants.find(v => v.s.size === size && v.s.color === color) || variants.find(v => v.s.size === size && /^black$/i.test(v.s.color || ''))
    || variants.find(v => v.s.size === size) || variants.find(v => /^black$/i.test(v.s.color || '')) || variants[0];
  if (!pick) fail(409, 'hoodie_variant_missing');
  return {product_id: String(product.id), variant_id: String(pick.id), quantity: 1, kind: 'hoodie', title: product.title, variant: pick.s, unit_price_cents: 0, line_total_cents: 0};
}

async function canvasItem(store, env, printful, line, now, fetcher) {
  const canvas = await canvasVariant(store, env, now, fetcher);
  // The design's own shirt artwork (every design is a shirt first).
  const file = (line.variant?.files || []).find(f => (f.type || 'default') === 'default' && f.id) || (line.variant?.files || [])[0];
  if (!file?.id) fail(409, 'artwork_missing');
  const art = await printful.getFile(file.id);
  const pos = art && position({fit: 'contain', margin: 0.08}, canvas.area, {width: art.width, height: art.height});
  if (!pos) fail(409, 'artwork_position_unknown');
  return {external_id: 'reward_canvas', variant_id: canvas.variant_id, quantity: 1, retail_price: '0.00', name: `Free canvas: ${designTitle(line)}`, files: [{type: 'default', id: file.id, position: pos}]};
}

async function ownerNote(env, subject, lines) {
  if (!env.MAILER?.send || !env.OWNER_EMAIL) return;
  try {
    await env.MAILER.send({to: env.OWNER_EMAIL, subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#171a1b">${lines.map(l => `<p>${l}</p>`).join('')}</div>`,
      text: lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n\n')});
  } catch (error) { console.error('owner note not sent', error?.message || error); }
}

// From the 5-minute run: one waiting reward whose paying order is confirmed at Printful. Returns what it did.
export async function processRewards(store, env, printful, now, {placedItems, fetcher = (...a) => fetch(...a)} = {}) {
  const reward = await store.first(`SELECT r.*,o.snapshot_json,o.recipient_json,o.customer_email FROM app_rewards r JOIN commerce_orders o ON o.id=r.order_id
    WHERE r.status='waiting' AND o.fulfillment_status='confirmed' AND r.updated_at<=? ORDER BY r.created_at LIMIT 1`, now);
  if (!reward) return {idle: true};
  const what = reward.tier === 'canvas' ? 'canvas print' : 'hoodie';
  try {
    const snapshot = JSON.parse(reward.snapshot_json);
    const line = shirtLine(snapshot);
    if (!line) fail(409, 'no_shirt_in_order');
    if (!reward.recipient_json) fail(409, 'address_missing');
    const external = reward.id;
    let draft = await printful.findOrder(external);
    if (!draft) {
      const items = reward.tier === 'canvas'
        ? [await canvasItem(store, env, printful, line, now, fetcher)]
        : (await placedItems({lines: [await hoodieItem(store, line)]}, store, printful, {gift: false})).map(item => ({...item, external_id: 'reward_hoodie', retail_price: '0.00', name: `Free hoodie: ${designTitle(line)}`}));
      draft = await printful.createDraft({external_id: external, shipping: 'STANDARD', recipient: {...JSON.parse(reward.recipient_json), email: reward.customer_email || undefined}, items,
        retail_costs: {currency: 'USD', subtotal: '0.00', shipping: '0.00', tax: '0.00', total: '0.00'}});
    }
    if (!draft?.id) fail(502, 'printful_draft_missing');
    const auto = reward.tier === 'hoodie' || String(await setting(store, CANVAS_AUTO) || '').toLowerCase() === 'on';
    if (auto && draft.status === 'draft') await printful.confirmOrder(draft.id);
    await store.run("UPDATE app_rewards SET status='sent',printful_order_id=?,draft_only=?,last_error=NULL,attempts=attempts+1,updated_at=? WHERE id=?", String(draft.id), auto ? 0 : 1, now, reward.id);
    if (!auto) await ownerNote(env, `Confirm a free ${what} in Printful (Nino app reward)`, [
      `An app customer earned a free <strong>${esc(what)}</strong> (${esc(designTitle(line))}) with order ${esc(reward.order_id)}.`,
      `It's waiting as a <strong>draft</strong> in Printful, order <strong>${esc(draft.id)}</strong>, so you can check the canvas looks right before it prints.`,
      'To send it: go to printful.com, sign in, click <strong>Orders</strong> in the left menu, open the order number above, check the preview, then click <strong>Confirm order</strong>.',
      `Once you've checked a couple and they look right, tell Claude to switch canvas rewards to send on their own.`]);
    return {sent: reward.id, tier: reward.tier, draft_only: !auto};
  } catch (error) {
    const attempts = Number(reward.attempts) + 1;
    const final = error?.status === 409 || attempts >= 5;
    await store.run('UPDATE app_rewards SET status=?,attempts=?,last_error=?,updated_at=? WHERE id=?', final ? 'failed' : 'waiting', attempts, String(error?.code || error?.message || 'error').slice(0, 200), now + Math.min(3600, 120 * 2 ** attempts), reward.id);
    if (final) await ownerNote(env, `A free ${what} needs sending by hand (Nino app reward)`, [
      `An app customer earned a free <strong>${esc(what)}</strong> with order ${esc(reward.order_id)}, but it couldn't be placed automatically: ${esc(error?.message || error?.code || 'unknown error')}.`,
      'Please send it by hand in Printful (Orders, then New order, to the same address as that order), or tell Claude and it will look into it.']);
    return {failed: reward.id, error: String(error?.code || error?.message)};
  }
}

// ---- early access ----
// Called by publicCatalog with the designs it's about to publish: returns {product_id: first_seen_at} and records the
// new ones (one read; one write batch only when something is new).
export async function releaseTimes(store, productIds, now) {
  const rows = await store.all('SELECT product_id,first_seen_at FROM design_releases');
  const seen = new Map(rows.map(r => [String(r.product_id), Number(r.first_seen_at)]));
  const fresh = productIds.map(String).filter(id => !seen.has(id));
  if (fresh.length) {
    // The very first run (an empty table) marks today's catalog as already released, so nothing existing is hidden.
    const at = rows.length ? now : 0;
    await store.batch(fresh.map(id => ['INSERT OR IGNORE INTO design_releases(product_id,first_seen_at) VALUES(?,?)', id, at]));
    for (const id of fresh) seen.set(id, at);
  }
  return seen;
}

// The designs that first appeared in the last 7 days, with a photo and their shirt price (lowest), newest first.
// Small on purpose: Menu-made's worker reads it for the app (most designs come from catalog.json there).
export async function recentReleases(store, now) {
  const generation = await store.activeGeneration();
  if (!generation) return {designs: [], early_seconds: EARLY_SECONDS};
  const rows = await store.all(`SELECT r.product_id AS id,r.first_seen_at AS released_at,p.title,p.image,
      (SELECT MIN(v.price_cents) FROM catalog_variants v WHERE v.generation=p.generation AND v.product_id=p.id) AS price_cents
    FROM design_releases r JOIN catalog_products p ON p.generation=? AND p.id=r.product_id
    WHERE r.first_seen_at>? ORDER BY r.first_seen_at DESC LIMIT 40`, generation, now - 7 * 86400);
  return {early_seconds: EARLY_SECONDS, designs: rows.map(r => ({id: String(r.id), title: String(r.title || '').replace(/\s+T$/, ''), image: r.image, price_cents: Number(r.price_cents) || null, released_at: Number(r.released_at)}))};
}

// ---- ideas ----
async function reviewKey(store) {
  let key = await setting(store, REVIEW_KEY);
  if (!key) { key = randomHex(24); await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', REVIEW_KEY, key); key = await setting(store, REVIEW_KEY); }
  return key;
}
async function sameKey(a, b) {
  const x = await hash(String(a || '')), y = await hash(String(b || ''));
  let m = 0; for (let i = 0; i < x.length; i++) m |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return !m && Boolean(a);
}
const reviewLink = (origin, key, id, action) => `${origin}/api/ideas/review?k=${key}&id=${encodeURIComponent(id)}&do=${action}`;
const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="margin:0;background:#200705;color:#f2efe7;font:17px/1.6 Arial,sans-serif"><main style="max-width:560px;margin:0 auto;padding:32px 20px"><h1 style="font-size:26px">${esc(title)}</h1>${body}</main></body></html>`, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'}});

// The board's reads, one page view each (test/fans.test.mjs checks they use indexes).
export const IDEA_SQL = {
  live: "SELECT id,name,text,votes,created_at FROM app_ideas WHERE status='live' ORDER BY votes DESC, created_at DESC LIMIT 60",
  votes: 'SELECT idea_id FROM app_idea_votes WHERE member_hash=? ORDER BY created_at DESC LIMIT 300',
  pending: "SELECT id,text,status,created_at FROM app_ideas WHERE member_hash=? AND status='pending' ORDER BY created_at DESC LIMIT 5",
  recent: 'SELECT COUNT(*) AS n FROM app_ideas WHERE member_hash=? AND created_at>?'
};
async function listIdeas(store, member) {
  const ideas = await store.all(IDEA_SQL.live);
  const voted = member ? new Set((await store.all(IDEA_SQL.votes, member)).map(r => r.idea_id)) : new Set();
  const mine = member ? await store.all(IDEA_SQL.pending, member) : [];
  return {ideas: ideas.map(i => ({...i, voted: voted.has(i.id)})), pending: mine};
}

async function postIdea(request, url, store, env, now) {
  const body = await requestJson(request, 4096);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_idea');
  const site = fromSite(body);
  // Honeypot (website form): a hidden field people never fill. Bots get the normal answer; nothing is saved or sent.
  if (body?.website) return {ok: true, id: `idea_${randomHex(8)}`, status: 'pending'};
  if (!validMember(body.member)) fail(400, 'member_required', site ? 'Reload the page and try again.' : 'Open the Nino app to share an idea.');
  const member = await memberHash(body.member);
  const text = clean(body.text, 280), name = clean(body.name, 30);
  if (text.length < 8) fail(400, 'idea_too_short', 'Tell Nino a little more about your idea.');
  if (/https?:\/\/|www\./i.test(text)) fail(400, 'no_links', 'Please leave links out of your idea.');
  const recent = await store.first(IDEA_SQL.recent, member, now - 86400);
  const tomorrow = 'That\'s three ideas today. Come back tomorrow with more!';
  if (Number(recent?.n || 0) >= MAX_IDEAS_PER_DAY) fail(429, 'idea_limit', tomorrow);
  const day = dayOf(now), ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip && !await withinLimit(store, `idea-ip:${await hash(`${day}:${ip}`)}`, MAX_IDEAS_PER_IP, day)) fail(429, 'idea_limit', tomorrow);
  if (!await withinLimit(store, 'ideas-daily', MAX_IDEAS_IN_ALL, day)) fail(429, 'ideas_full', 'Nino has a full stack of ideas to read today. Please come back tomorrow!');
  const id = `idea_${randomHex(8)}`;
  await store.run("INSERT INTO app_ideas(id,member_hash,name,text,status,votes,created_at,updated_at) VALUES(?,?,?,?, 'pending',0,?,?)", id, member, name || null, text, now, now);
  const key = await reviewKey(store);
  await ownerNote(env, site ? 'New design idea from ninobattaglia.com' : 'New design idea from the Nino app', [
    `<strong>${esc(name || 'A fan')}</strong> suggested${site ? ' on ninobattaglia.com' : ' in the Nino app'}:`,
    `<em>“${esc(text)}”</em>`,
    'It shows on the Ideas board (on ninobattaglia.com and in the app) only after you OK it.',
    `<a href="${reviewLink(url.origin, key, id, 'live')}">Show it on the Ideas board</a> &nbsp;·&nbsp; <a href="${reviewLink(url.origin, key, id, 'hidden')}">Don't show it</a>`]);
  return {ok: true, id, status: 'pending'};
}

async function vote(request, store, now) {
  const body = await requestJson(request, 2048);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_vote');
  if (!validMember(body.member)) fail(400, 'member_required', fromSite(body) ? 'Reload the page and try again.' : 'Open the Nino app to vote.');
  const member = await memberHash(body.member);
  const idea = await store.first("SELECT id FROM app_ideas WHERE id=? AND status='live'", String(body.id || ''));
  if (!idea) fail(404, 'idea_not_found', 'That idea isn\'t on the board any more.');
  const added = await store.run('INSERT OR IGNORE INTO app_idea_votes(idea_id,member_hash,created_at) VALUES(?,?,?)', idea.id, member, now);
  if (added?.meta?.changes) await store.run('UPDATE app_ideas SET votes=votes+1,updated_at=? WHERE id=?', now, idea.id);
  else {
    await store.run('DELETE FROM app_idea_votes WHERE idea_id=? AND member_hash=?', idea.id, member);
    await store.run('UPDATE app_ideas SET votes=MAX(votes-1,0),updated_at=? WHERE id=?', now, idea.id);
  }
  const row = await store.first('SELECT votes FROM app_ideas WHERE id=?', idea.id);
  return {ok: true, id: idea.id, voted: Boolean(added?.meta?.changes), votes: Number(row?.votes || 0)};
}

async function review(request, url, store, now) {
  const key = await setting(store, REVIEW_KEY);
  if (!(await sameKey(url.searchParams.get('k'), key))) return page('This link no longer works', '<p>Ask Claude for a new review link.</p>', 401);
  const id = String(url.searchParams.get('id') || ''), action = url.searchParams.get('do');
  const idea = await store.first('SELECT id,name,text,status FROM app_ideas WHERE id=?', id);
  if (!idea || !['live', 'hidden'].includes(action)) return page('Idea not found', '<p>It may have been removed.</p>', 404);
  // GET only shows the choice (email scanners open links); the button POSTs it.
  if (request.method === 'GET') return page(action === 'live' ? 'Show this idea?' : 'Hide this idea?',
    `<p><strong>${esc(idea.name || 'A fan')}</strong>: “${esc(idea.text)}”</p><p>Right now: ${esc(idea.status)}.</p><form method="post"><button style="font:inherit;font-weight:700;padding:14px 22px;border:0;border-radius:10px;background:#35e6eb;color:#06191b">${action === 'live' ? 'Show it on the Ideas board' : 'Keep it off the board'}</button></form>`);
  await store.run('UPDATE app_ideas SET status=?,updated_at=? WHERE id=?', action, now, id);
  return page(action === 'live' ? 'It\'s on the Ideas board' : 'Kept off the board', `<p>“${esc(idea.text)}”</p><p>You can close this page.</p>`);
}

// Returns a Response for the routes above, or null.
export async function fansRoute(request, url, store, env, now, headers) {
  const path = url.pathname;
  if (!['/api/app/card', '/api/ideas', '/api/ideas/vote', '/api/ideas/review', '/api/releases'].includes(path)) return null;
  const origin = request.headers.get('Origin') || '';
  const cors = NATIVE_ORIGINS.has(origin) || origin === env.STOREFRONT_ORIGIN ? {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'} : {};
  const json = (value, status = 200) => Response.json(value, {status, headers: {...headers, ...cors}});
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (path === '/api/ideas/review') return review(request, url, store, now);
  if (path === '/api/releases' && request.method === 'GET') return Response.json(await recentReleases(store, now), {headers: {...headers, 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*'}});
  try { return await fanApi(request, url, store, env, now, json); }
  catch (error) {
    // Errors carry the app's CORS header too, so the app can show the message.
    if (error instanceof HttpError) return json({error: error.code, message: error.message}, error.status);
    throw error;
  }
}
async function fanApi(request, url, store, env, now, json) {
  const path = url.pathname;
  if (path === '/api/app/card' && request.method === 'GET') {
    const key = url.searchParams.get('member');
    if (!validMember(key)) fail(400, 'member_required');
    return json(await memberCard(store, await memberHash(key)));
  }
  if (path === '/api/ideas' && request.method === 'GET') {
    const key = url.searchParams.get('member');
    return json(await listIdeas(store, validMember(key) ? await memberHash(key) : null));
  }
  if (path === '/api/ideas' && request.method === 'POST') return json(await postIdea(request, url, store, env, now));
  if (path === '/api/ideas/vote' && request.method === 'POST') return json(await vote(request, store, now));
  fail(405, 'method_not_allowed');
}
