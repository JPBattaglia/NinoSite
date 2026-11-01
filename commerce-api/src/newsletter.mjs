// Nino newsletter (owner decision, Oct 31, 2026: automated, examples approved, every issue approved by him).
//
// 1. Drafting. The daily run drafts a monthly issue on the 1st and a holiday drop from Nov 15 (once a year), or on
//    request (commerce_settings newsletter_draft_now = 'monthly' | 'holiday'). The shop picks 3 designs from the
//    owner's promotable list (commerce_settings news_designs / news_holiday_designs: original designs only),
//    preferring ones not featured lately, and reads their prices and the product range from the live catalog.
//    The words come from Menu-made's NinoWrite entrypoint (env.WRITER, AI step with its own token cap); if it is
//    unavailable a plain template is used. Nothing invented: designs, prices and the offer are passed in as facts.
// 2. Approval. The owner gets the full preview with three links: Approve and send / Ask for changes / Skip. Each
//    link opens a one-button page (a mail scanner opening links can't approve anything). Ask for changes takes his
//    note and drafts again with it. No answer in 7 days = expired, never sent.
// 3. Sending. Only 'sending' issues go out, to 'active' subscribers in address order (cursor), at most
//    NEWS_PER_RUN per 5-minute run and NEWS_DAILY_CAP a day (the free Resend plan is shared with Menu-made), each
//    with its own unsubscribe link and the RFC 8058 one-click header (set by NinoMail). It refuses to send without
//    the business mailing address (commerce_settings mailing_address), which anti-spam law requires in the footer.
// Buyers: a paid order shipping to the U.S. adds the buyer as a subscriber (CAN-SPAM allows it with an unsubscribe
// link; Canada and the EU need opt-in first, so other countries are not added). An unsubscribed address stays off.
import {unsubscribeLink} from './subscribers.mjs';

export const NEWS_PER_RUN = 20;
export const NEWS_DAILY_CAP = 80;
const EXPIRE_DAYS = 7;
const SHOP = 'https://ninobattaglia.com';
const LOGO = 'https://ninobattaglia.com/assets/email-nino-mark.png';
const DEFAULT_DESIGNS = '455597876,455604571,455689737,455757431,455691193,455581523,455411071,455813575,455727920,455722787';
const DEFAULT_HOLIDAY = '467251816,467441340,455602708,467255838,485862119';
const TYPES = [['Hoodie','hoodies'],['Crewneck sweatshirt','crewneck sweatshirts'],['Tote','totes'],['Sticker','stickers'],['Apron','aprons']];

const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const usd = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const hex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
const setting = async (store, key) => (await store.first('SELECT value FROM commerce_settings WHERE key=?', key))?.value ?? null;
const ptDate = now => new Date((now - 8 * 3600) * 1000); // close enough to Pacific for "which day is it"

export async function addBuyerToNewsletter(store, order, now) {
  try {
    const email = String(order?.customer_email || '').trim().toLowerCase();
    const recipient = order?.recipient_json ? JSON.parse(order.recipient_json) : null;
    if (!email || recipient?.country_code !== 'US') return 'skipped';
    const result = await store.run("INSERT INTO subscribers(email,status,token,source,created_at,confirmed_at) VALUES(?, 'active', ?, 'order', ?, ?) ON CONFLICT(email) DO NOTHING", email, hex(24), now, now);
    return result?.meta?.changes ? 'added' : 'exists';
  } catch { return 'failed'; }
}

// ---------- drafting ----------

async function storefrontDescriptions(fetcher) {
  try {
    const response = await fetcher(`${SHOP}/catalog.json`, {headers:{Accept:'application/json'}});
    if (!response.ok) return {};
    const data = await response.json();
    return Object.fromEntries((data.products || []).map(p => [String(p.id), String(p.description || '')]));
  } catch { return {}; }
}

