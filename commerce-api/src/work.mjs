// Work page manager (owner request, Nov 7, 2026: "create the page so Nino can personally add and remove and just
// manage what is shown ... make it as user friendly as possible").
//
// The Work page (art.html) and the home page's "Selected work" still read catalog.json from GitHub. On top of that,
// site.js asks this worker for the owner's changes (GET /api/work/rotation) and applies them:
//   hidden = catalog.json pieces Nino switched off; added = pieces Nino uploaded himself (images in R2, served here).
// The state is one commerce_settings row ('work_rotation'), read at most about once a minute per Cloudflare location
// thanks to the edge cache, so visitors add almost no database reads.
//
// Nino manages it at ninobattaglia.com/work-manager.html#k=<private key>. No password or token to remember: the
// worker makes the key itself on its first scheduled run and emails the link to the owner inbox to forward to Nino.
// "Send a new private link" on the page replaces the key (the old link stops working) and emails the new one.
import {fail,hash,requestJson} from './common.mjs';

export const STATE_KEY = 'work_rotation';
export const LINK_KEY = 'work_manager_key';
export const ROTATION_EDGE_TTL = 60;
export const CATEGORIES = ['Branding', 'Illustration', 'Print & layout', 'Typography', 'Drawing', 'Motion', 'Apparel', 'Other'];
const MAX_ADDED = 500, MAX_HIDDEN = 2000, MAX_FULL = 12 * 1024 * 1024, MAX_THUMB = 3 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const IMG = /^\/api\/work\/img\/(work-[a-f0-9]{12}(?:-640)?)\.(webp|jpg|png)$/;
const TYPES = {webp:'image/webp', jpg:'image/jpeg', png:'image/png'};

const randomHex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function managerLink(env, key) {
  return `${env.STOREFRONT_ORIGIN || 'https://ninobattaglia.com'}/work-manager.html#k=${key}`;
}

export async function readState(store) {
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', STATE_KEY);
  return {raw: row?.value ?? null, state: parseState(row?.value)};
}
export function parseState(value) {
  try {
    const data = JSON.parse(value || '{}');
    return {hidden: Array.isArray(data.hidden) ? data.hidden.filter(id => typeof id === 'string') : [],
      added: Array.isArray(data.added) ? data.added.filter(item => item && item.id && item.title && item.image) : []};
  } catch { return {hidden: [], added: []}; }
}

// Read, change, write only if nobody else wrote in between (two quick taps never undo each other).
async function updateState(store, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const {raw, state} = await readState(store);
    const next = change(structuredClone(state));
    const value = JSON.stringify(next);
    const result = raw === null
      ? await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', STATE_KEY, value)
      : await store.run('UPDATE commerce_settings SET value=? WHERE key=? AND value=?', value, STATE_KEY, raw);
    if (result?.meta?.changes) return next;
  }
  fail(409, 'busy', 'Something else was saving at the same moment. Please try again.');
}

async function checkKey(request, store) {
  const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', LINK_KEY);
  if (!row?.value || !supplied) fail(401, 'link_not_valid', 'This private link no longer works. Ask JP for the newest link.');
  const a = await hash(supplied), b = await hash(row.value);
  let mismatch = a.length ^ b.length; for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (mismatch) fail(401, 'link_not_valid', 'This private link no longer works. Ask JP for the newest link.');
}

function sniff(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

async function addPiece(request, store, env, now) {
  if (!env.MOCKUPS_HD) fail(503, 'storage_not_configured', 'Picture storage is not set up yet.');
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_FULL + MAX_THUMB + 65536) fail(413, 'too_big', 'That picture is too big. Please pick a smaller one.');
  let form; try { form = await request.formData(); } catch { fail(400, 'bad_upload', 'The picture did not come through. Please try again.'); }
  const title = clean(form.get('title'), 80);
  if (!title) fail(400, 'title_missing', 'Please give the piece a name.');
  const category = CATEGORIES.includes(clean(form.get('category'), 40)) ? clean(form.get('category'), 40) : 'Other';
  const description = clean(form.get('description'), 300);
  const full = form.get('full'), thumb = form.get('thumb');
  if (!full || typeof full.arrayBuffer !== 'function' || !thumb || typeof thumb.arrayBuffer !== 'function') fail(400, 'picture_missing', 'Please pick a picture first.');
  const [fullBytes, thumbBytes] = [await full.arrayBuffer(), await thumb.arrayBuffer()];
  if (fullBytes.byteLength > MAX_FULL || thumbBytes.byteLength > MAX_THUMB) fail(413, 'too_big', 'That picture is too big. Please pick a smaller one.');
  const fullType = sniff(fullBytes), thumbType = sniff(thumbBytes);
  if (!fullType || !thumbType) fail(400, 'not_a_picture', 'That file is not a picture the site can show. Please pick a JPG or PNG photo.');
  const {state} = await readState(store);
  if (state.added.length >= MAX_ADDED) fail(400, 'too_many', 'The Work page is full. Delete some added pieces first.');
  const id = `work-${randomHex(6)}`;
  const base = env.COMMERCE_API_ORIGIN || '';
  const fullName = `${id}.${fullType}`, thumbName = `${id}-640.${thumbType}`;
  await env.MOCKUPS_HD.put(`work/${fullName}`, fullBytes, {httpMetadata: {contentType: TYPES[fullType]}});
  await env.MOCKUPS_HD.put(`work/${thumbName}`, thumbBytes, {httpMetadata: {contentType: TYPES[thumbType]}});
  const piece = {id, title, category, description, image: `${base}/api/work/img/${thumbName}`, gallery: [`${base}/api/work/img/${fullName}`], added_at: now};
  try {
    return await updateState(store, s => ({...s, added: [piece, ...s.added.filter(item => item.id !== id)]}));
  } catch (error) {
    await env.MOCKUPS_HD.delete([`work/${fullName}`, `work/${thumbName}`]).catch(() => {});
    throw error;
  }
}

