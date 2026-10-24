import type { AdjustResultDTO, ClientListDTO, EditableRulesDTO, ClientRowDTO, ExportLinkDTO, MeDTO, OwnerClientDTO, PurchaseResultDTO } from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, localDateKey } from '@honey/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { computeClientStats } from '../src/lib/clientStats.js';
import { csvCell, tashkentMinute } from '../src/lib/csv.js';
import { countingEnv } from './d1Counter.js';
import { buy, call, execCtx, json, makeStaff, mockTelegram, moveClock, register, repo, resetDb, T, testEnv } from './helpers.js';

const OWNER = T + 1;
const FLORIST = T + 2;
let tg: ReturnType<typeof mockTelegram>;

beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner', 'Владелица');
  await makeStaff(FLORIST, 'florist', 'Флорист');
});
afterEach(() => tg.restore());

async function list(query = ''): Promise<ClientListDTO> {
  const res = await call(`/api/owner/clients${query ? '?' + query : ''}`, { user: OWNER });
  if (res.status !== 200) throw new Error(`list ${query}: ${res.status} ${await res.text()}`);
  return json<ClientListDTO>(res);
}

/** All pages of a query (follows nextCursor). */
async function all(query: string, limit = 3, start: string | null = null): Promise<ClientRowDTO[]> {
  const out: ClientRowDTO[] = [];
  let cursor: string | null = start;
  for (let i = 0; i < 100; i++) {
    const page: ClientListDTO = await list(`${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const serverNow = async () => new Date((await json<MeDTO>(call('/api/me', { user: OWNER }))).now);

async function adjust(clientId: string, points: number, reason: string, user = OWNER) {
  return call(`/api/owner/clients/${clientId}/adjust`, { user, body: { points, reason } });
}

/** Stored client_stats row vs the engine-derived state of the client (the ledger is the truth). */
async function expectStatsConsistent(ids: string[]) {
  const r = repo();
  const { rules } = await r.getActiveRules();
  const now = await serverNow();
  for (const id of ids) {
    const row = await testEnv.DB.prepare('SELECT * FROM client_stats WHERE client_id = ?').bind(id).first<Record<string, unknown>>();
    expect(row, id).toBeTruthy();
    const { state } = await r.loadClientState(id);
    const want = computeClientStats(rules, state, now);
    expect({
      balance: Number(row!.balance), spent: Number(row!.spent), purchasesCount: Number(row!.purchases_count), lastPurchaseAt: row!.last_purchase_at,
      levelId: row!.level_id, giftsAvailable: Number(row!.gifts_available), activityAt: row!.activity_at, expiresOn: row!.expires_on,
      levelSum: Number(row!.level_sum), levelCount: Number(row!.level_count),
    }, id).toEqual(want);
  }
}

describe('GET /api/owner/clients', () => {
  it('filters by code, phone digits, name (any case), level; sorts; paginates without duplicates', async () => {
    const a = (await register(T + 101, '+998901110001', 'Дилноза')).client!;
    const b = (await register(T + 102, '+998902220002', 'Малика')).client!;
    const c = (await register(T + 103, '+998903330003', 'Анна-Мария')).client!;
    await buy(FLORIST, a.id, 2_500_000); // → level "honey"
    await buy(FLORIST, b.id, 300_000);

    expect((await list(`q=${a.code}`)).items.map((x) => x.id)).toEqual([a.id]);
    expect((await list(`q=${a.code.toLowerCase()}`)).items.map((x) => x.id)).toEqual([a.id]);
    expect((await list('q=' + encodeURIComponent('90 222'))).items.map((x) => x.id)).toEqual([b.id]);
    expect((await list('q=' + encodeURIComponent('малика'))).items.map((x) => x.id)).toEqual([b.id]);
    expect((await list('q=' + encodeURIComponent('мария'))).items.map((x) => x.id)).toEqual([c.id]);
    expect((await call('/api/owner/clients?q=12', { user: OWNER })).status).toBe(400);
    expect((await list('level=honey')).items.map((x) => x.id)).toEqual([a.id]);

    const rowA = (await list(`q=${a.code}`)).items[0]!;
    expect(rowA).toMatchObject({ name: 'Дилноза', code: a.code, levelId: 'honey', levelName: 'Медовая', balance: 25_000, spent: 2_500_000, purchases: 1, giftsAvailable: 0 });
    expect(rowA.phoneMasked).toBe('+998 90 ••• •• 01');
    expect(rowA.lastPurchaseAt).toMatch(/^\d{4}-/);
    expect(rowA.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Default sort: last purchase first, never-bought last.
    expect((await list()).items.map((x) => x.id)).toEqual([b.id, a.id, c.id]);
    expect((await list('sort=spent_desc')).items.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect((await list('sort=balance_desc')).items.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect((await list('sort=name')).items.map((x) => x.name)).toEqual(['Анна-Мария', 'Дилноза', 'Малика']);
    expect((await list('sort=created_desc')).items.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    // Bad input
    expect((await call('/api/owner/clients?sort=nope', { user: OWNER })).status).toBe(400);
    expect((await call('/api/owner/clients?limit=500', { user: OWNER })).status).toBe(400);
    expect((await call('/api/owner/clients?cursor=garbage', { user: OWNER })).status).toBe(400);
    const p1 = await list('limit=1&sort=name');
    expect((await call(`/api/owner/clients?sort=spent_desc&cursor=${p1.nextCursor}`, { user: OWNER })).status).toBe(400); // cursor of another sort
  });

  it('every sort pages through all clients exactly once (limit 3, ties broken by id)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await register(T + 200 + i, undefined, i % 2 ? 'Ольга' : 'Зарина')).client!.id);
    for (let i = 0; i < 5; i++) await buy(FLORIST, ids[i]!, 100_000 * (i % 3 + 1)); // equal spent / balance values → ties
    for (const sort of ['last_purchase_desc', 'spent_desc', 'balance_desc', 'name', 'created_desc']) {
      const rows = await all(`sort=${sort}`, 3);
      expect(rows.map((r) => r.id).sort(), sort).toEqual([...ids].sort());
      const full = (await list(`sort=${sort}&limit=100`)).items.map((r) => r.id);
      expect(rows.map((r) => r.id), sort).toEqual(full);
    }
  });

  it('cursor is stable when a client changes between pages: no duplicates, nobody skipped', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = (await register(T + 300 + i)).client!.id;
      ids.push(id);
      await buy(FLORIST, id, 100_000 + i * 10_000);
    }
    // Newest purchase first: ids[6], ids[5], … ids[0]
    const p1 = await list('limit=3');
    expect(p1.items.map((x) => x.id)).toEqual([ids[6], ids[5], ids[4]]);
    // ids[1] (on page 3) buys again → jumps to the top; offset paging would now skip ids[3].
    await buy(FLORIST, ids[1]!, 500_000);
    const p2 = await list(`limit=3&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    const p3 = p2.nextCursor ? await list(`limit=3&cursor=${encodeURIComponent(p2.nextCursor)}`) : { items: [], nextCursor: null };
    const seen = [...p1.items, ...p2.items, ...p3.items].map((x) => x.id);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids.filter((x) => x !== ids[1])) expect(seen).toContain(id);
    // Spent sort: a client whose spent grows moves "up" past the cursor — still no duplicates.
    const s1 = await list('sort=spent_desc&limit=2');
    await buy(FLORIST, ids[0]!, 5_000_000);
    const rest = await all('sort=spent_desc', 2, s1.nextCursor);
    const seen2 = [...s1.items, ...rest].map((x) => x.id);
    expect(new Set(seen2).size).toBe(seen2.length);
  });

  it('status filters: active, sleeping, lost, expiring, birthday', async () => {
    const a = (await register(T + 401)).client!.id;
    const b = (await register(T + 402)).client!.id;
    const c = (await register(T + 403)).client!.id; // never buys
    await buy(FLORIST, a, 200_000);
    await moveClock(70);
    await buy(FLORIST, b, 200_000);
    const ids = async (status: string) => (await list(`status=${status}`)).items.map((x) => x.id).sort();
    expect(await ids('active')).toEqual([a, b].sort());
    expect(await ids('sleeping')).toEqual([a]);
    expect(await ids('lost')).toEqual([c]);
    expect(await ids('expiring')).toEqual([]);
    await moveClock(15); // day 85: a's мёд burns after day 89
    expect(await ids('expiring')).toEqual([a]);
    await moveClock(10); // day 95: a has not bought for > 90 days
    expect(await ids('lost')).toEqual([a, c].sort());
    expect(await ids('active')).toEqual([b]);
    // Birthday in 3 days (Tashkent calendar of the server clock)
    const now = await serverNow();
    const inThree = keyFromDayNumber(dayNumberFromKey(localDateKey(now, 'Asia/Tashkent')) + 3);
    await testEnv.DB.prepare('UPDATE clients SET birthday = ? WHERE id = ?').bind(`1990-${inThree.slice(5)}`, c).run();
    await testEnv.DB.prepare('UPDATE clients SET birthday = ? WHERE id = ?').bind(`1990-${keyFromDayNumber(dayNumberFromKey(inThree) + 20).slice(5)}`, b).run();
    expect(await ids('birthday')).toEqual([c]);
  });
});

