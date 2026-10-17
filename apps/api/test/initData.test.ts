import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildInitData, InitDataError, validateInitData, webAppSecretKey } from '../src/telegram/initData.js';

const BOT_TOKEN = '7000000001:AAH-test-token-for-unit-tests';
const now = new Date('2026-11-01T10:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000) - 60);
const user = JSON.stringify({ id: 123456789, first_name: 'Амалия', username: 'amalia', language_code: 'ru' });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InitDataError) return e.code;
    throw e;
  }
  return undefined;
}

describe('Telegram initData validation', () => {
  it('derives the secret key as HMAC_SHA256("WebAppData", bot_token)', () => {
    const expected = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest('hex');
    expect(webAppSecretKey(BOT_TOKEN).toString('hex')).toBe(expected);
  });

  it('accepts a correctly signed initData (independent reference signature)', () => {
    // Build the data-check-string by hand, independent of the module.
    const fields = { auth_date: authDate, query_id: 'AAE1', user };
    const dcs = `auth_date=${authDate}\nquery_id=AAE1\nuser=${user}`;
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = createHmac('sha256', secret).update(dcs).digest('hex');
    const raw = new URLSearchParams({ ...fields, hash }).toString();
    const res = validateInitData(raw, BOT_TOKEN, { now });
    expect(res.user.id).toBe(123456789);
    expect(res.user.first_name).toBe('Амалия');
    expect(res.queryId).toBe('AAE1');
    expect(res.authDate.getTime()).toBe(Number(authDate) * 1000);
  });

  it('field order in the query string does not matter', () => {
    const raw = buildInitData({ user, auth_date: authDate, start_param: 'qr' }, BOT_TOKEN);
    const shuffled = new URLSearchParams(raw);
    const reordered = new URLSearchParams([...shuffled.entries()].reverse()).toString();
    expect(validateInitData(reordered, BOT_TOKEN, { now }).startParam).toBe('qr');
  });

  it('rejects a tampered field', () => {
    const raw = buildInitData({ auth_date: authDate, user }, BOT_TOKEN);
    const p = new URLSearchParams(raw);
    p.set('user', JSON.stringify({ id: 1, first_name: 'Hacker' }));
    expect(codeOf(() => validateInitData(p.toString(), BOT_TOKEN, { now }))).toBe('BAD_HASH');
  });

  it('rejects a signature made with another bot token', () => {
    const raw = buildInitData({ auth_date: authDate, user }, '7000000002:other');
    expect(codeOf(() => validateInitData(raw, BOT_TOKEN, { now }))).toBe('BAD_HASH');
  });

  it('rejects missing or malformed hash', () => {
    expect(codeOf(() => validateInitData(`auth_date=${authDate}`, BOT_TOKEN, { now }))).toBe('MISSING_HASH');
    expect(codeOf(() => validateInitData(`auth_date=${authDate}&hash=xyz`, BOT_TOKEN, { now }))).toBe('BAD_HASH');
  });

  it('rejects stale auth_date and accepts it just inside the max age', () => {
    const old = String(Math.floor(now.getTime() / 1000) - 3601);
    const raw = buildInitData({ auth_date: old, user }, BOT_TOKEN);
    expect(codeOf(() => validateInitData(raw, BOT_TOKEN, { now, maxAgeSeconds: 3600 }))).toBe('EXPIRED');
    expect(validateInitData(raw, BOT_TOKEN, { now, maxAgeSeconds: 3601 }).user.id).toBe(123456789);
  });

  it('rejects auth_date in the future beyond the clock skew', () => {
    const future = String(Math.floor(now.getTime() / 1000) + 600);
    const raw = buildInitData({ auth_date: future, user }, BOT_TOKEN);
    expect(codeOf(() => validateInitData(raw, BOT_TOKEN, { now }))).toBe('FUTURE_AUTH_DATE');
  });

  it('rejects signed data without a user', () => {
    const raw = buildInitData({ auth_date: authDate }, BOT_TOKEN);
    expect(codeOf(() => validateInitData(raw, BOT_TOKEN, { now }))).toBe('MALFORMED');
  });
});
