// Temporary research helper: runs queued, allow-listed Printful API requests with the server's own token
// and stores the responses in D1, so mockup integration can be designed without handling the token.
// Rows are inserted directly into D1 by the account owner; nothing public can queue requests.
const ALLOWED = [
  ['GET', /^\/(mockup-generator\/|product-templates|store\/products|store\/variants|stores|products\/|v2\/catalog-products\/|v2\/mockup-tasks|v2\/mockup-styles|v2\/stores|oauth\/scopes)/],
  ['POST', /^\/(mockup-generator\/create-task\/\d+$|v2\/mockup-tasks$)/]
];
const MAX_RESPONSE = 1500000;
export async function runPrintfulProbes(store, env, now, fetcher = (...args) => fetch(...args), limit = 3) {
  if (!env.PRINTFUL_ACCESS_TOKEN) return 0;
  let pending;
  try { pending = await store.all("SELECT * FROM printful_probe WHERE status='pending' ORDER BY created_at LIMIT ?", limit); }
  catch { return 0; } // table not created: feature unused
  for (const probe of pending) {
    const method = String(probe.method || 'GET').toUpperCase();
    const path = String(probe.path || '');
    if (!ALLOWED.some(([m, pattern]) => m === method && pattern.test(path))) {
      await store.run("UPDATE printful_probe SET status='rejected',updated_at=? WHERE id=?", now, probe.id); continue;
    }
    let status = 'done', response;
    try {
      const res = await fetcher(`https://api.printful.com${path}`, {
        method, body: method === 'POST' ? probe.body : undefined, signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${env.PRINTFUL_ACCESS_TOKEN}`, 'X-PF-Store-Id': /^\d+$/.test(String(probe.store_id || '')) ? String(probe.store_id) : env.PRINTFUL_STORE_ID, 'Content-Type': 'application/json' }
      });
      response = `${res.status}\n${(await res.text()).slice(0, MAX_RESPONSE)}`;
    } catch (error) { status = 'error'; response = String(error?.message || error).slice(0, 500); }
    await store.run('UPDATE printful_probe SET status=?,response=?,updated_at=? WHERE id=?', status, response, now, probe.id);
  }
  return pending.length;
}
