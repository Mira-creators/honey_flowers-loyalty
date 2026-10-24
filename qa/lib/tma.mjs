// Telegram Mini App initData signing (same algorithm as packages/service/src/telegram/initData.ts),
// used to act as real Telegram users when the Worker runs with TEST_MODE=0, and to forge bad ones.
import { webcrypto } from 'node:crypto';
import { BOT_TOKEN } from './worker.mjs';

const enc = new TextEncoder();

export async function signInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const k1 = await webcrypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = new Uint8Array(await webcrypto.subtle.sign('HMAC', k1, enc.encode(token)));
  const k2 = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', Buffer.from(await webcrypto.subtle.sign('HMAC', k2, enc.encode(dcs))).toString('hex'));
  return params.toString();
}

/** Authorization header of a real (signed) Telegram user. */
export async function tma(id, { name = 'Тест', authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN, extra = {} } = {}) {
  const init = await signInitData({ auth_date: String(authDate), query_id: 'AAE-qa', user: JSON.stringify({ id, first_name: name, language_code: 'ru', ...extra }) }, token);
  return { authorization: `tma ${init}` };
}
