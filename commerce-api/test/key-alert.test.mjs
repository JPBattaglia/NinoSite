import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refusedKey,alertRefusedKey,keyAlertMessage} from '../src/key-alert.mjs';

test('a 401 from Printful counts as a refused key; other failures do not', () => {
  assert.equal(refusedKey(new Error('GET /store/products 401: The access token provided is invalid.')), true);
  assert.equal(refusedKey('Skull Wave: printful 401: expired'), true);
  assert.equal(refusedKey(new Error('GET /store/products 429')), false);
  assert.equal(refusedKey(new Error('POST /orders 400: bad address 4010 Main St')), false);
});

test('the owner gets one email per key every 6 hours, with the replacement steps', async () => {
  const settings = new Map(); const sent = [];
  const store = {
    first: async (_sql, key) => settings.has(key) ? {value: settings.get(key)} : null,
    run: async (_sql, key, value) => { settings.set(key, value); }
  };
  const env = {OWNER_EMAIL: 'info@menu-made.com', MAILER: {send: async message => { sent.push(message); }}};
  assert.equal(await alertRefusedKey(store, env, 'shop', 1000), 'sent');
  assert.equal(await alertRefusedKey(store, env, 'shop', 1000 + 3600), 'recent');
  assert.equal(await alertRefusedKey(store, env, 'source', 1000 + 3600), 'sent', 'each key alerts on its own');
  assert.equal(await alertRefusedKey(store, env, 'shop', 1000 + 7 * 3600), 'sent');
  assert.equal(sent.length, 3);
  assert.match(sent[0].text, /developers\.printful\.com\/tokens/);
  assert.match(sent[0].text, /PRINTFUL_ACCESS_TOKEN/);
  assert.doesNotMatch(keyAlertMessage('x', 'shop').text, /[←-⇿]/, 'no arrows');
  assert.equal(await alertRefusedKey(store, {}, 'shop', 99999), 'no_mailer');
});
