import type {
  ConsoleClientsPageDTO,
  ConsoleCohortsDTO,
  ConsoleOperationsPageDTO,
  ConsoleOverviewDTO,
  WebLinkDTO,
  WebMeDTO,
} from '@honey/contracts';
import {
  buildImportRows,
  detectHeaderRow,
  detectImportColumns,
  normalizeUzPhone,
  parseImportDate,
  parseImportNumber,
} from '@honey/contracts';
import { deriveLevel } from '@honey/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucketsOf, granularityFor, period, previousPeriod } from '../src/console/analytics.js';
import { consumeLinkToken, createLinkToken, sessionKey, signSession, verifySession, WEB_LINK_TTL_MS } from '../src/console/webAuth.js';
import { countingEnv } from './d1Counter.js';
import {
  addClient,
  addLedger,
  addPurchase,
  addReward,
  bearer,
  db,
  exchange,
  noon,
  refreshStats,
  seedRules,
  session,
  tokenOf,
  webLink,
} from './consoleHelpers.js';
import { call, json, makeStaff, mockTelegram, repo, resetDb, T, testEnv, tmaHeader } from './helpers.js';

const OWNER = T + 1002;
const FLORIST = T + 1001;
const CLIENT = T + 5001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(FLORIST, 'florist', 'Флорист');
  await makeStaff(OWNER, 'owner', 'Владелица Мадина');
});
afterEach(() => tg.restore());

// ====================================================================== pure helpers

describe('import helpers: phone normalization', () => {
  it.each([
    ['+998 90 123-45-67', '+998901234567'],
    ['998901234567', '+998901234567'],
    ['901234567', '+998901234567'],
    ['90 123 45 67', '+998901234567'],
    ['(90) 123-45-67', '+998901234567'],
    ['+998 (90) 123 45 67', '+998901234567'],
    ['8 90 123 45 67', '+998901234567'],
    ['00998901234567', '+998901234567'],
    [998901234567, '+998901234567'],
    [901234567, '+998901234567'],
    ['+998901234567 (мама)', '+998901234567'],
  ])('%s → %s', (raw, want) => expect(normalizeUzPhone(raw)).toBe(want));

  it.each([['12345'], ['+7 916 123-45-67'], ['9.98901E+11'], ['90 123 45 67, 93 111 22 33'], [''], ['нет'], [null], [1.5]])('rejects %s', (raw) =>
    expect(normalizeUzPhone(raw)).toBeNull(),
  );
});

describe('import helpers: header auto-detection', () => {
  it('recognises Russian headers', () => {
    expect(detectImportColumns(['№', 'ФИО', 'Телефон', 'Дата рождения', 'Бонусы', 'Сумма покупок', 'Кол-во покупок', 'Дата последней покупки'])).toEqual({
      name: 1, phone: 2, birthday: 3, balance: 4, total: 5, count: 6, lastPurchase: 7,
    });
  });
  it('recognises English headers and ignores unknown columns', () => {
    expect(detectImportColumns(['Customer name', 'Mobile phone', 'Birthday', 'Balance', 'Total spent', 'Orders', 'Last purchase', 'Notes'])).toEqual({
      name: 0, phone: 1, birthday: 2, balance: 3, total: 4, count: 5, lastPurchase: 6,
    });
  });
  it('does not confuse "Номер карты" or "Last name" with phone / last purchase', () => {
    const m = detectImportColumns(['Номер карты', 'Last name', 'Тел.', 'Баланс баллов']);
    expect(m.phone).toBe(2);
    expect(m.lastPurchase).toBeNull();
    expect(m.name).toBe(1);
    expect(m.balance).toBe(3);
  });
  it('finds the header row below a title', () => {
    expect(detectHeaderRow([['Клиенты Honey Flowers на 01.10.2026'], [], ['Имя', 'Телефон'], ['Аня', '901234567']])).toBe(2);
  });
});

