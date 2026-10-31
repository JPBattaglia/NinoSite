// Daily shirt-shop self-check: proves the live setup can take a payment and fulfil it, without an order.
//
// Checks, each recorded with a plain-language detail:
//   1. The Stripe key belongs to the Ninobattaglia.com account (STRIPE_ACCOUNT_ID), in the configured mode.
//   2. That account has an enabled webhook to this worker's /api/webhooks/stripe for checkout.session.completed.
//   3. Every checkout.session.completed from the last 3 days (older than 30 minutes) reached this worker and was
//      processed. A wrong STRIPE_WEBHOOK_SECRET shows up here, since Stripe's deliveries are rejected.
//   4. No paid order has waited more than 2 hours without being sent to Printful.
//   5. The Printful token can create an order in the website store: a draft is created and deleted at once.
//      Drafts are never confirmed, so nothing is charged or printed.
//
// Runs from the daily cron, or on the next 5-minute run after commerce_settings 'selfcheck_run_now' is set.
// The result is stored in commerce_settings 'selfcheck_last'; /api/health shows pass/fail and the names of
// failed checks, and the daily GitHub smoke test fails (and emails the owner) when the check failed or is stale.
import {placedItems} from './fulfillment.mjs';
import {typeOf} from './expand.mjs';

export const SELFCHECK_KEY = 'selfcheck_last';
export const SELFCHECK_RUN_NOW = 'selfcheck_run_now';
const WEBHOOK_PATH = '/api/webhooks/stripe';
// A public landmark address: Printful validates draft recipients, and the draft is deleted straight away.
const DRAFT_RECIPIENT = {name:'Shop self-check', address1:'1 Ferry Building', city:'San Francisco', state_code:'CA', country_code:'US', zip:'94111'};