describe('client_stats stays consistent with the ledger', () => {
  it('20 clients after purchases, redeem, reversals, gifts, manual adjust, welcome bonus, expiry', async () => {
    // Welcome bonus for the second half of the clients.
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 10) expect((await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, welcomeBonus: 5000, reversalWindowHours: 720 } })).status).toBe(200);
      ids.push((await register(T + 500 + i)).client!.id);
    }
    const purchases = new Map<string, string[]>();
    for (let day = 0; day < 4; day++) {
      for (const id of ids) {
        const r = rnd();
        if (r < 0.55) {
          const res: PurchaseResultDTO = await buy(FLORIST, id, 100_000 + Math.floor(rnd() * 8) * 100_000, { redeem: rnd() < 0.3 });
          purchases.set(id, [...(purchases.get(id) ?? []), res.purchaseId]);
        } else if (r < 0.65 && purchases.get(id)?.length) {
          const pid = purchases.get(id)!.pop()!;
          // item 8: refused (409) when the purchase's мёд was spent; the window is 720 h here
          expect([200, 409]).toContain((await call(`/api/staff/purchase/${pid}/reverse`, { user: FLORIST, body: { reason: 'тест отмены' } })).status);
        } else if (r < 0.8) {
          expect((await adjust(id, rnd() < 0.7 ? 3000 : -1000, 'перенос базы')).status).toBe(200);
        } else {
          const card = await json<OwnerClientDTO>(call(`/api/owner/clients/${id}`, { user: OWNER }));
          const gift = card.gifts.find((g) => g.status === 'available');
          if (gift) expect((await call(`/api/staff/gift/${gift.id}/use`, { user: FLORIST, body: {} })).status).toBe(200);
        }
      }
      await moveClock(1);
    }
    // Make sure the paths we claim to cover were actually hit.
    const types = await testEnv.DB.prepare('SELECT DISTINCT type FROM points_ledger').all<{ type: string }>();
    expect(types.results.map((t) => t.type).sort()).toEqual(expect.arrayContaining(['accrual', 'manual_adjust', 'redeem', 'reversal', 'welcome']));
    await expectStatsConsistent(ids);

    // Expiry by the daily job (writes through saveOutcome with the after-state).
    await moveClock(95);
    expect((await call('/api/test/run-expiry', { user: OWNER, body: {} })).status).toBe(200);
    const expired = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM points_ledger WHERE type = 'expire'`).first<{ n: number }>();
    expect(Number(expired!.n)).toBeGreaterThan(0);
    await expectStatsConsistent(ids);
  }, 120_000);

  it('a drifted row is healed when the card is opened; a rules change recomputes level and expiry', async () => {
    const id = (await register(T + 601)).client!.id;
    await buy(FLORIST, id, 2_500_000);
    // Derived fields heal when the card is opened. (The totals — balance, counts, level sums — are
    // written in the same batch as every fact and read by the bounded load; qa/ invariants verify them.)
    await testEnv.DB.prepare(`UPDATE client_stats SET level_id = 'bee', expires_on = '2000-01-01' WHERE client_id = ?`).bind(id).run();
    expect((await list()).items[0]!.levelId).toBe('bee');
    await call(`/api/owner/clients/${id}`, { user: OWNER });
    expect((await list()).items[0]).toMatchObject({ balance: 25_000, levelId: 'honey' });
    expect((await list()).items[0]!.expiresOn).not.toBe('2000-01-01');

    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    rules.levels[1]!.from = 3_000_000; // client drops back to "bee" thresholds-wise
    rules.expiryDays = 30;
    expect((await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: rules })).status).toBe(200);
    await expectStatsConsistent([id]);
    expect((await list()).items[0]!.levelId).toBe('bee');
  });
});

describe('client card, adjustment, note', () => {
  it('card has staff-only fields and the full history', async () => {
    const me = await register(T + 701, '+998907770001', 'Севара');
    const id = me.client!.id;
    for (let i = 0; i < 3; i++) await buy(FLORIST, id, 150_000);
    const card = await json<OwnerClientDTO>(call(`/api/owner/clients/${id}`, { user: OWNER }));
    expect(card).toMatchObject({ id, name: 'Севара', phone: '+998907770001', telegramId: T + 701, language: 'ru', note: null, balance: 4500 });
    expect(card.registeredAt).toMatch(/^\d{4}-/);
    expect(card.history.filter((h) => h.kind === 'purchase')).toHaveLength(3);
    expect((await call('/api/owner/clients/nope', { user: OWNER })).status).toBe(404);
  });

  it('manual adjust: logged with staff, reason required, capped, notifies the client, idempotent by key', async () => {
    const id = (await register(T + 702)).client!.id;
    tg.calls.length = 0;
    const res = await adjust(id, 1000, 'Компенсация за задержку');
    expect(res.status).toBe(200);
    const body = await json<AdjustResultDTO>(res);
    expect(body.client.balance).toBe(1000);
    expect(body.client.history[0]).toMatchObject({ kind: 'manual', points: 1000, reason: 'Компенсация за задержку', staffName: 'Владелица' });
    const msg = tg.sent().find((m) => m.payload.chat_id === T + 702);
    expect(String(msg?.payload.text)).toMatch(/Начислено 1\s000 мёда: Компенсация за задержку/);
    const row = await testEnv.DB.prepare(`SELECT staff_id, reason FROM points_ledger WHERE client_id = ? AND type = 'manual_adjust'`).bind(id).first<{ staff_id: string }>();
    expect(row!.staff_id).toMatch(/^[0-9a-f-]{36}$/); // the owner's staff row id

    expect((await adjust(id, 100, 'ок')).status).toBe(400);
    expect((await adjust(id, 0, 'ноль')).status).toBe(400);
    expect((await adjust(id, 1.5, 'дробь')).status).toBe(400);
    expect((await adjust(id, 100_000_001, 'слишком много')).status).toBe(400);
    expect((await adjust('nope', 100, 'нет клиента')).status).toBe(404);

    const neg = await json<AdjustResultDTO>(adjust(id, -1500, 'Ошибка кассы'));
    expect(neg.client.balance).toBe(-500);
    expect(neg.warnings.join(' ')).toMatch(/отрицательн/);

    const once = { points: 200, reason: 'Акция', idempotencyKey: 'adjust-key-1' };
    const r1 = await json<AdjustResultDTO>(call(`/api/owner/clients/${id}/adjust`, { user: OWNER, body: once }));
    const r2 = await json<AdjustResultDTO>(call(`/api/owner/clients/${id}/adjust`, { user: OWNER, body: once }));
    expect([r1.replayed, r2.replayed]).toEqual([false, true]);
    expect(r2.client.balance).toBe(-300);
  });

  it('note: saved, shown on the card and in the list export, <= 500 chars, empty clears', async () => {
    const id = (await register(T + 703)).client!.id;
    const put = (note: string) => call(`/api/owner/clients/${id}/note`, { user: OWNER, method: 'PUT', body: { note } });
    expect(await json(put('  Любит пионы; звонить после 18:00  '))).toEqual({ note: 'Любит пионы; звонить после 18:00' });
    expect((await json<OwnerClientDTO>(call(`/api/owner/clients/${id}`, { user: OWNER }))).note).toBe('Любит пионы; звонить после 18:00');
    expect((await put('x'.repeat(501))).status).toBe(400);
    expect(await json(put(''))).toEqual({ note: null });
    expect((await call('/api/owner/clients/nope/note', { user: OWNER, method: 'PUT', body: { note: 'x' } })).status).toBe(404);
  });

  it('staff and clients get 403 on every owner client route', async () => {
    const id = (await register(T + 704)).client!.id;
    for (const user of [FLORIST, T + 704]) {
      expect((await call('/api/owner/clients', { user })).status).toBe(403);
      expect((await call(`/api/owner/clients/${id}`, { user })).status).toBe(403);
      expect((await adjust(id, 100, 'попытка', user)).status).toBe(403);
      expect((await call(`/api/owner/clients/${id}/note`, { user, method: 'PUT', body: { note: 'x' } })).status).toBe(403);
      expect((await call('/api/owner/export/clients.csv', { user })).status).toBe(403);
      expect((await call('/api/owner/export/operations.csv', { user })).status).toBe(403);
      expect((await call('/api/owner/export/link', { user, body: { kind: 'clients' } })).status).toBe(403);
    }
    expect((await call('/api/owner/export/clients.csv')).status).toBe(401);
  });
});

/** Minimal RFC-4180 parser with ';' (handles quotes, doubled quotes and line breaks in cells). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function csvOf(res: Response): Promise<{ bom: boolean; rows: string[][]; raw: string }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = new TextDecoder().decode(bytes); // the decoder drops the BOM; `bom` checks the raw bytes
  return { bom, raw, rows: parseCsv(raw) };
}

describe('CSV export', () => {
  const tricky = 'Ольга; "Цветочек"\nвторая строка';

  it('csvCell escapes separators, quotes and line breaks; dates are Tashkent minutes', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell(' pad')).toBe('" pad"');
    expect(csvCell(12)).toBe('12');
    expect(tashkentMinute('2026-10-18T19:30:00.000Z')).toBe('2026-10-19 00:30');
  });

  it('clients.csv: BOM, ";" separator, escaping, summary columns', async () => {
    const me = await register(T + 801, '+998908880001', tricky);
    await buy(FLORIST, me.client!.id, 300_000);
    await call(`/api/owner/clients/${me.client!.id}/note`, { user: OWNER, method: 'PUT', body: { note: 'заметка; с "кавычками"' } });
    await register(T + 802, '+998908880002', 'Бобур');
    const res = await call('/api/owner/export/clients.csv', { user: OWNER });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="honey-clients-\d{4}-\d{2}-\d{2}\.csv"/);
    const { bom, rows, raw } = await csvOf(res);
    expect(bom).toBe(true);
    expect(raw).toContain('"Ольга; ""Цветочек""\nвторая строка"');
    expect(rows[0]![0]).toBe('Код');
    expect(rows).toHaveLength(3);
    const r = rows.find((x) => x[2] === '+998908880001')!;
    expect(r[1]).toBe(tricky);
    expect(r[3]).toBe('Пчёлка');
    expect(r[4]).toBe('3000');
    expect(r[7]).toBe('1');
    expect(r[8]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r[12]).toBe('заметка; с "кавычками"');
    expect(rows.every((x) => x.length === 13)).toBe(true);
  });

  it('operations.csv: range, kinds, reasons with separators, staff names', async () => {
    const id = (await register(T + 803, undefined, tricky)).client!.id;
    const p = await buy(FLORIST, id, 400_000);
    await call(`/api/staff/purchase/${p.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка; "кассы"' } });
    await adjust(id, 700, 'Акция;\nосенняя');
    const res = await call('/api/owner/export/operations.csv', { user: OWNER });
    expect(res.status).toBe(200);
    const { bom, rows } = await csvOf(res);
    expect(bom).toBe(true);
    expect(rows[0]).toEqual(['Дата', 'Операция', 'Клиент', 'Код', 'Телефон', 'Сумма покупки', 'Мёд', 'Статус', 'Сотрудник', 'Причина / комментарий']);
    const body = rows.slice(1);
    expect(body.map((r) => r[1])).toEqual(['Покупка', 'Отмена покупки', 'Корректировка']);
    expect(body[0]).toMatchObject({ 2: tricky, 5: '400000', 6: '4000', 7: 'отменена', 8: 'Флорист' });
    expect(body[1]![9]).toBe('ошибка; "кассы"');
    expect(body[2]).toMatchObject({ 6: '700', 8: 'Владелица', 9: 'Акция;\nосенняя' });
    // A range before everything is empty (header only); bad ranges are 400.
    const empty = await csvOf(await call('/api/owner/export/operations.csv?from=2020-01-01&to=2020-01-31', { user: OWNER }));
    expect(empty.rows).toHaveLength(1);
    expect((await call('/api/owner/export/operations.csv?from=2026-05-01&to=2026-04-01', { user: OWNER })).status).toBe(400);
    expect((await call('/api/owner/export/operations.csv?from=yesterday', { user: OWNER })).status).toBe(400);
  });

  it('operations.csv pages internally in chunks and keeps every row once', async () => {
    const id = (await register(T + 804)).client!.id;
    // 1 200 manual adjustments with only a few distinct timestamps (ties across chunk borders).
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await testEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
       INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
       SELECT 'm' || printf('%05d', i), ?1, 'manual_adjust', 1, NULL, 'seed', 'r' || i, NULL, substr(?2, 1, 20) || printf('%03d', i % 3) || 'Z' FROM n`,
    ).bind(id, at).run();
    const { rows } = await csvOf(await call('/api/owner/export/operations.csv', { user: OWNER }));
    const reasons = rows.slice(1).map((r) => r[9]);
    expect(reasons).toHaveLength(1200);
    expect(new Set(reasons).size).toBe(1200);
  });

  it('one-time links: work without auth once, expire after 10 minutes, kind must match', async () => {
    await register(T + 805);
    const mk = async (body: Record<string, string>) => {
      const res = await call('/api/owner/export/link', { user: OWNER, body });
      expect(res.status).toBe(201);
      return json<ExportLinkDTO>(res);
    };
    const link = await mk({ kind: 'clients' });
    expect(link.url).toMatch(/^https:\/\/honey\.example\.workers\.dev\/api\/owner\/export\/clients\.csv\?token=[0-9a-f]{48}$/);
    const path = new URL(link.url);
    const first = await call(path.pathname + path.search);
    expect(first.status).toBe(200);
    expect((await csvOf(first)).bom).toBe(true);
    expect((await call(path.pathname + path.search)).status).toBe(410); // used

    const ops = new URL((await mk({ kind: 'operations', from: '2026-01-01', to: '2026-01-31' })).url);
    expect((await call(`/api/owner/export/clients.csv${ops.search}`)).status).toBe(410); // wrong file for this token
    const ops2 = new URL((await mk({ kind: 'operations', from: '2026-01-01', to: '2026-01-31' })).url);
    const r = await call(ops2.pathname + ops2.search);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('honey-operations-2026-01-01_2026-01-31.csv');

    const late = new URL((await mk({ kind: 'clients' })).url);
    await moveClock(1);
    expect((await call(late.pathname + late.search)).status).toBe(410); // expired
    expect((await call('/api/owner/export/clients.csv?token=deadbeef')).status).toBe(410);
    expect((await call('/api/owner/export/link', { user: OWNER, body: { kind: 'operations', from: 'x' } })).status).toBe(400);
  });
});

describe('scale: the client list is O(page)', () => {
  it('a page of 30 at 1 000 clients reads <= 200 rows in <= 6 D1 calls (every sort, filters)', async () => {
    const N = 1000;
    await repo().getActiveRules();
    const db = testEnv.DB;
    const base = Date.now() - 10 * 86_400_000;
    await db.batch([
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
         SELECT 'c' || printf('%05d', i), 1000000000 + i, 'HF' || printf('%06d', i), '+99890' || printf('%07d', i), 'Клиент ' || i, 'ru',
           strftime('%Y-%m-%dT%H:%M:%fZ', ?2 / 1000.0 - i * 60, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', ?2 / 1000.0 - i * 60, 'unixepoch') FROM n`,
      ).bind(N, base),
      // 5 purchases per client in the ledger: the list must not read them.
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
         INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
         SELECT 'l' || c.id || '-' || n.i, c.id, 'manual_adjust', 1000, NULL, 'seed', 'seed', NULL, c.created_at FROM clients c, n`,
      ),
      db.prepare(
        `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at)
         SELECT id, 5000, (CAST(substr(id, 2) AS INTEGER) % 50) * 100000, 5, created_at,
           CASE WHEN CAST(substr(id, 2) AS INTEGER) % 50 >= 20 THEN 'honey' ELSE 'bee' END, 0, created_at,
           CASE WHEN CAST(substr(id, 2) AS INTEGER) % 2 = 0 THEN date('now', '+5 hours', '+3 days') ELSE date(created_at, '+89 days') END, created_at
         FROM clients`,
      ),
    ]);
    const measure = async (q: string) => {
      const { env, c } = countingEnv();
      const { ctx, flush } = execCtx();
      const res = await app.request(`/api/owner/clients?${q}`, { headers: { 'x-test-user': String(OWNER), 'x-test-key': testEnv.TEST_KEY! } }, env, ctx);
      await flush();
      expect(res.status, q).toBe(200);
      const body = (await res.json()) as ClientListDTO;
      return { c, body };
    };
    await measure(''); // warm-up: the tg_users row of the owner is written once
    for (const q of ['', 'sort=spent_desc', 'sort=balance_desc', 'sort=name', 'sort=created_desc', 'status=active', 'level=honey', 'status=expiring']) {
      const { c, body } = await measure(q);
      expect(body.items, q).toHaveLength(30);
      expect(c.calls, q).toBeLessThanOrEqual(6);
      expect(c.rowsRead, `${q}: ${c.log.join(' | ')}`).toBeLessThanOrEqual(200);
      // The second page costs the same as the first.
      const { c: c2, body: b2 } = await measure(`${q}${q ? '&' : ''}cursor=${encodeURIComponent(body.nextCursor!)}`);
      expect(b2.items[0]!.id).not.toBe(body.items[0]!.id);
      expect(c2.rowsRead, q + ' page 2').toBeLessThanOrEqual(200);
    }
    // Known trade-off: a filter anti-correlated with the sort (lowest level, sorted by spent DESC)
    // walks past every client above it — O(clients), still a single query.
    const { c: cw } = await measure('sort=spent_desc&level=bee');
    expect(cw.calls).toBeLessThanOrEqual(6);
    expect(cw.rowsRead).toBeLessThanOrEqual(3 * N);
    // Exact code search goes through the unique index of clients.code.
    const { c: cc, body: bc } = await measure('q=HF000777');
    expect(bc.items.map((x) => x.code)).toEqual(['HF000777']);
    expect(cc.rowsRead).toBeLessThanOrEqual(20);
  }, 60_000);
});
