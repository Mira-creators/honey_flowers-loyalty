import type { ClientListDTO, MeDTO, OperationDTO, OwnerClientDTO, OwnerStatsDTO, StaffClientLookupDTO, TestDemoClearDTO, TestDemoSeedDTO } from '@honey/contracts';
import { balanceFromLedger, deriveLevel, settleExpiry } from '@honey/core';
import { hasEffects } from '@honey/service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { createContext } from '../src/context.js';
import { runDailyJob } from '../src/cron.js';
import { demoClientId, demoPlan, DEMO_TOTAL } from '../src/demo/data.js';
import { DEMO_CHUNKS, simulateDemoClient } from '../src/demo/seed.js';
import type { Env } from '../src/env.js';
import { computeClientStats } from '../src/lib/clientStats.js';
import { countingEnv } from './d1Counter.js';
import { buy, call, execCtx, json, makeStaff, mockTelegram, register, repo, resetDb, T, testEnv } from './helpers.js';

const TESTER = T + 77;
const FLORIST = T + 1001;
const OWNER = T + 1002;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

async function post<R>(env: Env, path: string, body: unknown, user = TESTER): Promise<R> {
  const { ctx, flush } = execCtx();
  const res = await app.request(
    path,
    { method: 'POST', headers: { 'x-test-user': String(user), 'x-test-key': testEnv.TEST_KEY!, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
    ctx,
  );
  await flush();
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as R;
}

/** Seed every chunk like the test panel does; returns per-request D1 round trips and total rows written. */
async function seedAll() {
  const perRequest: number[] = [];
  let rowsWritten = 0;
  let chunk: number | null = 0;
  let last: TestDemoSeedDTO | null = null;
  while (chunk !== null) {
    const { env, c } = countingEnv();
    last = await post<TestDemoSeedDTO>(env, '/api/test/demo-seed', { chunk });
    perRequest.push(c.calls);
    rowsWritten += c.rowsWritten;
    chunk = last.nextChunk;
  }
  return { perRequest, rowsWritten, last: last! };
}

const count = async (sql: string) => Number((await testEnv.DB.prepare(sql).first<{ n: number }>())!.n);

describe('demo data (TEST_MODE)', () => {
  it('fills ~250 realistic clients through the engine, within Workers Free limits, and sends nothing', async () => {
    const { perRequest, rowsWritten, last } = await seedAll();
    expect(perRequest).toHaveLength(DEMO_CHUNKS);
    expect(last).toMatchObject({ finished: true, nextChunk: null, total: DEMO_TOTAL, done: DEMO_TOTAL });
    // Each request: auth + context + a few reads + ONE write batch — far below 50 D1 queries.
    expect(Math.max(...perRequest)).toBeLessThanOrEqual(20);
    // Fits the daily free quota (100k rows written) with a wide margin. (~19.6k before the owner
    // console; its two covering indexes on purchases add ~2 index rows per purchase → ~21.2k.)
    expect(rowsWritten).toBeLessThan(26_500); // + the daily aggregates (stats_daily, migration 0007) and their indexes

    expect(await count('SELECT COUNT(*) AS n FROM clients WHERE demo = 1 AND telegram_id < 0')).toBe(DEMO_TOTAL);
    expect(await count('SELECT COUNT(*) AS n FROM staff WHERE demo = 1')).toBe(4);
    // A realistic mix: reversals, мёд spent, мёд burned, gifts opened and used, gifts still waiting.
    expect(await count(`SELECT COUNT(*) AS n FROM purchases WHERE status = 'reversed'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM points_ledger WHERE type = 'redeem'`)).toBeGreaterThan(20);
    expect(await count(`SELECT COUNT(*) AS n FROM points_ledger WHERE type = 'expire'`)).toBeGreaterThan(20);
    expect(await count(`SELECT COUNT(*) AS n FROM rewards WHERE status = 'used'`)).toBeGreaterThan(10);
    expect(await count(`SELECT COUNT(*) AS n FROM rewards WHERE status = 'available'`)).toBeGreaterThan(10);
    expect(await count(`SELECT COUNT(DISTINCT staff_id) AS n FROM purchases`)).toBe(4);
    const purchases = await count('SELECT COUNT(*) AS n FROM purchases');
    expect(purchases).toBeGreaterThan(600);
    expect(purchases).toBeLessThan(1_300);
    // Amounts: 80k..2.5M flowers (+ card / delivery lines).
    expect(await count('SELECT MIN(amount) AS n FROM purchases')).toBeGreaterThanOrEqual(80_000);
    expect(await count('SELECT MAX(amount) AS n FROM purchases')).toBeLessThanOrEqual(2_575_000);
    const phones = (await testEnv.DB.prepare('SELECT phone FROM clients WHERE demo = 1').all<{ phone: string }>()).results;
    for (const { phone } of phones) expect(phone).toMatch(/^\+998(90|91|93|94|95|97|98|99|88|33|77|50|20)\d{7}$/);
    expect(new Set(phones.map((p) => p.phone)).size).toBe(DEMO_TOTAL);
    // Nobody got a Telegram message.
    expect(tg.sent()).toHaveLength(0);
    expect(await count('SELECT COUNT(*) AS n FROM notifications_log')).toBe(0);

    // Stored state is exactly what the rules produce: no negative balance, no unburned overdue мёд,
    // every level/card derivable, and a re-simulation of the plan reproduces the stored ledger.
    const r = repo();
    const { rules } = await r.getActiveRules();
    const anchor = Date.parse((await r.getSetting('demo_seed_anchor'))!);
    const now = new Date();
    const levels = new Map<string, number>();
    // client_stats (owner's client list) must equal what the engine derives from the stored facts.
    const statRows = (await testEnv.DB.prepare('SELECT s.* FROM client_stats s JOIN clients c ON c.id = s.client_id WHERE c.demo = 1').all<Record<string, unknown>>()).results;
    expect(statRows).toHaveLength(DEMO_TOTAL);
    const statsById = new Map(statRows.map((x) => [String(x.client_id), x]));
    for (let i = 1; i <= DEMO_TOTAL; i += 90) {
      const ids = Array.from({ length: Math.min(90, DEMO_TOTAL - i + 1) }, (_, k) => demoClientId(i + k));
      for (const [id, { state }] of await r.loadClientStates(ids)) {
        expect(balanceFromLedger(state.ledger)).toBeGreaterThanOrEqual(0);
        expect(hasEffects(settleExpiry(rules, state, now))).toBe(false);
        const want = computeClientStats(rules, state, now);
        const got = statsById.get(id)!;
        expect({
          balance: Number(got.balance), spent: Number(got.spent), purchasesCount: Number(got.purchases_count), lastPurchaseAt: String(got.last_purchase_at),
          levelId: String(got.level_id), giftsAvailable: Number(got.gifts_available), activityAt: String(got.activity_at), expiresOn: String(got.expires_on), levelSum: Number(got.level_sum), levelCount: Number(got.level_count),
        }).toEqual(want);
        const lv = deriveLevel(rules, state, now).tier.id;
        levels.set(lv, (levels.get(lv) ?? 0) + 1);
      }
    }
    expect(levels.get('bee')).toBeGreaterThan(100);
    expect(levels.get('honey') ?? 0).toBeGreaterThan(5);
    for (const i of [1, 37, 120, 250]) {
      const stored = (await r.loadClientState(demoClientId(i))).state;
      const again = simulateDemoClient(rules, demoPlan(i, anchor), anchor).state;
      expect(stored.ledger.map((e) => [e.type, e.amount, e.createdAt.toISOString()])).toEqual(again.ledger.map((e) => [e.type, e.amount, e.createdAt.toISOString()]));
      expect(stored.rewards.map((g) => [g.id, g.status])).toEqual(again.rewards.map((g) => [g.id, g.status]));
    }

    // The app works on top of it: owner stats, journal with demo florists, staff lookup by phone.
    await makeStaff(OWNER, 'owner', 'Владелец');
    await makeStaff(FLORIST, 'florist', 'Флорист');
    const stats = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(stats.clients).toBe(DEMO_TOTAL);
    expect(stats.points.expired).toBeGreaterThan(0);
    const ops = await json<OperationDTO[]>(call('/api/owner/operations?limit=50', { user: OWNER }));
    expect(ops.some((o) => ['Нигора Каримова', 'Дилноза Юсупова', 'Камила Ахмедова', 'Севара Рашидова'].includes(o.staffName ?? ''))).toBe(true);
    // Owner's client base: demo clients are listed with a realistic spread of statuses.
    const countStatus = async (status: string) => {
      let n = 0;
      let cursor: string | null = null;
      do {
        const page: ClientListDTO = await json<ClientListDTO>(call(`/api/owner/clients?status=${status}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { user: OWNER }));
        n += page.items.length;
        cursor = page.nextCursor;
      } while (cursor);
      return n;
    };
    const dist = { active: await countStatus('active'), sleeping: await countStatus('sleeping'), lost: await countStatus('lost'), expiring: await countStatus('expiring') };
    expect(dist.active + dist.lost).toBe(DEMO_TOTAL);
    expect(dist.active).toBeGreaterThan(90);
    expect(dist.lost).toBeGreaterThan(60);
    expect(dist.sleeping).toBeGreaterThan(15);
    expect(dist.expiring).toBeGreaterThan(3);
    const top = await json<ClientListDTO>(call('/api/owner/clients?sort=spent_desc&limit=5', { user: OWNER }));
    expect(top.items[0]!.spent).toBeGreaterThan(top.items[4]!.spent - 1);
    const card = await json<OwnerClientDTO>(call(`/api/owner/clients/${top.items[0]!.id}`, { user: OWNER }));
    expect(card).toMatchObject({ id: top.items[0]!.id, balance: top.items[0]!.balance, spent: top.items[0]!.spent, level: { id: top.items[0]!.levelId } });
    expect(card.telegramId).toBeLessThan(0);
    const found = await json<StaffClientLookupDTO>(call(`/api/staff/client?q=${encodeURIComponent(phones[0]!.phone)}`, { user: FLORIST }));
    expect(found.client).not.toBeNull();

    // A real purchase on a demo client works and still sends nothing (demo clients have no chat).
    await buy(FLORIST, found.client!.id, 300_000);
    expect(tg.sent()).toHaveLength(0);
    // The nightly job over demo clients: reminders / burns happen, no messages.
    const job = await runDailyJob(await createContext(testEnv), 300);
    expect(job.failed).toBe(0);
    expect(tg.sent()).toHaveLength(0);
  }, 120_000);

  it('is idempotent and deterministic: re-running a chunk creates nothing new', async () => {
    const first = await post<TestDemoSeedDTO>(testEnv, '/api/test/demo-seed', { chunk: 0 });
    expect(first).toMatchObject({ chunk: 0, created: 5, done: 5, finished: false, nextChunk: 1 });
    const rows = await count('SELECT COUNT(*) AS n FROM points_ledger');
    const again = await post<TestDemoSeedDTO>(testEnv, '/api/test/demo-seed', { chunk: 0 });
    expect(again).toMatchObject({ created: 0, done: 5 });
    expect(await count('SELECT COUNT(*) AS n FROM points_ledger')).toBe(rows);
    const names = (await testEnv.DB.prepare('SELECT name, code, phone FROM clients WHERE demo = 1 ORDER BY id').all()).results;
    await post(testEnv, '/api/test/demo-clear', {});
    await post(testEnv, '/api/test/demo-seed', { chunk: 0 });
    expect((await testEnv.DB.prepare('SELECT name, code, phone FROM clients WHERE demo = 1 ORDER BY id').all()).results).toEqual(names);
    // Bad chunk numbers are rejected.
    const bad = await app.request('/api/test/demo-seed', { method: 'POST', headers: { 'x-test-user': String(TESTER), 'x-test-key': testEnv.TEST_KEY!, 'content-type': 'application/json' }, body: JSON.stringify({ chunk: DEMO_CHUNKS }) }, testEnv);
    expect(bad.status).toBe(400);
  });

  it('«Удалить демо-данные» removes exactly the demo records and nothing else', async () => {
    await makeStaff(FLORIST, 'florist', 'Флорист');
    const me = await register(T + 5001, '+998901234567', 'Настоящий клиент');
    await buy(FLORIST, me.client!.id, 400_000);
    const tables = ['clients', 'staff', 'purchases', 'points_ledger', 'card_moves', 'rewards', 'notification_keys', 'client_versions', 'notifications_log', 'client_stats'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(`SELECT COUNT(*) AS n FROM ${t}`)] as const)));
    const before = await snapshot();

    await post(testEnv, '/api/test/demo-seed', { chunk: 0 });
    await post(testEnv, '/api/test/demo-seed', { chunk: 5 });
    expect((await snapshot()).clients).toBe(before.clients! + 10);
    // A tester's purchase on a demo client is demo data too.
    const demo = (await repo().findClientById(demoClientId(1)))!;
    await buy(FLORIST, demo.id, 250_000);

    const cleared = await post<TestDemoClearDTO>(testEnv, '/api/test/demo-clear', {});
    expect(cleared).toEqual({ clients: 10, staff: 4 });
    expect(await snapshot()).toEqual(before);
    expect(await repo().getSetting('demo_seed_anchor')).toBeNull();
    const mine = await json<MeDTO>(call('/api/me', { user: T + 5001 }));
    expect(mine.client!.balance).toBe(4_000);
    // Ledger is append-only again after the maintenance batch.
    await expect(testEnv.DB.prepare('DELETE FROM points_ledger').run()).rejects.toThrow(/append-only/);
  });

  it('the volume stays within the rows-written budget whatever the date (holiday peaks move with the calendar)', () => {
    // ~22 rows written per purchase incl. indexes and the client rows: <= 860 purchases keeps the seed under ~20k.
    for (let m = 0; m < 12; m++) {
      const anchor = Date.UTC(2026, m, 15, 7);
      let n = 0;
      for (let i = 1; i <= DEMO_TOTAL; i++) {
        const p = demoPlan(i, anchor);
        n += p.purchases.length + p.purchases.filter((x) => x.reversal?.correctedFlowers).length;
        for (const x of p.purchases) {
          expect(x.at).toBeLessThan(anchor);
          expect(x.flowers).toBeGreaterThanOrEqual(80_000);
          expect(x.flowers).toBeLessThanOrEqual(2_500_000);
        }
      }
      expect(n).toBeGreaterThan(650);
      expect(n).toBeLessThanOrEqual(860);
    }
  });

  it('demo endpoints are 404 without TEST_MODE', async () => {
    const res = await app.request('/api/test/demo-seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"chunk":0}' }, { ...testEnv, TEST_MODE: '0' });
    expect(res.status).toBe(404);
  });
});
