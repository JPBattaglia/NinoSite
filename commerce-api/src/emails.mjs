import {addBuyerToNewsletter} from './newsletter.mjs';
// Order emails for the shirt shop: a Nino-branded confirmation to the buyer and a sale alert to the owner.
//
// Sending goes through Menu-made's mailer (Resend) over a Cloudflare service binding (env.MAILER, the
// menu-checkout worker's NinoMail entrypoint), so the shop needs no email key of its own. Mail is sent as
// "Nino Battaglia" <orders@updates.menu-made.com> with replies to hello@ninobattaglia.com (set by the mailer).
//
// Each email is sent once per order: commerce_settings keys order_email:<order>:<kind> record the send.
// A failed send never blocks fulfilment; it is retried on the order's next pass and the daily self-check.

const LOGO = 'https://ninobattaglia.com/assets/email-nino-mark.png';
const SHOP = 'https://ninobattaglia.com';
const SUPPORT = 'https://ninobattaglia.com/support.html';

const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const usd = c => `$${(Number(c || 0) / 100).toFixed(2)}`;

// "Flat Rate (Estimated delivery: Nov 3⁠–5) " → "Nov 3–5". Printful puts the estimate in the rate name.
export function deliveryEstimate(shippingName) {
  const match = String(shippingName || '').replace(/⁠/g,'').match(/Estimated delivery:\s*([^)]+)\)?/i);
  return match ? match[1].trim() : null;
}

