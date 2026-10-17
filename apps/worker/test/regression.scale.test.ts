import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { createContext } from '../src/context.js';
import { runDailyJob } from '../src/cron.js';
import { countingEnv } from './d1Counter.js';
import { execCtx, makeStaff, mockTelegram, register, repo, resetDb, T, testEnv } from './helpers.js';

/**
 * Regression tests for the scaling findings W2–W5: the daily job and the list
 * endpoints must stay within Workers Free limits (50 subrequests / invocation,
 * 10 ms CPU, D1 rows read/written per day) as the client base grows.
 * Kept light (<= 1 000 synthetic clients) so the suite stays fast.
 */

/** N clients with P purchases each; last purchase `ageDays` ago. */
async function seed(n: number, p: number, ageDays: number) {
  await repo().getActiveRules();
  const db = testEnv.DB;
  const base = Date.now() - ageDays * 86_400_000;
  const at = (k: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${base / 1000} - (${k}) * 3600, 'unixepoch')`;
  await db.batch([
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
       SELECT 'c' || i, 1000000000 + i, 'HF' || printf('%06d', i), '+99890' || printf('%07d', i), 'Клиент ' || i, 'ru', ${at('1000')}, ${at('1000')} FROM n`,
    ).bind(n),
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?), m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m WHERE j < ?)
       INSERT INTO purchases (id, client_id, staff_id, amount, lines, channel, points_redeemed, discount_applied, reward_used_id,
         idempotency_key, rules_version_id, result, status, created_at)
       SELECT 'p' || i || '-' || j, 'c' || i, NULL, 200000, '[{"category":"flowers","amount":200000}]', 'store', 0, 0, NULL,
         'k' || i || '-' || j, 1, NULL, 'active', ${at(`${p} - j`)} FROM n, m`,
    ).bind(n, p),
    db.prepare(`INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
       SELECT 'l' || id, client_id, 'accrual', 2000, id, NULL, '1%', NULL, created_at FROM purchases`),
    db.prepare(`INSERT INTO card_moves (client_id, purchase_id, cycle, cell, reason, reverted_at, created_at)
       SELECT client_id, id, 1, CAST(substr(id, instr(id, '-') + 1) AS INTEGER), 'purchase', NULL, created_at FROM purchases`),
    db.prepare(`INSERT INTO client_versions (client_id, version) SELECT id, 1 FROM clients`),
  ]);
}

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

async function get(env: typeof testEnv, path: string, user: number) {
  const { ctx, flush } = execCtx();
  const res = await app.request(path, { headers: { 'x-test-user': String(user), 'x-test-key': testEnv.TEST_KEY! } }, env, ctx);
  await flush();
  return res;
}

describe('W2/W3: daily job', () => {
  it('processes at most CRON_MAX_CLIENTS per run with O(1) fixed + O(due) round trips, resumes next run, skips idle clients', async () => {
    const DUE = 60;
    await seed(DUE, 3, 76); // all due a 14-day warning
    // 300 more clients that are nowhere near expiry: they must not be loaded at all after the first run.
    const db = testEnv.DB;
    await db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
       SELECT 'idle' || i, 2000000000 + i, 'HI' || printf('%06d', i), '+99891' || printf('%07d', i), 'Idle ' || i, 'ru', ?1, ?1 FROM n`,
    ).bind(new Date().toISOString()).run().catch(() => undefined);
    const idle = await db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE id LIKE 'idle%'`).first<{ n: number }>();

    const run = async () => {
      const { env, c } = countingEnv();
      const pending: Promise<unknown>[] = [];
      const ctx = await createContext(env, { waitUntil: (p) => void pending.push(p) });
      tg.calls.length = 0;
      const res = await runDailyJob(ctx);
      await Promise.allSettled(pending);
      return { res, d1: c.calls, rowsRead: c.rowsRead, fetches: tg.calls.filter((x) => x.method === 'sendMessage').length };
    };

    const r1 = await run();
    expect(r1.res).toMatchObject({ checked: 40, warned: 40, failed: 0, more: true });
    expect(r1.fetches).toBe(40);
    // 2 fixed (clock, rules) + candidates + 1 state batch + 40 saves + 1 schedule + contacts + log batch
    expect(r1.d1).toBeLessThanOrEqual(48);

    const r2 = await run();
    expect(r2.res).toMatchObject({ checked: DUE - 40 + Number(idle?.n ?? 0) > 40 ? 40 : DUE - 40 + Number(idle?.n ?? 0), warned: DUE - 40 });
    // Idle clients get a far-future next_check_on and are not loaded again.
    let r = r2;
    for (let i = 0; i < 12 && r.res.more; i++) r = await run();
    const r3 = await run();
    expect(r3.res).toMatchObject({ checked: 0, warned: 0, expired: 0, more: false });
    expect(r3.d1).toBeLessThanOrEqual(4);
    expect(r3.rowsRead).toBeLessThanOrEqual(5);
  }, 60_000);

  it('a client that fails does not stop the others; activity puts a client back in the queue', async () => {
    await seed(3, 2, 76);
    await testEnv.DB.prepare(`UPDATE clients SET created_at = 'garbage' WHERE id = 'c2'`).run();
    const ctx = await createContext(testEnv, {});
    const res = await runDailyJob(ctx);
    expect(res.failed).toBe(1);
    expect(res.warned).toBe(2);
    // After the run the warned clients are scheduled for the 7-day warning...
    const row = await testEnv.DB.prepare(`SELECT next_check_on FROM clients WHERE id = 'c1'`).first<{ next_check_on: string }>();
    expect(row!.next_check_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row!.next_check_on > new Date().toISOString().slice(0, 10)).toBe(true);
    // ...and a purchase resets the schedule.
    await makeStaff(T + 1001, 'florist');
    const me = await register(T + 5001);
    expect((await testEnv.DB.prepare('SELECT next_check_on FROM clients WHERE id = ?').bind(me.client!.id).first<{ next_check_on: string | null }>())!.next_check_on).toBeNull();
  });
});

describe('W4/W5: list endpoints and polling', () => {
  it('recent/operations/stats read O(limit) rows, not O(all purchases); a poll does not write', async () => {
    const N = 1000;
    await seed(N, 5, 10);
    await makeStaff(T + 1, 'owner');
    const measure = async (path: string, user = T + 1) => {
      const { env, c } = countingEnv();
      const r = await get(env, path, user);
      expect(r.status, path).toBe(200);
      return c;
    };
    const recent = await measure('/api/staff/recent');
    expect(recent.rowsRead).toBeLessThan(600); // was 35 rows per client
    const ops = await measure('/api/owner/operations?limit=100');
    expect(ops.rowsRead).toBeLessThan(2000);
    const stats = await measure('/api/owner/stats');
    expect(stats.calls).toBeLessThanOrEqual(6);
    const body = await (await get(testEnv, '/api/owner/stats', T + 1)).json() as { perWeek: Array<{ purchases: number }>; purchases: number };
    expect(body.perWeek.reduce((s, w) => s + w.purchases, 0)).toBe(N * 5);

    const first = await measure('/api/me', T + 2);
    expect(first.rowsWritten).toBe(1); // tg_users row created
    const poll = await measure('/api/me', T + 2);
    expect(poll.rowsWritten).toBe(0); // throttled: nothing rewritten within 10 minutes
  }, 60_000);
});
