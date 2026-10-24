import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Repository } from '../src/db/d1Repository.js';
import type { Env } from '../src/env.js';
import { backoffMs, inSendWindow } from '../src/lib/outbox.js';
import { refreshStats } from './consoleHelpers.js';
import { countingEnv } from './d1Counter.js';
import { buy, makeStaff, mockTelegram, moveClock, register, repo, resetDb, T, testEnv } from './helpers.js';

/**
 * R2: the daily job runs every hour within ≤ 45 subrequests (D1 round trips + Telegram fetches),
 * writes each run's facts in ONE batch, sends 09:00–21:00 Tashkent from an outbox written in the same
 * batch as the facts, retries failed sends and never drops a message silently.
 */

const FLORIST = T + 2;
const DAY = 86_400_000;

/** Real instant of hour `h` (0–23) Tashkent, today. */
function tashkentHour(h: number): number {
  const day = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
  return Date.parse(`${day}T00:00:00+05:00`) + h * 3_600_000;
}

/** One scheduled invocation; returns D1 round trips + Telegram fetches it made. */
async function hourly(tg: ReturnType<typeof mockTelegram>, h: number, extra: Partial<Env> = {}) {
  const { env, c } = countingEnv(testEnv, extra);
  const worker = (await import('../src/index.js')).default;
  const pending: Promise<unknown>[] = [];
  const before = tg.calls.length;
  await worker.scheduled(
    { cron: '0 * * * *', scheduledTime: tashkentHour(h), noRetry() {} } as ScheduledController,
    env,
    { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  );
  await Promise.allSettled(pending);
  const fetches = tg.calls.length - before;
  const run = await testEnv.DB.prepare('SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1').first<Record<string, number | string>>();
  return { d1: c.calls, fetches, subrequests: c.calls + fetches, run: run! };
}

/** n clients whose мёд gets its 14-day reminder today (raw fixture: one purchase 76 days ago). */
async function seedDue(n: number) {
  await repo().getActiveRules();
  const db = testEnv.DB;
  const at = new Date(Date.now() - 76 * DAY).toISOString();
  await db.batch([
    db.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
       INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
       SELECT 'c' || i, 1000000000 + i, 'HF' || printf('%06d', i), '+99890' || printf('%07d', i), 'Клиент ' || i, 'ru', ?2, ?2 FROM k`,
    ).bind(n, at),
    db.prepare(
      `INSERT INTO purchases (id, client_id, staff_id, amount, lines, channel, points_redeemed, discount_applied, reward_used_id, idempotency_key, rules_version_id, result, status, created_at)
       SELECT 'p' || id, id, NULL, 200000, '[{"category":"flowers","amount":200000}]', 'store', 0, 0, NULL, 'k' || id, 1, NULL, 'active', ?1 FROM clients`,
    ).bind(at),
    db.prepare(`INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
       SELECT 'l' || id, client_id, 'accrual', 2000, id, NULL, '1%', NULL, created_at FROM purchases`),
    db.prepare(`INSERT INTO client_versions (client_id, version) SELECT id, 1 FROM clients`),
  ]);
  await refreshStats();
}

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => {
  vi.restoreAllMocks();
  tg.restore();
});

describe('hourly daily job within the subrequest budget', () => {
  it('2 000 clients due the same day: all processed within one day of hourly runs, never > 45 subrequests per run', async () => {
    await seedDue(2000);
    const runs = [];
    for (let h = 0; h < 24; h++) runs.push({ h, ...(await hourly(tg, h, { ALERT_CHAT_ID: '111' })) });
    const max = Math.max(...runs.map((r) => r.subrequests));
    expect(max).toBeLessThanOrEqual(45);
    // every run records its own count
    for (const r of runs) expect(Number(r.run.subrequests)).toBeLessThanOrEqual(45);
    const processed = runs.reduce((s, r) => s + Number(r.run.checked), 0);
    expect(processed).toBe(2000);
    expect(runs.at(-1)!.run.more).toBe(0);
    const due = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM clients WHERE next_check_on <= date('now', '+5 hours')`).first<{ n: number }>();
    expect(due!.n).toBe(0);
    // messages only 09:00–21:00, at most CRON_MAX_SENDS per run; nothing lost: sent + waiting = 2 000
    for (const r of runs) {
      if (r.h < 9 || r.h >= 21) expect(r.fetches, `hour ${r.h}`).toBe(0);
      else expect(r.fetches, `hour ${r.h}`).toBe(25);
    }
    const ob = await testEnv.DB.prepare(`SELECT status, COUNT(*) AS n FROM outbox GROUP BY status`).all<{ status: string; n: number }>();
    expect(Object.fromEntries(ob.results.map((r) => [r.status, r.n]))).toEqual({ sent: 12 * 25, pending: 2000 - 12 * 25 });
    expect(Number(runs.at(-1)!.run.queued)).toBe(2000 - 12 * 25);
    const keys = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM notification_keys`).first<{ n: number }>();
    expect(keys!.n).toBe(2000);
    console.log(`cron 2000 due: max ${max} subrequests per run (D1 ${Math.max(...runs.map((r) => r.d1))}), ${runs.filter((r) => Number(r.run.checked) > 0).length} runs to process all`);
  }, 240_000);

  it('send window is 09:00–21:00 Tashkent', () => {
    expect(inSendWindow(tashkentHour(8) + 59 * 60_000)).toBe(false);
    expect(inSendWindow(tashkentHour(9))).toBe(true);
    expect(inSendWindow(tashkentHour(20) + 59 * 60_000)).toBe(true);
    expect(inSendWindow(tashkentHour(21))).toBe(false);
    expect(backoffMs(1)).toBe(10 * 60_000);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
  });
});

describe('outbox: a reminder is never dropped', () => {
  async function dueClient() {
    await makeStaff(FLORIST, 'florist');
    const c = (await register(T + 50)).client!;
    await buy(FLORIST, c.id, 300_000);
    await moveClock(76);
    tg.calls.length = 0;
    return c;
  }

  it('applied at night, sent at 09:00', async () => {
    const c = await dueClient();
    const night = await hourly(tg, 2);
    expect(night.run).toMatchObject({ checked: 1, warned: 1, sent: 0 });
    expect(night.fetches).toBe(0);
    expect(await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM notification_keys WHERE client_id = ?`).bind(c.id).first()).toEqual({ n: 1 });
    const morning = await hourly(tg, 9);
    expect(morning.run).toMatchObject({ checked: 0, sent: 1, queued: 0 });
    expect(String(tg.sent()[0]!.payload.text)).toMatch(/14/);
  });

  it('a transient Telegram failure is retried by a later run; a blocked bot is recorded as failed', async () => {
    const c = await dueClient();
    tg.restore();
    let mode: 'down' | 'up' | 'blocked' = 'down';
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('api.telegram.org')) return realFetch(input as RequestInfo, init);
      calls.push(mode);
      if (mode === 'down') return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), { status: 502 });
      if (mode === 'blocked') return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } });
    });
    const r1 = await hourly(tg, 10);
    expect(r1.run).toMatchObject({ warned: 1, sent: 0, send_failed: 1, queued: 1 });
    const row = await testEnv.DB.prepare(`SELECT status, attempts, next_attempt_at FROM outbox WHERE client_id = ?`).bind(c.id).first<{ status: string; attempts: number; next_attempt_at: string }>();
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(row!.next_attempt_at)).toBeGreaterThan(Date.now());
    // the reminder key was written with the outbox row: no second reminder is produced, the SAME one is retried
    await testEnv.DB.prepare(`UPDATE outbox SET next_attempt_at = ?`).bind(new Date(Date.now() - 1000).toISOString()).run();
    mode = 'up';
    const r2 = await hourly(tg, 11);
    expect(r2.run).toMatchObject({ warned: 0, sent: 1, queued: 0 });
    expect((await testEnv.DB.prepare(`SELECT status FROM outbox`).first())!.status).toBe('sent');
    const log = await testEnv.DB.prepare(`SELECT status FROM notifications_log WHERE types LIKE '%expiry_warning%' ORDER BY id`).all<{ status: string }>();
    expect(log.results.map((x) => x.status)).toEqual(['failed', 'sent']);

    // permanent error: recorded as failed (in the outbox and the log), not retried forever
    await moveClock(7);
    mode = 'blocked';
    const r3 = await hourly(tg, 12);
    expect(r3.run).toMatchObject({ warned: 1, send_failed: 1, queued: 0 });
    expect((await testEnv.DB.prepare(`SELECT status, last_error FROM outbox ORDER BY id DESC`).first<{ status: string; last_error: string }>())).toMatchObject({ status: 'failed' });
    expect(calls).toEqual(['down', 'up', 'blocked']);
  });

  it('the combined write batch fails (concurrent purchase): other clients are written one by one, the busy one stays due', async () => {
    await makeStaff(FLORIST, 'florist');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = (await register(T + 60 + i)).client!;
      await buy(FLORIST, c.id, 300_000);
      ids.push(c.id);
    }
    await moveClock(76);
    const busy = ids[1]!;
    // Simulate a purchase that wrote the busy client between load and write: its version insert conflicts.
    const orig = D1Repository.prototype.outcomeStmts;
    const spy = vi.spyOn(D1Repository.prototype, 'outcomeStmts').mockImplementation(function (this: D1Repository, id, o, v, after) {
      return orig.call(this, id, o, id === busy ? v - 1 : v, after);
    });
    const r = await hourly(tg, 10);
    expect(r.run).toMatchObject({ checked: 3, warned: 2, failed: 0 });
    expect(r.subrequests).toBeLessThanOrEqual(45);
    const next = (id: string) => testEnv.DB.prepare('SELECT next_check_on AS n FROM clients WHERE id = ?').bind(id).first<{ n: string }>();
    const today = new Date(Date.now() + 76 * DAY + 5 * 3_600_000).toISOString().slice(0, 10);
    expect((await next(busy))!.n <= today).toBe(true); // still due
    expect((await next(ids[0]!))!.n > today).toBe(true);
    spy.mockRestore();
    const again = await hourly(tg, 11);
    expect(again.run).toMatchObject({ checked: 1, warned: 1 });
  });
});