function addressLines(r) {
  if (!r) return [];
  return [r.name, [r.address1, r.address2].filter(Boolean).join(', '), [r.city, [r.state_code, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), r.country_code && r.country_code !== 'US' ? r.country_code : null].filter(Boolean);
}

export function orderSummary(order) {
  const snapshot = JSON.parse(order.snapshot_json || '{}');
  const recipient = order.recipient_json ? JSON.parse(order.recipient_json) : snapshot.shipping?.recipient;
  const items = (snapshot.lines || []).map(line => ({
    title: String(line.title || 'Shirt').replace(/\s+T$/,''),
    options: [line.variant?.color, line.variant?.size].filter(Boolean).join(' / '),
    quantity: line.quantity, total: line.line_total_cents,
    image: [line.image, line.variant?.image].find(url => /^https:\/\/[^/]+\/.+/.test(String(url || ''))) || null
  }));
  return {
    id: order.id, reference: order.id.replace(/^ord_/,'').slice(0,8).toUpperCase(),
    items, subtotal: snapshot.subtotal_cents, shipping: order.paid_shipping_cents ?? snapshot.shipping?.amount,
    tax: order.paid_tax_cents || 0, total: order.paid_total_cents,
    estimate: deliveryEstimate(snapshot.shipping?.name), recipient, email: order.customer_email,
    printfulId: order.printful_order_id || null
  };
}

function layout({preheader, heading, intro, summary, footer}) {
  const s = summary;
  const itemRows = s.items.map(item => `<tr>
<td style="padding:14px 0;border-bottom:1px solid #3a2a26;width:72px;vertical-align:top;">${item.image ? `<img src="${esc(item.image)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:6px;background:#f2efe8;border:0;">` : ''}</td>
<td style="padding:14px 12px;border-bottom:1px solid #3a2a26;vertical-align:top;font-size:15px;color:#f2efe8;"><strong>${esc(item.title)}</strong><br><span style="font-size:13px;color:#c9bdb4;">${esc(item.options)}${item.quantity > 1 ? ` &times; ${item.quantity}` : ''}</span></td>
<td style="padding:14px 0;border-bottom:1px solid #3a2a26;vertical-align:top;text-align:right;font-size:15px;color:#f2efe8;white-space:nowrap;">${usd(item.total)}</td></tr>`).join('');
  const money = (label, value, strong) => `<tr><td style="padding:4px 0;font-size:${strong ? 16 : 14}px;color:${strong ? '#f2efe8' : '#c9bdb4'};${strong ? 'font-weight:bold;' : ''}">${label}</td><td style="padding:4px 0;text-align:right;font-size:${strong ? 16 : 14}px;color:${strong ? '#f2efe8' : '#c9bdb4'};${strong ? 'font-weight:bold;' : ''}">${value}</td></tr>`;
  const address = addressLines(s.recipient).map(esc).join('<br>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background-color:#140403;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;color:#140403;max-height:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#140403;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#200705;border:1px solid #3a2a26;border-radius:10px;">
<tr><td style="padding:26px 32px;border-bottom:3px solid #ff6a1f;">
<a href="${SHOP}" style="text-decoration:none;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${LOGO}" width="56" height="55" alt="" style="display:block;width:56px;height:55px;border:0;"></td>
<td style="vertical-align:middle;padding-left:14px;"><div style="font-family:'Arial Narrow',Arial,sans-serif;font-size:30px;font-weight:bold;line-height:1;letter-spacing:-0.5px;color:#f2efe8;">NINO</div><div style="font-size:10px;font-weight:bold;letter-spacing:3px;color:#f2efe8;margin-top:4px;">BATTAGLIA</div></td>
</tr></table></a></td></tr>
<tr><td style="padding:30px 32px 8px;">
<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;color:#f2efe8;">${esc(heading)}</h1>
${intro.map(p => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#e3d9d1;">${p}</p>`).join('')}
${s.estimate ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 22px;background-color:#2e0d09;border:1px solid #ff6a1f;border-radius:8px;"><tr><td style="padding:16px 18px;"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#ff8a4c;">ESTIMATED DELIVERY</div><div style="font-size:22px;font-weight:bold;color:#f2efe8;margin-top:4px;">${esc(s.estimate)}</div></td></tr></table>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${itemRows}</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0 22px;">
${money('Subtotal', usd(s.subtotal))}${money('Shipping', usd(s.shipping))}${money('Tax', usd(s.tax))}${money('Total paid', usd(s.total), true)}</table>
${address ? `<div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#ff8a4c;margin:0 0 6px;">SHIPPING TO</div><p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#e3d9d1;">${address}</p>` : ''}
${footer}
</td></tr>
<tr><td style="padding:18px 32px 26px;border-top:1px solid #3a2a26;font-size:12px;line-height:1.6;color:#a8988f;">Order ${esc(s.reference)} &middot; <a href="${SHOP}" style="color:#35e6eb;text-decoration:none;">ninobattaglia.com</a> &middot; <a href="${SUPPORT}" style="color:#35e6eb;text-decoration:none;">Sizing, delivery &amp; order help</a></td></tr>
</table></td></tr></table></body></html>`;
}

function plain(summary, lead) {
  const s = summary;
  return [lead, '',
    ...s.items.map(item => `${item.title} — ${item.options}${item.quantity > 1 ? ` x${item.quantity}` : ''} — ${usd(item.total)}`), '',
    `Subtotal ${usd(s.subtotal)} · Shipping ${usd(s.shipping)} · Tax ${usd(s.tax)} · Total paid ${usd(s.total)}`,
    s.estimate ? `Estimated delivery: ${s.estimate}` : '',
    addressLines(s.recipient).length ? `Shipping to: ${addressLines(s.recipient).join(', ')}` : '',
    '', `Order ${s.reference} · ${SHOP}`].filter(line => line !== null).join('\n');
}

export function buyerEmail(order) {
  const s = orderSummary(order);
  const first = String(s.recipient?.name || '').trim().split(/\s+/)[0];
  return {
    to: s.email,
    subject: `Your Nino Battaglia order is confirmed${s.estimate ? ` — arriving ${s.estimate}` : ''}`,
    html: layout({
      preheader: `Thanks for your order${s.estimate ? `. Estimated delivery ${s.estimate}` : ''}.`,
      heading: `Thank you${first ? `, ${first}` : ''}!`,
      intro: ['Your order is confirmed and your shirt is being printed. You’ll get another email with tracking as soon as it ships.', 'A free Nino sticker comes in the box with your order.'],
      summary: s,
      footer: `<p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:#c9bdb4;">Questions about your order? Just reply to this email.</p>${s.recipient?.country_code === 'US' ? '<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#a8988f;">You’ll also get occasional Nino news by email. Every one has an unsubscribe link.</p>' : ''}`
    }),
    text: plain(s, 'Thank you! Your Nino Battaglia order is confirmed and your shirt is being printed. You’ll get tracking when it ships.')
  };
}

export function ownerEmail(order, to, {attention = null} = {}) {
  const s = orderSummary(order);
  const what = s.items.map(item => item.title).join(', ');
  return {
    to,
    subject: attention ? `Shirt sale needs attention — ${usd(s.total)} (${what})` : `New shirt sale — ${usd(s.total)} (${what})`,
    html: layout({
      preheader: `${usd(s.total)} from ${s.email || 'a buyer'}.`,
      heading: attention ? 'A sale needs your attention' : 'You made a sale!',
      intro: [
        `${esc(s.recipient?.name || 'A buyer')} (${esc(s.email || 'no email')}) paid <strong>${usd(s.total)}</strong>.`,
        attention ? `It was <strong>not</strong> sent to Printful automatically: ${esc(attention)}. Check it in the shop admin before the buyer is left waiting.` : `It was sent to Printful automatically${s.printfulId ? ` as order <strong>${esc(s.printfulId)}</strong>` : ''}. The buyer got a confirmation email.`
      ],
      summary: s,
      footer: ''
    }),
    text: plain(s, attention ? `A sale needs attention (${attention}): ${usd(s.total)} from ${s.email}.` : `New shirt sale: ${usd(s.total)} from ${s.email}${s.printfulId ? `, Printful order ${s.printfulId}` : ''}.`)
  };
}

async function sendOnce(store, env, order, kind, message, now) {
  if (!message?.to) return 'no_recipient';
  const key = `order_email:${order.id}:${kind}`;
  if (await store.first('SELECT 1 AS sent FROM commerce_settings WHERE key=?', key)) return 'already_sent';
  await env.MAILER.send(message);
  await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', key, String(now));
  return 'sent';
}

// Called after an order is confirmed at Printful, or sent to review. Never throws.
export async function sendOrderEmails(store, env, orderId, now) {
  if (!env.MAILER || typeof env.MAILER.send !== 'function') return {skipped:'no_mailer'};
  const result = {};
  try {
    const order = await store.order(orderId);
    if (!order || order.payment_status !== 'paid') return {skipped:'not_paid'};
    const owner = env.OWNER_EMAIL;
    if (order.fulfillment_status === 'confirmed') {
      result.buyer = await sendOnce(store, env, order, 'buyer', buyerEmail(order), now);
      result.newsletter = await addBuyerToNewsletter(store, order, now);
      if (owner) result.owner = await sendOnce(store, env, order, 'owner', ownerEmail(order, owner), now);
    } else if (order.fulfillment_status === 'review' && owner) {
      result.owner = await sendOnce(store, env, order, 'owner_review', ownerEmail(order, owner, {attention:order.last_error || 'needs review'}), now);
    }
  } catch (error) {
    result.error = String(error?.message || error).slice(0,200);
    console.error(`order email for ${orderId} failed: ${result.error}`);
  }
  return result;
}

// Abandoned checkout (Nov 4, 2026): one reminder when a live shop checkout expires unpaid and the buyer had typed an
// email into Stripe. The link is Stripe's recovery URL, which opens a fresh checkout for the same order.
const POSTAL = 'Menu-Made, 706 Kearny St, San Francisco, CA 94108';
export function recoveryEmail(order, to, url) {
  const s = orderSummary(order);
  const rows = s.items.map(item => `<tr>
<td style="padding:14px 0;border-bottom:1px solid #3a2a26;width:72px;vertical-align:top;">${item.image ? `<img src="${esc(item.image)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:6px;background:#f2efe8;border:0;">` : ''}</td>
<td style="padding:14px 12px;border-bottom:1px solid #3a2a26;vertical-align:top;font-size:15px;color:#f2efe8;"><strong>${esc(item.title)}</strong><br><span style="font-size:13px;color:#c9bdb4;">${esc(item.options)}${item.quantity > 1 ? ` &times; ${item.quantity}` : ''}</span></td>
<td style="padding:14px 0;border-bottom:1px solid #3a2a26;vertical-align:top;text-align:right;font-size:15px;color:#f2efe8;white-space:nowrap;">${usd(item.total)}</td></tr>`).join('');
  const heading = 'Your Nino order is still waiting';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${heading}</title></head>
<body style="margin:0;padding:0;background-color:#140403;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;color:#140403;max-height:0;overflow:hidden;">You started a checkout on ninobattaglia.com. Your order is saved if you still want it.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#140403;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#200705;border:1px solid #3a2a26;border-radius:10px;">
<tr><td style="padding:26px 32px;border-bottom:3px solid #ff6a1f;">
<a href="${SHOP}" style="text-decoration:none;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${LOGO}" width="56" height="55" alt="" style="display:block;width:56px;height:55px;border:0;"></td>
<td style="vertical-align:middle;padding-left:14px;"><div style="font-family:'Arial Narrow',Arial,sans-serif;font-size:30px;font-weight:bold;line-height:1;letter-spacing:-0.5px;color:#f2efe8;">NINO</div><div style="font-size:10px;font-weight:bold;letter-spacing:3px;color:#f2efe8;margin-top:4px;">BATTAGLIA</div></td>
</tr></table></a></td></tr>
<tr><td style="padding:30px 32px 8px;">
<h1 style="margin:0 0 14px;font-size:26px;line-height:1.25;color:#f2efe8;">${heading}</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#e3d9d1;">You started a checkout on ninobattaglia.com but didn’t finish it. If you still want it, the link below opens a secure Stripe checkout for the same order.</p>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#e3d9d1;">A free 3-inch sticker of the design comes with every order.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 22px;"><tr><td style="border:1px solid #ff6a1f;border-radius:10px;"><a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:bold;color:#ff8a4c;text-decoration:none;">Finish my order</a></td></tr></table>
<p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:#c9bdb4;">Shipping and any tax for your address are shown at checkout before you pay. Questions? Just reply to this email.</p>
</td></tr>
<tr><td style="padding:18px 32px 26px;border-top:1px solid #3a2a26;font-size:12px;line-height:1.6;color:#a8988f;">This is a one-time reminder; we won’t email you about this checkout again.<br>${POSTAL}<br><a href="${SHOP}" style="color:#ff8a4c;text-decoration:none;">ninobattaglia.com</a> &middot; <a href="${SUPPORT}" style="color:#ff8a4c;text-decoration:none;">Sizing, delivery &amp; order help</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `${heading}.`, '',
    'You started a checkout on ninobattaglia.com but didn’t finish it. If you still want it, this link opens a secure Stripe checkout for the same order:', url, '',
    ...s.items.map(item => `${item.title} — ${item.options}${item.quantity > 1 ? ` x${item.quantity}` : ''} — ${usd(item.total)}`), '',
    'A free 3-inch sticker of the design comes with every order. Shipping and any tax for your address are shown at checkout before you pay.', '',
    'This is a one-time reminder; we won’t email you about this checkout again.', POSTAL, SHOP
  ].join('\n');
  return {to, subject: heading, html, text};
}

// checkout.session.expired → at most one reminder per order. The claim row is written before sending, so two
// deliveries of the event (or two expired sessions for one order) can never both send; a failed send releases it
// and throws, so Stripe redelivers the event and the reminder is tried again.
export async function sendRecoveryEmail(store, env, session, now) {
  if (!env.MAILER || typeof env.MAILER.send !== 'function') return 'no_mailer';
  if (!session || session.livemode !== true || env.STRIPE_MODE !== 'live') return 'not_live';
  const order = await store.orderBySession(session.id);
  if (!order || order.live_mode !== 1) return 'not_a_shop_order';
  if (order.payment_status === 'paid') return 'already_paid';
  const to = String(session.customer_details?.email || session.customer_email || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to) || to.length > 254) return 'no_email';
  let url;
  try { url = new URL(String(session.after_expiration?.recovery?.url || '')); } catch { return 'no_recovery_link'; }
  if (url.protocol !== 'https:' || !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) return 'no_recovery_link';
  // Bought since (a new checkout, or a recovered one already paid): no reminder.
  if (await store.first("SELECT 1 AS paid FROM commerce_orders WHERE live_mode=1 AND payment_status='paid' AND lower(customer_email)=lower(?) AND created_at>=?", to, order.created_at)) return 'bought_since';
  const key = `order_email:${order.id}:recovery`;
  const claim = await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', key, String(now));
  if (!claim.meta.changes) return 'already_sent';
  try { await env.MAILER.send(recoveryEmail(order, to, url.href)); }
  catch (error) { await store.run('DELETE FROM commerce_settings WHERE key=? AND value=?', key, String(now)); throw error; }
  return 'sent';
}
