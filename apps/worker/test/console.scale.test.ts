import type { ConsoleClientsPageDTO, ConsoleCohortsDTO, ConsoleOperationsPageDTO, ConsoleOverviewDTO } from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, localDateKey } from '@honey/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tashkentDayStartIso } from '../src/lib/dto.js';
import { countingEnv } from './d1Counter.js';
import { bearer, db, refreshStats, seedRules, session } from './consoleHelpers.js';
import { json, makeStaff, mockTelegram, resetDb, T } from './helpers.js';

/**
 * Owner console at the target scale: 2 000 clients, 20 000 purchases (+ 20 000 cashback rows,
 * reversals, standalone redemptions). Every endpoint must stay within a few D1 round trips
 * (budget: 8 queries per request) and return exactly the totals computed here in JS.
 */

const OWNER = T + 1002;
const N_CLIENTS = 2000;
const PER_CLIENT = 10;
const DAY = 86_400_000;
const NOW = Date.now();

interface P { id: string; client: string; at: string; amount: number; reversedAt: string | null; staff: string }
const clients = Array.from({ length: N_CLIENTS }, (_, i) => ({
  id: `c${String(i).padStart(4, '0')}`,
  tid: 3_000_000_000 + i,
  code: `HF${String(100000 + i)}`,
  phone: `+99893${String(i).padStart(7, '0')}`,
  name: `Клиент ${i}`,
  createdAt: new Date(NOW - (400 + ((i * 13) % 300)) * DAY).toISOString(),
  birthday: `19${80 + (i % 20)}-${String((i % 12) + 1).padStart(2, '0')}-15`,
}));
const purchases: P[] = [];
for (let i = 0; i < N_CLIENTS; i++) {
  for (let j = 0; j < PER_CLIENT; j++) {
    const at = NOW - (((i * 7 + j * 37) % 360) + 1) * DAY - (i % 24) * 3_600_000;
    const reversed = (i * PER_CLIENT + j) % 53 === 0;
    purchases.push({
      id: `p${i}-${j}`,
      client: clients[i]!.id,
      at: new Date(at).toISOString(),
      amount: 50_000 + ((i * 31 + j * 17) % 40) * 25_000,
      reversedAt: reversed ? new Date(at + 3_600_000).toISOString() : null,
      staff: `S${i % 3}`,
    });
  }
}

async function insertJson(sql: string, rows: unknown[], chunk = 2000) {
  const stmts = [];
  for (let k = 0; k < rows.length; k += chunk) stmts.push(db().prepare(sql).bind(JSON.stringify(rows.slice(k, k + chunk))));
  await db().batch(stmts);
}

const v = (f: string) => `json_extract(value, '$.${f}')`;

async function seed() {
  await seedRules();
  await db().batch(
    [0, 1, 2].map((k) =>
      db().prepare(`INSERT INTO staff (id, telegram_id, phone, name, role, active, created_at) VALUES (?, NULL, ?, ?, 'florist', 1, ?)`).bind(`S${k}`, `+99897000000${k}`, `Флорист ${k}`, new Date(NOW).toISOString()),
    ),
  );
  await insertJson(
    `INSERT INTO clients (id, telegram_id, code, phone, name, birthday, language, consent_at, created_at)
     SELECT ${v('id')}, ${v('tid')}, ${v('code')}, ${v('phone')}, ${v('name')}, ${v('birthday')}, 'ru', ${v('createdAt')}, ${v('createdAt')} FROM json_each(?)`,
    clients,
  );
  await insertJson(
    `INSERT INTO purchases (id, client_id, staff_id, amount, lines, channel, points_redeemed, discount_applied, reward_used_id, idempotency_key,
       rules_version_id, result, status, reversed_reason, reversed_by, reversed_at, created_at)
     SELECT ${v('id')}, ${v('client')}, ${v('staff')}, ${v('amount')}, '[{"category":"flowers","amount":1}]', 'store', 0, 0, NULL, 'k' || ${v('id')}, 1, NULL,
       CASE WHEN ${v('reversedAt')} IS NULL THEN 'active' ELSE 'reversed' END,
       CASE WHEN ${v('reversedAt')} IS NULL THEN NULL ELSE 'тест' END, NULL, ${v('reversedAt')}, ${v('at')} FROM json_each(?)`,
    purchases,
  );
  await db().batch([
    db().prepare(`INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
      SELECT 'l' || id, client_id, 'accrual', amount / 100, id, NULL, '1%', NULL, created_at FROM purchases`),
    db().prepare(`INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
      SELECT 'lr' || id, client_id, 'reversal', -(amount / 100), id, reversed_by, 'reversed', NULL, reversed_at FROM purchases WHERE status = 'reversed'`),
    db().prepare(`INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
      SELECT 'rd' || id, id, 'redeem', -500, NULL, 'S1', NULL, 'rd' || id, created_at FROM clients WHERE CAST(substr(id, 2) AS INTEGER) % 10 = 0`),
  ]);
  await refreshStats();
}