async function deletePiece(body, store, env) {
  const id = clean(body.id, 80);
  if (!ID.test(id)) fail(400, 'bad_id');
  let removed = null;
  const next = await updateState(store, s => {
    removed = s.added.find(item => item.id === id) || null;
    return {hidden: s.hidden.filter(item => item !== id), added: s.added.filter(item => item.id !== id)};
  });
  if (!removed) fail(404, 'not_found', 'That piece was already deleted.');
  const files = [removed.image, ...(removed.gallery || [])].map(url => String(url).match(/\/api\/work\/img\/([^/]+)$/)?.[1]).filter(Boolean);
  if (env.MOCKUPS_HD && files.length) await env.MOCKUPS_HD.delete(files.map(name => `work/${name}`)).catch(() => {});
  return next;
}

async function setShown(body, store) {
  const id = clean(body.id, 80);
  if (!ID.test(id) || typeof body.shown !== 'boolean') fail(400, 'bad_request');
  return updateState(store, s => {
    const hidden = s.hidden.filter(item => item !== id);
    if (!body.shown) { if (hidden.length >= MAX_HIDDEN) fail(400, 'too_many'); hidden.push(id); }
    return {...s, hidden};
  });
}

export function linkMessage(env, link, {replaced = false} = {}) {
  const steps = [
    'Forward this email to Nino (or copy the link below and text it to him).',
    'Nino taps the link. His Work page manager opens: every piece on the Work page, each with a Hide it or Show it again button, and an Add a new picture button at the top.',
    'On an iPhone, he can tap the Share button at the bottom of Safari, then Add to Home Screen, then Add, so it opens like an app next time.'
  ];
  const intro = replaced ? 'A new private link was made for Nino’s Work page manager. The old link no longer works.' : 'Nino’s Work page manager is ready. With it, Nino can add his own pictures to the Work page on ninobattaglia.com, hide any piece, and bring it back later. Nothing to install, no password.';
  return {
    to: env.OWNER_EMAIL,
    subject: replaced ? 'Nino’s Work page manager: new private link' : 'Nino’s Work page manager: private link to forward to Nino',
    html: `<p>${intro}</p><p><a href="${link}" style="display:inline-block;padding:12px 20px;border:2px solid #ff6a1f;border-radius:8px;color:#200705;font-weight:700;text-decoration:none">Open the Work page manager</a></p><p style="word-break:break-all">${link}</p><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol><p>Keep the link private: anyone with it can change the Work page. If it gets out, open the manager, scroll to the bottom and tap Send a new private link.</p>`,
    text: `${intro}\n\n${link}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nKeep the link private: anyone with it can change the Work page. If it gets out, open the manager, scroll to the bottom and tap Send a new private link.`
  };
}

async function sendLink(store, env, {replaced}) {
  if (!env.MAILER || typeof env.MAILER.send !== 'function' || !env.OWNER_EMAIL) fail(503, 'mail_not_configured');
  const key = randomHex(24);
  await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', LINK_KEY, key);
  await env.MAILER.send(linkMessage(env, managerLink(env, key), {replaced}));
  return key;
}

// Scheduled: the first run after this ships makes the private link and emails it. Never throws.
export async function ensureManagerLink(store, env) {
  try {
    if (!env.MAILER || typeof env.MAILER.send !== 'function' || !env.OWNER_EMAIL) return 'no_mailer';
    const row = await store.first('SELECT value FROM commerce_settings WHERE key=?', LINK_KEY);
    if (row?.value) return 'exists';
    await sendLink(store, env, {replaced: false});
    return 'sent';
  } catch { return 'failed'; }
}

// Routes under /api/work/. Returns a Response, or null when the path is not one of these.
export async function workRoute(request, url, store, env, now, ctx, cors) {
  const path = url.pathname;
  if (!path.startsWith('/api/work/')) return null;
  const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors, ...headers}});
  const image = request.method === 'GET' && path.match(IMG);
  if (image) {
    const object = env.MOCKUPS_HD && await env.MOCKUPS_HD.get(`work/${image[1]}.${image[2]}`);
    if (!object) return new Response('Not found', {status: 404, headers: {'Access-Control-Allow-Origin': '*'}});
    return new Response(object.body ?? await object.arrayBuffer(), {headers: {'Content-Type': TYPES[image[2]], 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff'}});
  }
  if (request.method === 'GET' && path === '/api/work/rotation') {
    const cache = globalThis.caches?.default; const cached = cache && await cache.match(request);
    if (cached) return cached;
    const {state} = await readState(store);
    const response = Response.json(state, {headers: {'Cache-Control': `public, max-age=${ROTATION_EDGE_TTL}`, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff'}});
    if (cache) ctx?.waitUntil?.(cache.put(request, response.clone()));
    return response;
  }
  await checkKey(request, store);
  if (request.method === 'GET' && path === '/api/work/manage') return json({...(await readState(store)).state, categories: CATEGORIES});
  if (request.method === 'POST' && path === '/api/work/visibility') return json(await setShown(await requestJson(request), store));
  if (request.method === 'POST' && path === '/api/work/add') return json(await addPiece(request, store, env, now));
  if (request.method === 'POST' && path === '/api/work/delete') return json(await deletePiece(await requestJson(request), store, env));
  if (request.method === 'POST' && path === '/api/work/new-link') { await sendLink(store, env, {replaced: true}); return json({sent: true}); }
  return json({error: 'not_found'}, 404);
}
