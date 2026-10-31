// Oct 31, 2026: the shop's Printful key expired and nothing said so until the next morning's self-check. Now a refused
// key (Printful answers 401) emails the owner on the next 5-minute run, at most once every 6 hours per key, with the
// steps to replace it. Both keys are Printful private tokens, which always carry an expiry date.
export const KEY_ALERT_HOURS = 6;
export const refusedKey = error => /\b401\b/.test(String(error?.message || error || ''));

const STEPS = [
  'Go to https://developers.printful.com/tokens and sign in.',
  'Click Create token. Name: Nino shop (both stores). Access level: Account. Scopes: select all. Expiration date: the farthest date offered. Click Create and copy the key.',
  'Go to https://dash.cloudflare.com, click Workers & Pages, then nino-printful-commerce-api, then Settings, then Variables and Secrets.',
  'On PRINTFUL_ACCESS_TOKEN click the pencil icon, paste the key, click Deploy. Do the same on PRINTFUL_SOURCE_TOKEN with the same key.',
  'Tell Claude "Printful key replaced" so it can check both stores.'
];

export function keyAlertMessage(to, which) {
  const what = which === 'source'
    ? 'the key that copies new designs from NinosTs'
    : 'the shop key: checkout and new orders can’t reach Printful until it’s replaced';
  return {
    to,
    subject: 'Nino shop: Printful refused its key',
    html: `<p>Printful no longer accepts ${what}. Most likely it reached its expiry date.</p><ol>${STEPS.map(s => `<li>${s}</li>`).join('')}</ol>`,
    text: `Printful no longer accepts ${what}. Most likely it reached its expiry date.\n\n${STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
  };
}

// which: 'shop' (PRINTFUL_ACCESS_TOKEN) or 'source' (PRINTFUL_SOURCE_TOKEN). Never throws.
export async function alertRefusedKey(store, env, which, now) {
  try {
    if (!env.MAILER || typeof env.MAILER.send !== 'function' || !env.OWNER_EMAIL) return 'no_mailer';
    const key = `key_alert:${which}`;
    const last = await store.first('SELECT value FROM commerce_settings WHERE key=?', key);
    if (last && now - Number(last.value) < KEY_ALERT_HOURS * 3600) return 'recent';
    await env.MAILER.send(keyAlertMessage(env.OWNER_EMAIL, which));
    await store.run('INSERT INTO commerce_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(now));
    return 'sent';
  } catch { return 'failed'; }
}