const today = localDateKey(new Date(NOW), 'Asia/Tashkent');
const daysAgo = (n: number) => keyFromDayNumber(dayNumberFromKey(today) - n);
const inRange = (iso: string, from: string, to: string) => iso >= tashkentDayStartIso(from) && iso < tashkentDayStartIso(keyFromDayNumber(dayNumberFromKey(to) + 1));

let tg: ReturnType<typeof mockTelegram>;
let s: string;
beforeAll(async () => {
  await resetDb();
  await seed();
}, 120_000);
beforeEach(async () => {
  tg = mockTelegram();
  await db().prepare(`DELETE FROM staff WHERE telegram_id = ?`).bind(OWNER).run();
  await makeStaff(OWNER, 'owner', 'Владелица');
  s = await session(OWNER);
});
afterEach(() => tg.restore());

async function measured<T>(path: string) {
  const { env, c } = countingEnv();
  const t0 = Date.now();
  const res = await bearer(path, s, { env });
  const ms = Date.now() - t0;
  expect(res.status, `${path}: ${res.status}`).toBe(200);
  const body = await json<T>(res);
  // Budget: ≤ 8 D1 queries per request (2 of them are the clock and the session check).
  expect(c.calls, path).toBeLessThanOrEqual(8);
  expect(c.stmts, path).toBeLessThanOrEqual(10);
  return { body, calls: c.calls, stmts: c.stmts, rowsRead: c.rowsRead, ms };
}