describe('import helpers: values and row validation', () => {
  it('parses amounts and dates in the usual spreadsheet formats', () => {
    expect(parseImportNumber('1 200 000')).toBe(1_200_000);
    expect(parseImportNumber('1 200 000,00 сум')).toBe(1_200_000);
    expect(parseImportNumber('1,200,000')).toBe(1_200_000);
    expect(parseImportNumber(15000.4)).toBe(15000);
    expect(parseImportNumber('')).toBeUndefined();
    expect(parseImportNumber('много')).toBeNull();
    expect(parseImportDate('08.03.1995')).toBe('1995-03-08');
    expect(parseImportDate('1995-03-08')).toBe('1995-03-08');
    expect(parseImportDate('8/3/1995')).toBe('1995-03-08');
    expect(parseImportDate('08.03.95', new Date('2026-01-01'))).toBe('1995-03-08');
    expect(parseImportDate('08.03.21', new Date('2026-01-01'))).toBe('2021-03-08');
    expect(parseImportDate(34766)).toBe('1995-03-08'); // Excel serial
    expect(parseImportDate('31.02.2000')).toBeNull();
    expect(parseImportDate('скоро')).toBeNull();
  });

  it('flags bad phones and duplicates as errors, unreadable fields as warnings', () => {
    const table = [
      ['Имя', 'Телефон', 'День рождения', 'Баланс'],
      ['Аня', '90 123 45 67', '08.03.1995', '15 000'],
      ['Боря', '12345', '', ''],
      ['', '', '', ''],
      ['Аня 2', '+998901234567', 'когда-то', 'много'],
      ['Вика', '', '01.01.2000', '0'],
      ['Гуля', '93 111 22 33', '01.01.2099', '-5'],
    ];
    const rows = buildImportRows(table, 0, detectImportColumns(table[0]!), new Date('2026-10-01'));
    expect(rows.map((r) => r.line)).toEqual([2, 3, 5, 6, 7]); // the empty row 4 is dropped
    expect(rows[0]).toMatchObject({ phone: '+998901234567', name: 'Аня', birthday: '1995-03-08', balance: 15000, errors: [], warnings: [] });
    expect(rows[1]!.errors[0]).toMatch(/Не похоже на узбекский номер/);
    expect(rows[2]!.errors[0]).toMatch(/Повтор номера \(уже в строке 2\)/);
    expect(rows[2]!.warnings).toHaveLength(2);
    expect(rows[3]!.errors).toEqual(['Нет телефона']);
    expect(rows[4]).toMatchObject({ phone: '+998931112233', birthday: null, balance: null, errors: [] });
    expect(rows[4]!.warnings).toHaveLength(2);
  });
});

describe('analytics helpers: periods and buckets', () => {
  it('previous period has the same length; granularity follows the length', () => {
    const p = period('2026-09-01', '2026-09-30');
    expect(p).toMatchObject({ days: 30, startIso: '2026-08-31T19:00:00.000Z', endIso: '2026-09-30T19:00:00.000Z' });
    expect(previousPeriod(p)).toMatchObject({ from: '2026-08-02', to: '2026-08-31', days: 30 });
    expect([granularityFor(30), granularityFor(120), granularityFor(800)]).toEqual(['day', 'week', 'month']);
    expect(bucketsOf(period('2026-09-01', '2026-09-30'), 'week')[0]).toBe('2026-08-31');
    expect(bucketsOf(period('2026-01-15', '2026-03-02'), 'month')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });
});

// ====================================================================== login link + session

describe('web login: one-time link token', () => {
  it('is single use, expires after 10 minutes and is stored hashed', async () => {
    const t0 = Date.now();
    const { token } = await createLinkToken(db(), OWNER, t0);
    const stored = await db().prepare('SELECT token_hash FROM web_link_tokens').first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toContain(token);
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await consumeLinkToken(db(), token, t0 + 1000)).toBe(OWNER);
    expect(await consumeLinkToken(db(), token, t0 + 2000)).toBeNull(); // used

    const late = await createLinkToken(db(), OWNER, t0);
    expect(await consumeLinkToken(db(), late.token, t0 + WEB_LINK_TTL_MS + 1)).toBeNull(); // expired
    expect(await consumeLinkToken(db(), 'not-a-token!', t0)).toBeNull();
  });
});