export async function runSelfCheck(store, stripe, printful, env, now) {
  const checks = [];
  const check = async (name, work) => {
    try { checks.push({name, ok:true, detail:String(await work() || 'ok').slice(0,300)}); }
    catch (error) { checks.push({name, ok:false, detail:String(error?.message || error?.code || error).slice(0,300)}); }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  await check('Stripe key is for the Nino account', async () => {
    expect(/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_ACCOUNT_ID || ''), 'STRIPE_ACCOUNT_ID is not set in wrangler.jsonc');
    const account = await stripe.retrieveAccount();
    expect(account?.id === env.STRIPE_ACCOUNT_ID, `the key belongs to ${account?.id || 'an unknown account'}${account?.settings?.dashboard?.display_name ? ` (${account.settings.dashboard.display_name})` : ''}, not ${env.STRIPE_ACCOUNT_ID}`);
    expect(String(env.STRIPE_SECRET_KEY || '').includes(`_${env.STRIPE_MODE}_`), `the key is not a ${env.STRIPE_MODE} key`);
    return `${account.id}, ${env.STRIPE_MODE} mode`;
  });

  await check('Stripe sends paid checkouts to this shop', async () => {
    expect(/^https:\/\//.test(env.COMMERCE_API_ORIGIN || ''), 'COMMERCE_API_ORIGIN is not set in wrangler.jsonc');
    const url = new URL(WEBHOOK_PATH, env.COMMERCE_API_ORIGIN).href;
    const endpoints = (await stripe.listWebhookEndpoints())?.data || [];
    const endpoint = endpoints.find(item => item.url === url);
    expect(endpoint, `no webhook in the Stripe account points at ${url}`);
    expect(endpoint.status === 'enabled', `the webhook to ${url} is ${endpoint.status}`);
    const events = endpoint.enabled_events || [];
    expect(events.includes('*') || events.includes('checkout.session.completed'), 'the webhook does not send checkout.session.completed');
    return endpoint.id;
  });

  await check('Recent payments reached the shop', async () => {
    const recent = (await stripe.listEvents({type:'checkout.session.completed', created:{gte:now - 3 * 86400}, limit:100}))?.data || [];
    const settled = recent.filter(event => event.created < now - 1800 && event.livemode === (env.STRIPE_MODE === 'live'));
    const missed = [];
    for (const event of settled) {
      const row = await store.first('SELECT status FROM commerce_webhook_events WHERE id=?', event.id);
      if (row?.status !== 'processed') missed.push(event.id);
    }
    expect(!missed.length, `${missed.length} paid checkout(s) never reached the shop (${missed.slice(0,3).join(', ')}): check STRIPE_WEBHOOK_SECRET against the webhook's signing secret`);
    return settled.length ? `${settled.length} in the last 3 days, all received` : `${recent.length} in the last 3 days, none older than 30 minutes yet`;
  });

  await check('Paid orders were sent to Printful', async () => {
    const stuck = await store.all("SELECT id,fulfillment_status,last_error FROM commerce_orders WHERE payment_status='paid' AND live_mode=1 AND fulfillment_status!='confirmed' AND created_at<? ORDER BY created_at LIMIT 5", now - 7200);
    expect(!stuck.length, stuck.map(order => `${order.id} is ${order.fulfillment_status}${order.last_error ? ` (${order.last_error})` : ''}`).join('; '));
    return 'none waiting over 2 hours';
  });

  await check('Printful accepts orders from this shop', async () => {
    const generation = await store.activeGeneration();
    // One shirt, plus one product of each other type when there is one, sent the way real orders are (placedItems):
    // catalog variant + artwork + explicit placement. Printful refuses (400) a placement it can't print.
    const rows = generation ? await store.all(`SELECT v.id,v.product_id,v.price_cents,v.snapshot_json,p.title,p.external_id FROM catalog_variants v JOIN catalog_products p ON p.generation=v.generation AND p.id=v.product_id
      WHERE v.generation=? AND v.id IN (SELECT MIN(v2.id) FROM catalog_variants v2 JOIN catalog_products p2 ON p2.generation=v2.generation AND p2.id=v2.product_id WHERE v2.generation=? GROUP BY CASE WHEN p2.external_id LIKE 'nx-%' THEN substr(p2.external_id,1,instr(substr(p2.external_id,4),'-')+2) ELSE 'shirt' END)`, generation, generation) : [];
    expect(rows.length, 'no catalog variant to test with');
    const lines = rows.map(row => ({product_id: row.product_id, variant_id: row.id, quantity: 1, unit_price_cents: row.price_cents, title: row.title,
      kind: typeOf(row.external_id)?.type || 'tshirt', variant: JSON.parse(row.snapshot_json)}));
    // Printful keeps a deleted order's external ID reserved, so each run uses its own (date and time).
    const externalId = `selfcheck-${new Date(now * 1000).toISOString().slice(0,16).replace(/[-:T]/g,'')}`;
    const leftover = await printful.findOrder(externalId);
    if (leftover?.id && leftover.status === 'draft') await printful.deleteOrder(leftover.id);
    const draft = await printful.createDraft({external_id:externalId, recipient:DRAFT_RECIPIENT, items:await placedItems({lines}, store, printful)});
    expect(draft?.id && draft.status === 'draft', `Printful answered with status ${draft?.status || 'none'}`);
    await printful.deleteOrder(draft.id);
    const placed = (draft.items || []).map(item => `${lines[Number(String(item.external_id).replace('item_', '')) - 1]?.kind || '?'} ${item.files?.find(f => f.position)?.position?.width ?? 'no'}px`).join(', ');
    return `draft ${draft.id} created and deleted (${lines.length} items, placed: ${placed})`;
  });

  const result = {ok:checks.every(item => item.ok), checked_at:now, checks};
  await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', SELFCHECK_KEY, JSON.stringify(result));
  if (!result.ok) console.error('shop self-check failed', JSON.stringify(checks.filter(item => !item.ok)));
  return result;
}

export async function lastSelfCheck(store) {
  try { return JSON.parse((await store.first('SELECT value FROM commerce_settings WHERE key=?', SELFCHECK_KEY))?.value || 'null'); }
  catch { return null; }
}