describe('owner console at 2 000 clients / 20 000 purchases', () => {
  it('overview: correct totals for 90 days and a year, few queries', async () => {
    const from = daysAgo(89);
    const m = await measured<ConsoleOverviewDTO>(`/api/owner/console/overview?from=${from}&to=${today}`);
    const act = purchases.filter((p) => !p.reversedAt && inRange(p.at, from, today));
    expect(m.body.current.purchases).toBe(act.length);
    expect(m.body.current.revenue).toBe(act.reduce((a, p) => a + p.amount, 0));
    expect(m.body.current.activeClients).toBe(new Set(act.map((p) => p.client)).size);
    expect(m.body.series.reduce((a, b) => a + b.purchases, 0)).toBe(act.length);
    expect(m.body.granularity).toBe('week');
    // The previous period and the weekly buckets of the chart are distinct-buyer counts of past windows.
    const prevFrom = daysAgo(179), prevTo = daysAgo(90);
    const prevAct = purchases.filter((p) => !p.reversedAt && inRange(p.at, prevFrom, prevTo));
    expect(m.body.previous.purchases).toBe(prevAct.length);
    expect(m.body.previous.activeClients).toBe(new Set(prevAct.map((p) => p.client)).size);
    for (const b of m.body.series) {
      const end = keyFromDayNumber(Math.min(dayNumberFromKey(b.bucket) + 6, dayNumberFromKey(today)));
      const start = b.bucket < from ? from : b.bucket;
      expect(b.buyers, b.bucket).toBe(new Set(act.filter((p) => inRange(p.at, start, end)).map((p) => p.client)).size);
    }
    // Second view: the past windows come from the stats_buyers cache — a few hundred rows read.
    const warm = await measured<ConsoleOverviewDTO>(`/api/owner/console/overview?from=${from}&to=${today}`);
    expect(warm.body).toEqual(m.body);
    expect(warm.rowsRead).toBeLessThan(400);
    const year = await measured<ConsoleOverviewDTO>(`/api/owner/console/overview?from=${daysAgo(364)}&to=${today}`);
    expect(year.body.current.purchases).toBe(purchases.filter((p) => !p.reversedAt && inRange(p.at, daysAgo(364), today)).length);
    expect(year.body.current.activeClients).toBe(new Set(purchases.filter((p) => !p.reversedAt && inRange(p.at, daysAgo(364), today)).map((p) => p.client)).size);
    console.log(`overview 90 d: ${m.calls} round trips, ${m.stmts} statements, ${m.rowsRead} rows read cold, ${warm.rowsRead} warm, ${m.ms} ms`);
  });

  it('clients: matches, sums and full keyset walk (export path) are exact', async () => {
    const from = daysAgo(179);
    const first = await measured<ConsoleClientsPageDTO>(`/api/owner/console/clients?from=${from}&to=${today}&sort=total&dir=desc&limit=50`);
    const act = purchases.filter((p) => !p.reversedAt && inRange(p.at, from, today));
    expect(first.body.matched).toBe(N_CLIENTS);
    expect(first.body.matchedTotal).toBe(act.reduce((a, p) => a + p.amount, 0));
    expect(first.body.matchedPurchases).toBe(act.length);
    expect(first.body.rows).toHaveLength(50);
    const totals = first.body.rows.map((r) => r.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    console.log(`clients page: ${first.calls} round trips, ${first.rowsRead} rows read, ${first.ms} ms`);

    // The default all-time view reads client_stats, not purchases: much cheaper in D1 rows read.
    const dflt = await measured<ConsoleClientsPageDTO>('/api/owner/console/clients?limit=50');
    expect(dflt.body.matched).toBe(N_CLIENTS);
    expect(dflt.body.matchedTotal).toBeNull();
    expect(dflt.body.matchedPurchases).toBe(purchases.filter((p) => !p.reversedAt).length);
    expect(dflt.rowsRead).toBeLessThan(first.rowsRead * 0.7); // ≈ 12.5k vs ≈ 21.7k: one pass over clients + client_stats

    // Filtered: at least 5 purchases in the period and born in March.
    const filtered = await measured<ConsoleClientsPageDTO>(`/api/owner/console/clients?from=${from}&to=${today}&minCount=5&bmonth=3&limit=1000`);
    const byClient = new Map<string, number>();
    for (const p of act) byClient.set(p.client, (byClient.get(p.client) ?? 0) + 1);
    const want = clients.filter((c) => c.birthday.slice(5, 7) === '03' && (byClient.get(c.id) ?? 0) >= 5).length;
    expect(filtered.body.matched).toBe(want);
    expect(filtered.body.rows).toHaveLength(want);

    // Export walk: 1 000 per page, every client exactly once.
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: { body: ConsoleClientsPageDTO } = await measured<ConsoleClientsPageDTO>(`/api/owner/console/clients?sort=name&dir=asc&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...p.body.rows.map((r) => r.id));
      cursor = p.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(new Set(ids).size).toBe(N_CLIENTS);
  });

  it('operations: totals and a full walk match the data', async () => {
    const from = daysAgo(29);
    const first = await measured<ConsoleOperationsPageDTO>(`/api/owner/console/operations?from=${from}&to=${today}&totals=1&limit=100`);
    const inP = purchases.filter((p) => inRange(p.at, from, today));
    const rev = purchases.filter((p) => p.reversedAt && inRange(p.reversedAt, from, today));
    expect(first.body.totals!.byKind.purchase.count).toBe(inP.length);
    expect(first.body.totals!.byKind.purchase.amount).toBe(inP.reduce((a, p) => a + p.amount, 0));
    expect(first.body.totals!.byKind.purchase.points).toBe(inP.reduce((a, p) => a + Math.floor(p.amount / 100), 0));
    expect(first.body.totals!.byKind.reversal.count).toBe(rev.length);
    console.log(`operations page: ${first.calls} round trips, ${first.rowsRead} rows read, ${first.ms} ms`);

    let cursor: string | null = null;
    let seen = 0;
    do {
      const p: { body: ConsoleOperationsPageDTO } = await measured<ConsoleOperationsPageDTO>(`/api/owner/console/operations?from=${from}&to=${today}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      seen += p.body.rows.length;
      cursor = p.body.nextCursor;
    } while (cursor);
    expect(seen).toBe(first.body.totals!.count);

    const s1 = await measured<ConsoleOperationsPageDTO>(`/api/owner/console/operations?from=${from}&to=${today}&staff=S1&kinds=purchase&totals=1&limit=10`);
    expect(s1.body.totals!.byKind.purchase.count).toBe(inP.filter((p) => p.staff === 'S1').length);
  });

  it('cohorts: one query over all purchases', async () => {
    const m = await measured<ConsoleCohortsDTO>('/api/owner/console/cohorts?months=13');
    const firsts = new Map<string, string>();
    for (const p of purchases) if (!p.reversedAt && (!firsts.has(p.client) || p.at < firsts.get(p.client)!)) firsts.set(p.client, p.at);
    expect(m.body.cohorts.reduce((a, c) => a + c.clients, 0)).toBe(firsts.size);
    console.log(`cohorts: ${m.calls} round trips, ${m.rowsRead} rows read, ${m.ms} ms`);
  });
});