describe('web login: session signature', () => {
  it('verifies its own signature, rejects tampering and expiry', async () => {
    const key = await sessionKey(testEnv);
    const now = Date.now();
    const tok = await signSession(key, { tid: OWNER, ver: 1, iat: now, exp: now + 1000 });
    expect(await verifySession(key, tok, now)).toMatchObject({ ok: true, payload: { tid: OWNER, ver: 1 } });
    const [body, sig] = tok.split('.') as [string, string];
    const forgedBody = btoa(JSON.stringify({ tid: OWNER + 1, ver: 1, iat: now, exp: now + 1000 })).replace(/=+$/, '');
    expect(await verifySession(key, `${forgedBody}.${sig}`, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifySession(key, `${body}.${sig.slice(0, -2)}AA`, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifySession(key, tok, now + 1001)).toEqual({ ok: false, reason: 'expired' });
    // Another secret → another key → invalid.
    const other = await sessionKey({ ...testEnv, WEB_SESSION_SECRET: 'another-secret-value' });
    expect(await verifySession(other, tok, now)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('web login: routes', () => {
  it('only the owner gets a link; the link is a console URL with the token in the fragment', async () => {
    expect((await call('/api/owner/web-link', { user: FLORIST, body: {} })).status).toBe(403);
    expect((await call('/api/owner/web-link', { user: CLIENT, body: {} })).status).toBe(403);
    const link = await webLink(OWNER);
    expect(link.url).toMatch(/^https:\/\/honey\.example\.workers\.dev\/console\.html#t=[A-Za-z0-9_-]{43}$/);
    expect(link.sentToChat).toBe(false); // browser tester: nobody to message
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('a real Telegram owner also gets the link in the bot chat', async () => {
    const res = await call('/api/owner/web-link', { headers: await tmaHeader(OWNER), body: {} });
    expect(res.status).toBe(201);
    const link = await json<WebLinkDTO>(res);
    expect(link.sentToChat).toBe(true);
    const msg = tg.sent().find((m) => m.payload.chat_id === OWNER);
    expect(JSON.stringify(msg?.payload.reply_markup)).toContain(link.url);
  });

  it('exchanges a link once; a used, expired or unknown token is refused with a friendly message', async () => {
    const link = await webLink(OWNER);
    const ok = await exchange(tokenOf(link));
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({ name: 'Владелица Мадина' });
    const again = await exchange(tokenOf(link));
    expect(again.status).toBe(401);
    expect(await json(again)).toEqual({ error: { code: 'expired', message: 'Ссылка устарела, запросите новую в приложении' } });

    const stale = await webLink(OWNER);
    await db().prepare(`UPDATE web_link_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL`).run();
    expect((await exchange(tokenOf(stale))).status).toBe(401);
    expect((await exchange('x'.repeat(43))).status).toBe(401);
  });

  it('a link of someone who is no longer an owner gives no session', async () => {
    const link = await webLink(OWNER);
    await db().prepare('UPDATE staff SET active = 0 WHERE telegram_id = ?').bind(OWNER).run();
    expect((await exchange(tokenOf(link))).status).toBe(403);
  });

  it('a session works only for the owner console; tampered / expired / revoked sessions are rejected', async () => {
    const s = await session(OWNER);
    const me = await bearer('/api/web/me', s);
    expect(me.status).toBe(200);
    expect(await json<WebMeDTO>(me)).toMatchObject({ telegramId: OWNER, name: 'Владелица Мадина', via: 'webSession' });
    expect((await bearer('/api/owner/console/overview', s)).status).toBe(200);
    expect((await bearer('/api/owner/stats', s)).status).toBe(200);
    // Not the cash desk, not the client API.
    expect((await bearer('/api/staff/recent', s)).status).toBe(403);
    expect((await bearer('/api/me', s)).status).toBe(403);
    // A session cannot mint new links.
    expect((await bearer('/api/owner/web-link', s, { body: {} })).status).toBe(403);

    const [body, sig] = s.split('.') as [string, string];
    expect((await bearer('/api/web/me', `${body}x.${sig}`)).status).toBe(401);
    const key = await sessionKey(testEnv);
    const old = await signSession(key, { tid: OWNER, ver: 1, iat: Date.now() - 13 * 3600_000, exp: Date.now() - 3600_000 });
    const expired = await bearer('/api/web/me', old);
    expect(expired.status).toBe(401);
    expect((await json(expired)).error.code).toBe('expired');

    // Logout revokes this and every other session of the owner.
    const s2 = await session(OWNER);
    expect((await bearer('/api/web/logout', s, { body: {} })).status).toBe(200);
    for (const tok of [s, s2]) {
      const r = await bearer('/api/web/me', tok);
      expect(r.status).toBe(401);
      expect((await json(r)).error.code).toBe('expired');
    }
    expect((await bearer('/api/web/me', await session(OWNER))).status).toBe(200); // a new link works again
  });

  it('a demoted owner loses console access at once (403), even with a valid session', async () => {
    const s = await session(OWNER);
    await db().prepare(`UPDATE staff SET role = 'florist' WHERE telegram_id = ?`).bind(OWNER).run();
    expect((await bearer('/api/owner/console/clients', s)).status).toBe(403);
    expect((await bearer('/api/owner/import/batches', s)).status).toBe(403);
  });

  it('works without TEST_MODE too; a session request costs 2 D1 round trips before the data', async () => {
    const s = await session(OWNER);
    const prod = { ...testEnv, TEST_MODE: '0' };
    expect((await bearer('/api/web/me', s, { env: prod })).status).toBe(200);
    const { env, c } = countingEnv(prod);
    expect((await bearer('/api/web/me', s, { env })).status).toBe(200);
    expect(c.calls).toBeLessThanOrEqual(2);
  });

  it('TEST_MODE: the console also accepts the X-Test-User login', async () => {
    expect((await call('/api/owner/console/overview', { user: OWNER })).status).toBe(200);
    expect((await call('/api/owner/console/overview', { user: FLORIST })).status).toBe(403);
    expect((await call('/api/web/me', { user: OWNER })).status).toBe(200);
  });
});

// ====================================================================== analytics on a hand-computed fixture

/**
 * September 2026 (Tashkent). Clients A, B, C, E registered via Telegram, D imported (no Telegram,
 * starting honey 50 000, level floor "Медовая"). E registered and bought at 00:30 on 1 Sept
 * Tashkent time = 31 Aug 19:30 UTC: must count in September.
 */
async function seedFixture() {
  await seedRules();
  await db().batch([
    db().prepare(`INSERT INTO staff (id, telegram_id, phone, name, role, active, created_at) VALUES ('S1', NULL, '+998970000001', 'Флорист Нигора', 'florist', 1, ?)`).bind(noon('2026-01-01')),
    db().prepare(`INSERT INTO staff (id, telegram_id, phone, name, role, active, created_at) VALUES ('S2', NULL, '+998970000002', 'Флорист Лола', 'florist', 1, ?)`).bind(noon('2026-01-01')),
    db().prepare(`INSERT INTO import_batches (id, created_at, updated_at, created_by, options) VALUES ('b-fix', ?1, ?1, 'S1', '{"creditBalance":true,"levelFromTotal":true,"cellsFromCount":false}')`).bind(noon('2026-09-12')),
  ]);
  await addClient({ id: 'cA', tid: 1001, phone: '+998901000001', name: 'Анна', createdAt: noon('2026-08-10') });
  await addClient({ id: 'cB', tid: 1002, phone: '+998901000002', name: 'Бахор', createdAt: noon('2026-09-03') });
  await addClient({ id: 'cC', tid: 1003, phone: '+998901000003', name: 'Ватан', createdAt: noon('2026-09-15'), birthday: '1990-03-15' });
  await addClient({ id: 'cD', tid: -998901000004, phone: '+998901000004', name: 'Гульнора', createdAt: noon('2026-09-12'), override: { id: 'honey', at: noon('2026-09-12'), index: 1 } });
  await addClient({ id: 'cE', tid: 1005, phone: '+998901000005', name: 'Дилноза', createdAt: '2026-08-31T19:00:00.000Z' });
  await db().prepare(`INSERT INTO client_imports (client_id, batch_id, legacy_balance, created_at) VALUES ('cD', 'b-fix', 50000, ?)`).bind(noon('2026-09-12')).run();

  await addPurchase({ id: 'pA0', client: 'cA', amount: 300_000, at: noon('2026-08-15'), staff: 'S1', cashback: 3000 });
  await addPurchase({ id: 'pA1', client: 'cA', amount: 500_000, at: noon('2026-09-05'), staff: 'S1', cashback: 5000 });
  await addPurchase({ id: 'pA2', client: 'cA', amount: 200_000, at: noon('2026-09-20'), staff: 'S1', cashback: 2000 });
  await addPurchase({ id: 'pA3', client: 'cA', amount: 1_000_000, at: noon('2026-09-25'), staff: 'S1', cashback: 10_000, reversedAt: noon('2026-09-26') });
  await addPurchase({ id: 'pB1', client: 'cB', amount: 1_500_000, at: noon('2026-09-03'), staff: 'S2', cashback: 15_000 });
  await addPurchase({ id: 'pB2', client: 'cB', amount: 800_000, at: noon('2026-09-10'), staff: 'S2', cashback: 8000 });
  await addPurchase({ id: 'pE1', client: 'cE', amount: 100_000, at: '2026-08-31T19:30:00.000Z', staff: 'S2', cashback: 1000 });

  await addLedger({ id: 'l-redeem-B', client: 'cB', type: 'redeem', amount: -3000, at: noon('2026-09-12'), staff: 'S2' });
  await addLedger({ id: 'l-imp-D', client: 'cD', type: 'manual_adjust', amount: 50_000, at: noon('2026-09-12'), staff: 'S1', reason: 'Импорт базы: стартовый баланс', key: 'import:b-fix:+998901000004' });
  await addLedger({ id: 'l-adj-C', client: 'cC', type: 'manual_adjust', amount: 1000, at: noon('2026-09-16'), staff: 'S1', reason: 'компенсация' });
  await addLedger({ id: 'l-exp-C', client: 'cC', type: 'expire', amount: -1000, at: noon('2026-09-28') });
  await addReward({ id: 'rB', client: 'cB', cell: 3, unlockedAt: noon('2026-09-10'), usedAt: noon('2026-09-11') });
  await addReward({ id: 'rA', client: 'cA', cell: 3, unlockedAt: noon('2026-08-20') });
  await refreshStats();
}

const SEPT = 'from=2026-09-01&to=2026-09-30';

describe('console analytics on a hand-computed fixture', () => {
  beforeEach(seedFixture);

  it('overview: period vs previous equal period, honey, gifts, daily series', async () => {
    const s = await session(OWNER);
    const o = await json<ConsoleOverviewDTO>(bearer(`/api/owner/console/overview?${SEPT}`, s));
    expect(o).toMatchObject({ from: '2026-09-01', to: '2026-09-30', prevFrom: '2026-08-02', prevTo: '2026-08-31', granularity: 'day' });
    expect(o.current).toEqual({
      revenue: 3_100_000, // A 500k + 200k, B 1.5M + 800k, E 100k; A's reversed 1M is out
      purchases: 5,
      avgCheck: 620_000,
      activeClients: 3,
      newClients: 3, // B, C, E; the imported D is not "new"
      repeatPurchases: 3, // A twice (bought in August), B's second
      repeatShare: 0.6,
      honeyAccrued: 32_000, // 41 000 cashback − 10 000 reversed + 1 000 manual; import credit excluded
      honeyRedeemed: 3000,
      honeyExpired: 1000,
      giftsUnlocked: 1,
      giftsUsed: 1,
    });
    expect(o.previous).toEqual({
      revenue: 300_000, purchases: 1, avgCheck: 300_000, activeClients: 1, newClients: 1, repeatPurchases: 0, repeatShare: 0,
      honeyAccrued: 3000, honeyRedeemed: 0, honeyExpired: 0, giftsUnlocked: 1, giftsUsed: 0,
    });
    expect(o.series).toHaveLength(30);
    expect(o.series[0]).toEqual({ bucket: '2026-09-01', purchases: 1, revenue: 100_000, buyers: 1 });
    expect(o.series.find((b) => b.bucket === '2026-09-03')).toEqual({ bucket: '2026-09-03', purchases: 1, revenue: 1_500_000, buyers: 1 });
    expect(o.series.reduce((a, b) => a + b.revenue, 0)).toBe(3_100_000);
    const weekly = await json<ConsoleOverviewDTO>(bearer('/api/owner/console/overview?from=2026-07-01&to=2026-09-30', s));
    expect(weekly.granularity).toBe('week');
    expect(weekly.series.reduce((a, b) => a + b.purchases, 0)).toBe(6);
  });

  it('clients: period aggregates, totals, levels (same as the engine), balances, filters', async () => {
    const s = await session(OWNER);
    const page = await json<ConsoleClientsPageDTO>(bearer(`/api/owner/console/clients?${SEPT}&sort=total&dir=desc`, s));
    expect(page.matched).toBe(5);
    expect(page.matchedTotal).toBe(3_100_000);
    expect(page.matchedPurchases).toBe(5);
    expect(page.rows.map((r) => [r.name, r.purchases, r.total, r.avg, r.level, r.balance, r.linked])).toEqual([
      ['Бахор', 2, 2_300_000, 1_150_000, 'honey', 20_000, true],
      ['Анна', 2, 700_000, 350_000, 'bee', 10_000, true],
      ['Дилноза', 1, 100_000, 100_000, 'bee', 1000, true],
      ['Ватан', 0, 0, 0, 'bee', 0, true],
      ['Гульнора', 0, 0, 0, 'honey', 50_000, false],
    ]);
    expect(page.rows.find((r) => r.name === 'Анна')!).toMatchObject({ hasGift: true, lastPurchaseAt: noon('2026-09-20'), phone: '+998901000001' });

    // The SQL level is the engine's deriveLevel for every client.
    const { rules } = await repo().getActiveRules();
    for (const r of page.rows) {
      const { state } = await repo().loadClientState(r.id);
      expect(r.level, r.name).toBe(deriveLevel(rules, state, new Date()).tier.id);
    }

    const names = async (q: string) => (await json<ConsoleClientsPageDTO>(bearer(`/api/owner/console/clients?${q}&sort=name&dir=asc`, s))).rows.map((r) => r.name);
    expect(await names(`${SEPT}&minCount=2`)).toEqual(['Анна', 'Бахор']);
    expect(await names(`${SEPT}&minAvg=1000000`)).toEqual(['Бахор']);
    expect(await names(`${SEPT}&maxTotal=150000`)).toEqual(['Ватан', 'Гульнора', 'Дилноза']);
    expect(await names('level=honey')).toEqual(['Бахор', 'Гульнора']);
    expect(await names('activity=never')).toEqual(['Ватан', 'Гульнора']);
    expect(await names('linked=pending')).toEqual(['Гульнора']);
    expect(await names('gift=1')).toEqual(['Анна']);
    expect(await names('bmonth=3')).toEqual(['Ватан']);
    expect(await names('regFrom=2026-09-01&regTo=2026-09-30')).toEqual(['Бахор', 'Ватан', 'Гульнора', 'Дилноза']);
    expect(await names('q=1000002')).toEqual(['Бахор']);
    // All time (no period): A has 3 active purchases = 1 000 000.
    const all = await json<ConsoleClientsPageDTO>(bearer('/api/owner/console/clients?sort=total&dir=desc', s));
    expect(all.rows.find((r) => r.name === 'Анна')).toMatchObject({ purchases: 3, total: 1_000_000 });
    expect(all.matchedTotal).toBe(3_400_000);
  });

  it('clients: keyset pagination returns every match exactly once, in order', async () => {
    const s = await session(OWNER);
    for (const sort of ['name', 'total', 'balance', 'last', 'level', 'registered']) {
      const full = (await json<ConsoleClientsPageDTO>(bearer(`/api/owner/console/clients?${SEPT}&sort=${sort}&limit=100`, s))).rows.map((r) => r.id);
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const p: ConsoleClientsPageDTO = await json<ConsoleClientsPageDTO>(bearer(`/api/owner/console/clients?${SEPT}&sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, s));
        paged.push(...p.rows.map((r) => r.id));
        cursor = p.nextCursor;
      } while (cursor);
      expect(paged, sort).toEqual(full);
      expect(new Set(paged).size).toBe(5);
    }
    expect((await bearer('/api/owner/console/clients?cursor=garbage', s)).status).toBe(400);
    expect((await bearer('/api/owner/console/clients?sort=phone', s)).status).toBe(400);
    expect((await bearer('/api/owner/console/clients?from=2026-09-30&to=2026-09-01', s)).status).toBe(400);
  });

  it('operations: all kinds with totals, florist and amount filters, pagination', async () => {
    const s = await session(OWNER);
    const all = await json<ConsoleOperationsPageDTO>(bearer(`/api/owner/console/operations?${SEPT}&totals=1&limit=100`, s));
    expect(all.rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'expire:l-exp-C', 'reversal:rev-pA3', 'purchase:pA3', 'purchase:pA2', 'adjust:l-adj-C', 'redeem:l-redeem-B', 'adjust:l-imp-D',
      'gift:gift-rB', 'purchase:pB2', 'purchase:pA1', 'purchase:pB1', 'purchase:pE1',
    ]);
    expect(all.rows.find((r) => r.id === 'pA1')).toMatchObject({ amount: 500_000, points: 5000, staffName: 'Флорист Нигора', clientName: 'Анна', status: 'active' });
    expect(all.rows.find((r) => r.id === 'pA3')).toMatchObject({ status: 'reversed', points: 10_000 });
    expect(all.rows.find((r) => r.id === 'rev-pA3')).toMatchObject({ amount: 1_000_000, points: -10_000, reason: 'ошибка кассы' });
    expect(all.totals!.count).toBe(12);
    expect(all.totals!.byKind).toMatchObject({
      purchase: { count: 6, amount: 4_100_000, points: 41_000 },
      reversal: { count: 1, amount: 1_000_000, points: -10_000 },
      redeem: { count: 1, points: -3000 },
      adjust: { count: 2, points: 51_000 },
      expire: { count: 1, points: -1000 },
      gift: { count: 1 },
      welcome: { count: 0 },
    });

    const lola = await json<ConsoleOperationsPageDTO>(bearer(`/api/owner/console/operations?${SEPT}&staff=S2&totals=1`, s));
    expect(lola.rows.map((r) => r.id)).toEqual(['l-redeem-B', 'pB2', 'pB1', 'pE1']);
    expect(lola.totals!.byKind.purchase).toEqual({ count: 3, amount: 2_400_000, points: 24_000 });

    const big = await json<ConsoleOperationsPageDTO>(bearer(`/api/owner/console/operations?${SEPT}&minAmount=600000&totals=1`, s));
    expect(big.rows.map((r) => r.id)).toEqual(['rev-pA3', 'pA3', 'pB2', 'pB1']);
    const onlyPurchases = await json<ConsoleOperationsPageDTO>(bearer(`/api/owner/console/operations?${SEPT}&kinds=purchase&maxAmount=500000`, s));
    expect(onlyPurchases.rows.map((r) => r.id)).toEqual(['pA2', 'pA1', 'pE1']);

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const p: ConsoleOperationsPageDTO = await json<ConsoleOperationsPageDTO>(bearer(`/api/owner/console/operations?${SEPT}&limit=5${cursor ? `&cursor=${cursor}` : ''}`, s));
      paged.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all.rows.map((r) => r.id));
    expect((await bearer(`/api/owner/console/operations?kinds=bogus`, s)).status).toBe(400);
  });

  it('cohorts: second purchase on a later day within 30 days, by month of the first purchase', async () => {
    const s = await session(OWNER);
    const { cohorts } = await json<ConsoleCohortsDTO>(bearer('/api/owner/console/cohorts?months=36', s));
    const aug = cohorts.find((c) => c.month === '2026-08')!;
    const sep = cohorts.find((c) => c.month === '2026-09')!;
    expect(aug).toMatchObject({ clients: 1, e30: 1, r30: 1 }); // A: 15 Aug → 5 Sep
    expect(sep).toMatchObject({ clients: 2, e30: 2, r30: 1 }); // B: 3 → 10 Sep; E never came back
    expect(cohorts.map((c) => c.month)).toEqual(['2026-08', '2026-09']);
  });
});