export async function pickDesigns(store, kind, count = 3) {
  const list = (await setting(store, kind === 'holiday' ? 'news_holiday_designs' : 'news_designs')) || (kind === 'holiday' ? DEFAULT_HOLIDAY : DEFAULT_DESIGNS);
  const ids = list.split(',').map(s => s.trim()).filter(id => /^\d{1,20}$/.test(id));
  const generation = await store.activeGeneration();
  if (!generation || !ids.length) return [];
  const rows = await store.all(`SELECT p.id, p.title, p.image, MIN(v.price_cents) AS price FROM catalog_products p JOIN catalog_variants v ON v.generation=p.generation AND v.product_id=p.id WHERE p.generation=? AND p.id IN (${ids.map(() => '?').join(',')}) GROUP BY p.id`, generation, ...ids);
  const recent = await store.all("SELECT design_ids_json FROM newsletter_issues WHERE status IN ('sent','sending','awaiting') ORDER BY created_at DESC LIMIT 6");
  const featured = new Map();
  recent.forEach((row, index) => JSON.parse(row.design_ids_json || '[]').forEach(id => featured.set(id, Math.max(featured.get(id) || 0, 6 - index))));
  return rows.filter(r => /^https:\/\//.test(r.image || ''))
    .sort((a, b) => (featured.get(a.id) || 0) - (featured.get(b.id) || 0) || ids.indexOf(a.id) - ids.indexOf(b.id))
    .slice(0, count);
}

async function productRange(store, shirtPrice) {
  const generation = await store.activeGeneration();
  const parts = [shirtPrice ? `shirts from ${usd(shirtPrice)}` : 'shirts'];
  for (const [suffix, plural] of TYPES) {
    const row = await store.first('SELECT MIN(v.price_cents) AS price FROM catalog_variants v JOIN catalog_products p ON p.generation=v.generation AND p.id=v.product_id WHERE v.generation=? AND p.title LIKE ?', generation, `% ${suffix}`);
    if (row?.price) parts.push(`${plural} from ${usd(row.price)}`);
  }
  return parts.join(', ');
}

function fallbackCopy(kind) {
  return kind === 'holiday'
    ? {subject:'The Nino holiday drop is here', heading:'Holiday cheer with a dark side', intro:'Holiday designs drawn by Nino and printed when you order.', cta_label:'Shop the holiday drop'}
    : {subject:'New from Nino', heading:'Fresh from the studio', intro:'A few of Nino’s designs, printed when you order.', cta_label:'See every design'};
}

export async function draftIssue(store, env, now, kind, {ownerNote = null, fetcher = fetch} = {}) {
  const designs = await pickDesigns(store, kind);
  if (!designs.length) return {skipped:'no_designs'};
  const descriptions = await storefrontDescriptions(fetcher);
  const products = await productRange(store, Math.min(...designs.map(d => d.price)));
  const offer = (await setting(store, 'free_sticker')) === 'off' ? null : 'a free sticker of your design with every order on the site';
  const previousSubjects = (await store.all('SELECT subject FROM newsletter_issues ORDER BY created_at DESC LIMIT 6')).map(r => r.subject);
  let copy = null, writer = 'template';
  if (env.WRITER && typeof env.WRITER.draft === 'function') {
    try {
      copy = await env.WRITER.draft({kind, designs:designs.map(d => ({title:d.title.replace(/\s+T$/,''), description:descriptions[d.id] || ''})), products, offer, ownerNote, previousSubjects});
      writer = 'ai';
    } catch (error) { console.error('newsletter copy fell back to the template', error?.message || error); }
  }
  if (!copy?.subject || !copy?.heading || !copy?.intro) copy = fallbackCopy(kind);
  const id = `nl_${hex(8)}`;
  const content = {...copy, cta_label:copy.cta_label || fallbackCopy(kind).cta_label, products, offer, writer,
    designs:designs.map(d => ({id:d.id, title:d.title.replace(/\s+T$/,''), image:d.image, price:d.price}))};
  await store.run("INSERT INTO newsletter_issues(id,kind,status,subject,content_json,design_ids_json,token,owner_note,created_at) VALUES(?,?, 'awaiting', ?,?,?,?,?,?)",
    id, kind, copy.subject, JSON.stringify(content), JSON.stringify(designs.map(d => d.id)), hex(24), ownerNote, now);
  await sendApprovalEmail(store, env, id);
  return {drafted:id, writer};
}

// ---------- rendering ----------

export function renderIssue(content, {address, unsubscribe}) {
  const cards = content.designs.map(d => `<td width="33%" style="padding:0 6px;vertical-align:top;"><a href="${SHOP}/shop.html?product=${esc(d.id)}" style="text-decoration:none;color:#f2efe8;"><img src="${esc(d.image)}" width="170" alt="${esc(d.title)}" style="display:block;width:100%;height:auto;border-radius:8px;background:#f2efe8;border:0;"><div style="font-size:14px;margin-top:8px;">${esc(d.title)}</div><div style="font-size:12px;color:#c9bdb4;">Shirt from ${usd(d.price)}</div></a></td>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(content.subject)}</title></head>
<body style="margin:0;padding:0;background-color:#140403;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#140403;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#200705;border:1px solid #3a2a26;border-radius:10px;">
<tr><td style="padding:22px 28px;border-bottom:3px solid #ff6a1f;"><a href="${SHOP}" style="text-decoration:none;"><img src="${LOGO}" width="40" height="40" alt="" style="display:inline-block;vertical-align:middle;border:0;"> <span style="font-size:19px;font-weight:bold;letter-spacing:.05em;color:#f2efe8;vertical-align:middle;">NINO BATTAGLIA</span></a></td></tr>
<tr><td style="padding:26px 28px 6px;"><h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:#f2efe8;">${esc(content.heading)}</h1><p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#c9bdb4;">${esc(content.intro)}</p></td></tr>
<tr><td style="padding:12px 22px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>${cards}</tr></table></td></tr>
<tr><td style="padding:8px 28px 4px;font-size:14px;line-height:1.6;color:#c9bdb4;">Every design also comes as ${esc(content.products.replace(/^shirts[^,]*,\s*/,''))}.${content.offer ? ` Plus ${esc(content.offer)}.` : ''}</td></tr>
<tr><td style="padding:16px 28px 30px;"><a href="${SHOP}/shop.html" style="display:inline-block;padding:13px 22px;border:2px solid #ff6a1f;border-radius:10px;color:#f2efe8;font-size:15px;font-weight:bold;text-decoration:none;">${esc(content.cta_label)}</a></td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #3a2a26;font-size:12px;line-height:1.6;color:#8c9995;">You’re getting this because you signed up or ordered at ninobattaglia.com. <a href="${esc(unsubscribe)}" style="color:#c9bdb4;">Unsubscribe</a><br>Nino Battaglia · ${esc(address || '[business mailing address needed]')}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [content.heading, '', content.intro, '', ...content.designs.map(d => `${d.title}: shirt from ${usd(d.price)} ${SHOP}/shop.html?product=${d.id}`), '',
    `Every design also comes as ${content.products.replace(/^shirts[^,]*,\s*/,'')}.${content.offer ? ` Plus ${content.offer}.` : ''}`, '',
    `${content.cta_label}: ${SHOP}/shop.html`, '', `Unsubscribe: ${unsubscribe}`, `Nino Battaglia · ${address || '[business mailing address needed]'}`].join('\n');
  return {html, text};
}

const ownerLink = (env, issue, action) => `${env.COMMERCE_API_ORIGIN}/api/newsletter/${issue.id}/${action}?t=${issue.token}`;
const activeCount = async store => (await store.first("SELECT COUNT(*) AS n FROM subscribers WHERE status='active'"))?.n || 0;

async function sendApprovalEmail(store, env, id) {
  const issue = await store.first('SELECT * FROM newsletter_issues WHERE id=?', id);
  if (!env.MAILER || !env.OWNER_EMAIL || !issue) return 'no_mailer';
  const content = JSON.parse(issue.content_json);
  const address = await setting(store, 'mailing_address');
  const count = await activeCount(store);
  const preview = renderIssue(content, {address, unsubscribe:'#'});
  const button = (href, label, solid) => `<a href="${href}" style="display:inline-block;margin:4px 8px 4px 0;padding:13px 20px;border:2px solid #ff6a1f;border-radius:10px;${solid ? 'background:#ff6a1f;color:#140403;' : 'color:#f2efe8;'}font-size:15px;font-weight:bold;text-decoration:none;">${label}</a>`;
  const head = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#140403;"><tr><td align="center" style="padding:28px 12px 0;"><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#200705;border:1px solid #3a2a26;border-radius:10px;"><tr><td style="padding:24px 28px;font-family:Arial,Helvetica,sans-serif;">
<h1 style="margin:0 0 12px;font-size:24px;color:#f2efe8;">Newsletter ready for your OK</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#c9bdb4;">It goes to <b style="color:#f2efe8;">${count} subscriber${count === 1 ? '' : 's'}</b> only if you approve it. No answer in ${EXPIRE_DAYS} days and it isn’t sent.</p>
<p style="margin:0 0 14px;padding:12px 14px;background:#1a1311;border:1px solid #3a2a26;border-radius:8px;font-size:14px;line-height:1.6;color:#e2d9d2;"><b>Subject:</b> ${esc(content.subject)}<br><b>Designs:</b> ${esc(content.designs.map(d => d.title).join(', '))}${content.offer ? `<br><b>Offer mentioned:</b> ${esc(content.offer)}` : ''}${issue.owner_note ? `<br><b>Your changes:</b> ${esc(issue.owner_note)}` : ''}</p>
${address ? '' : '<p style="margin:0 0 14px;padding:12px 14px;border:2px solid #ff6a1f;border-radius:8px;font-size:14px;line-height:1.6;color:#f2efe8;"><b>Can’t send yet:</b> anti-spam law requires a business mailing address in the footer. Tell Claude the address and this issue can go out.</p>'}
${button(ownerLink(env, issue, 'approve'), 'Approve and send', true)}${button(ownerLink(env, issue, 'changes'), 'Ask for changes')}${button(ownerLink(env, issue, 'skip'), 'Skip this one')}
<p style="margin:14px 0 0;font-size:13px;color:#99a5a1;">The email below is exactly what subscribers will see.</p></td></tr></table></td></tr></table>`;
  await env.MAILER.send({to:env.OWNER_EMAIL, subject:`Newsletter ready for your OK: "${content.subject}"`.slice(0,190),
    html:preview.html.replace(/<body([^>]*)>/, `<body$1>${head}`),
    text:`Newsletter ready for your OK (goes to ${count} subscribers only if you approve).\n\nApprove and send: ${ownerLink(env, issue, 'approve')}\nAsk for changes: ${ownerLink(env, issue, 'changes')}\nSkip this one: ${ownerLink(env, issue, 'skip')}\n\n${preview.text}`});
  return 'sent';
}

// ---------- owner pages ----------

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#140403;color:#f2efe8;font:16px/1.6 Arial,Helvetica,sans-serif;"><main style="max-width:480px;padding:32px;">${body}</main></body></html>`,
  {status, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'}});
const BTN = 'margin-top:12px;padding:14px 24px;background:transparent;color:#f2efe8;border:2px solid #ff6a1f;border-radius:10px;font:bold 15px Arial,Helvetica,sans-serif;cursor:pointer;';
const P = text => `<p style="color:#c9bdb4;">${text}</p>`;

export async function newsletterAction(request, url, store, env, now, ctx) {
  const match = url.pathname.match(/^\/api\/newsletter\/(nl_[a-f0-9]{16})\/(approve|changes|skip)$/);
  const issue = match && await store.first('SELECT * FROM newsletter_issues WHERE id=?', match[1]);
  const token = url.searchParams.get('t') || '';
  if (!issue || !/^[a-f0-9]{48}$/.test(token) || token !== issue.token) return page('Link not valid', `<h1>This link isn’t valid</h1>${P('Use the buttons in the newest newsletter email.')}`, 404);
  const action = match[2];
  const content = JSON.parse(issue.content_json);
  if (issue.status !== 'awaiting') {
    const said = {sending:'is being sent now', sent:`was sent to ${issue.sent_count} subscribers`, skipped:'was skipped', replaced:'was replaced by a new draft (check your newest email)', expired:'expired without being sent'}[issue.status] || issue.status;
    return page('Newsletter', `<h1>${esc(content.subject)}</h1>${P(`This issue ${said}. Nothing else to do.`)}`);
  }
  const address = await setting(store, 'mailing_address');
  if (request.method === 'GET') {
    const form = (inner, label) => `<form method="post">${inner}<button type="submit" style="${BTN}">${label}</button></form>`;
    if (action === 'approve') {
      if (!address) return page('Mailing address needed', `<h1>One thing first</h1>${P('Anti-spam law requires a business mailing address at the bottom of every newsletter. Tell Claude the address (a P.O. box or virtual mailbox works), then tap Approve in the email again.')}`);
      const count = await activeCount(store);
      return page('Approve newsletter', `<h1>Send “${esc(content.subject)}”?</h1>${P(`It goes to ${count} subscriber${count === 1 ? '' : 's'}, in batches over the next few hours.`)}${form('', 'Approve and send')}`);
    }
    if (action === 'skip') return page('Skip newsletter', `<h1>Skip “${esc(content.subject)}”?</h1>${P('It won’t be sent. The next issue is drafted on schedule.')}${form('', 'Skip this one')}`);
    return page('Ask for changes', `<h1>What should change?</h1>${P('Write it the way you’d tell a person, for example “use Grumpy Frog instead of Skull Wave” or “make the subject funnier”. A new draft comes to your email in a minute or two.')}${form('<textarea name="note" required maxlength="1000" rows="6" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #ffffff40;background:#1a1311;color:#f2efe8;font:15px Arial,Helvetica,sans-serif;"></textarea>', 'Send my changes')}`);
  }
  if (action === 'approve') {
    if (!address) return page('Mailing address needed', `<h1>Not sent</h1>${P('A business mailing address is needed first. Tell Claude the address, then tap Approve again.')}`, 409);
    await store.run("UPDATE newsletter_issues SET status='sending',approved_at=? WHERE id=? AND status='awaiting'", now, issue.id);
    return page('Approved', `<h1>Approved</h1>${P('It’s going out now in batches. You’ll get an email when every subscriber has it.')}`);
  }
  if (action === 'skip') {
    await store.run("UPDATE newsletter_issues SET status='skipped' WHERE id=? AND status='awaiting'", issue.id);
    return page('Skipped', `<h1>Skipped</h1>${P('This issue won’t be sent.')}`);
  }
  const form = await request.formData().catch(() => null);
  const note = String(form?.get('note') || '').trim().slice(0, 1000);
  if (!note) return page('Ask for changes', `<h1>Nothing written</h1>${P('Go back and write what should change.')}`, 400);
  await store.run("UPDATE newsletter_issues SET status='replaced',owner_note=? WHERE id=? AND status='awaiting'", note, issue.id);
  const redraft = draftIssue(store, env, now, issue.kind, {ownerNote:note}).catch(error => console.error('newsletter redraft failed', error?.message || error));
  if (ctx?.waitUntil) ctx.waitUntil(redraft); else await redraft;
  return page('Changes sent', `<h1>Got it</h1>${P('A new draft with your changes will be in your email in a minute or two.')}`);
}

// ---------- schedule and sending ----------

async function dueKind(store, now) {
  const day = ptDate(now); const y = day.getUTCFullYear(); const m = day.getUTCMonth(); const d = day.getUTCDate();
  const since = Date.UTC(y, m, 1) / 1000 + 8 * 3600;
  if ((m === 10 && d >= 15) || (m === 11 && d <= 10)) {
    const yearStart = Date.UTC(y, 0, 1) / 1000;
    if (!await store.first("SELECT 1 AS x FROM newsletter_issues WHERE kind='holiday' AND created_at>=?", yearStart)) return 'holiday';
  }
  if (d === 1 && !await store.first("SELECT 1 AS x FROM newsletter_issues WHERE created_at>=?", since)) return 'monthly';
  return null;
}

async function sendBatch(store, env, now) {
  const issue = await store.first("SELECT * FROM newsletter_issues WHERE status='sending' ORDER BY approved_at LIMIT 1");
  if (!issue) return {idle:true};
  const address = await setting(store, 'mailing_address');
  if (!address || !env.MAILER) return {blocked:address ? 'no_mailer' : 'no_address'};
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const usedRow = await store.first("SELECT n FROM signup_limits WHERE k='news' AND day=?", day);
  const room = Math.min(NEWS_PER_RUN, NEWS_DAILY_CAP - (usedRow?.n || 0));
  if (room <= 0) return {waiting:'daily_cap'};
  const content = JSON.parse(issue.content_json);
  const recipients = await store.all("SELECT email,token FROM subscribers WHERE status='active' AND email>? ORDER BY email LIMIT ?", issue.cursor || '', room);
  let sent = 0;
  for (const r of recipients) {
    const unsubscribe = unsubscribeLink(env, r.token);
    const body = renderIssue(content, {address, unsubscribe});
    try { await env.MAILER.send({to:r.email, subject:content.subject, html:body.html, text:body.text, kind:'news', unsubscribe}); sent++; }
    catch (error) { await store.run('UPDATE newsletter_issues SET last_error=? WHERE id=?', String(error?.message || error).slice(0, 200), issue.id); break; }
    await store.run('UPDATE newsletter_issues SET cursor=?,sent_count=sent_count+1 WHERE id=?', r.email, issue.id);
  }
  if (sent) await store.run("INSERT INTO signup_limits(k,day,n) VALUES('news',?,?) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN day=excluded.day THEN n+excluded.n ELSE excluded.n END, day=excluded.day", day, sent);
  if (recipients.length < room && sent === recipients.length) {
    const done = await store.first('SELECT sent_count FROM newsletter_issues WHERE id=?', issue.id);
    await store.run("UPDATE newsletter_issues SET status='sent',sent_at=? WHERE id=?", now, issue.id);
    if (env.OWNER_EMAIL) await env.MAILER.send({to:env.OWNER_EMAIL, subject:`Newsletter sent: "${content.subject}"`.slice(0,190),
      html:`<p>“${esc(content.subject)}” went to ${done.sent_count} subscriber${done.sent_count === 1 ? '' : 's'}.</p>`, text:`"${content.subject}" went to ${done.sent_count} subscribers.`}).catch(() => {});
    return {finished:done.sent_count};
  }
  return {sent};
}

// Called from every scheduled run. Never throws.
export async function runNewsletter(store, env, now, {daily = false} = {}) {
  const result = {};
  try {
    const requested = await setting(store, 'newsletter_draft_now');
    if (requested) await store.run("DELETE FROM commerce_settings WHERE key='newsletter_draft_now'");
    if (daily) await store.run("UPDATE newsletter_issues SET status='expired' WHERE status='awaiting' AND created_at<?", now - EXPIRE_DAYS * 86400);
    const open = await store.first("SELECT 1 AS x FROM newsletter_issues WHERE status IN ('awaiting','sending')");
    const kind = ['monthly','holiday'].includes(requested) ? requested : (daily && !open ? await dueKind(store, now) : null);
    if (kind && (requested || await activeCount(store) > 0)) result.draft = await draftIssue(store, env, now, kind);
    result.send = await sendBatch(store, env, now);
  } catch (error) { result.error = String(error?.message || error).slice(0, 200); console.error('newsletter run failed', result.error); }
  return result;
}

export async function newsletterStatus(store) {
  return {subscribers:Object.fromEntries((await store.all('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status')).map(r => [r.status, r.n])),
    issues:await store.all('SELECT id,kind,status,subject,created_at,approved_at,sent_at,sent_count,last_error FROM newsletter_issues ORDER BY created_at DESC LIMIT 10')};
}
