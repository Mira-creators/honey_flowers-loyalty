import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { D1Repository } from '../src/db/d1Repository.js';
import type { Env } from '../src/env.js';
import { errorAlert, normalizeRoute, sendAlert } from '../src/lib/alerts.js';
import { buy, call, commandUpdate, execCtx, json, makeStaff, mockTelegram, moveClock, register, resetDb, T, testEnv, WEBHOOK_SECRET } from './helpers.js';

const OWNER = T + 1002;
const FLORIST = T + 1001;
const alertEnv = (extra: Partial<Env> = {}): Env => ({ ...testEnv, ALERT_CHAT_ID: '111, 222', ENV_NAME: 'honey-loyalty-dev (dev)', ...extra });

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner', 'Владелец');
  await makeStaff(FLORIST, 'florist', 'Флорист');
});
afterEach(() => {
  vi.restoreAllMocks();
  tg.restore();
});

async function get(env: Env, path: string, user = OWNER) {
  const { ctx, flush } = execCtx();
  const res = await app.request(path, { headers: { 'x-test-user': String(user), 'x-test-key': testEnv.TEST_KEY! } }, env, ctx);
  await flush();
  return res;
}

const alerts = () => tg.sent().filter((m) => m.payload.chat_id === '111' || m.payload.chat_id === '222');

/** 09:00 Tashkent today (04:00 UTC): the hourly run after which the daily «ок» summary is sent. */
const nineAm = () => Date.parse(`${new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)}T04:00:00Z`);

async function scheduled(env: Env, scheduledTime = nineAm()) {
  const worker = (await import('../src/index.js')).default;
  const pending: Promise<unknown>[] = [];
  let error: unknown = null;
  try {
    await worker.scheduled(
      { cron: '0 * * * *', scheduledTime, noRetry() {} } as ScheduledController,
      env,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    );
  } catch (e) {
    error = e;
  }
  await Promise.allSettled(pending);
  return error;
}

describe('alerts: unhandled errors / 5xx', () => {
  it('a 500 in a route sends one alert to every ALERT_CHAT_ID; the same error is throttled for 15 minutes', async () => {
    vi.spyOn(D1Repository.prototype, 'operations').mockRejectedValue(new TypeError('boom at row 42'));
    const res = await get(alertEnv(), '/api/staff/recent');
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: { code: 'internal', message: 'Внутренняя ошибка сервера' } });
    expect(alerts().map((m) => m.payload.chat_id).sort()).toEqual(['111', '222']);
    const text = String(alerts()[0]!.payload.text);
    expect(text).toContain('honey-loyalty-dev (dev)');
    expect(text).toContain('Ошибка 500: GET /api/staff/recent');
    expect(text).toContain('TypeError: boom at row 42');

    // Same bug again (other numbers): counted, not sent.
    vi.spyOn(D1Repository.prototype, 'operations').mockRejectedValue(new TypeError('boom at row 7'));
    expect((await get(alertEnv(), '/api/staff/recent')).status).toBe(500);
    expect(alerts()).toHaveLength(2);
    const row = await testEnv.DB.prepare('SELECT kind, suppressed, total FROM system_events').first();
    expect(row).toEqual({ kind: 'http', suppressed: 1, total: 2 });

    // 16 minutes later it is sent again and mentions the swallowed repeat.
    const a = errorAlert(alertEnv(), { kind: 'http', route: 'GET /api/staff/recent', status: 500 }, new TypeError('boom at row 9'));
    expect(await sendAlert(alertEnv(), a, Date.now() + 16 * 60_000)).toBe(true);
    expect(String(alerts().at(-1)!.payload.text)).toMatch(/ещё 1 повтор/);
  });

  it('4xx and business errors are not alerts; no ALERT_CHAT_ID = no alerts at all', async () => {
    expect((await get(alertEnv(), '/api/owner/stats', FLORIST)).status).toBe(403);
    expect((await get(alertEnv(), '/api/nope')).status).toBe(404);
    expect(alerts()).toHaveLength(0);
    vi.spyOn(D1Repository.prototype, 'operations').mockRejectedValue(new Error('boom'));
    expect((await get(testEnv, '/api/staff/recent')).status).toBe(500);
    expect(tg.sent()).toHaveLength(0);
  });

  it('a failing alert delivery never changes the response', async () => {
    tg.restore();
    tg = mockTelegram({ failSendMessage: true });
    vi.spyOn(D1Repository.prototype, 'operations').mockRejectedValue(new Error('boom'));
    const res = await get(alertEnv(), '/api/staff/recent');
    expect(res.status).toBe(500);
    expect((await json(res)).error.code).toBe('internal');
  });

  it('a failing bot handler answers 200 to Telegram and alerts the team', async () => {
    vi.spyOn(D1Repository.prototype, 'findClientByTelegramId').mockRejectedValue(new Error('D1_ERROR: no such table'));
    const { ctx, flush } = execCtx();
    const res = await app.request(
      '/telegram/webhook',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: JSON.stringify({ update_id: 1, ...commandUpdate(6001, '/start') }) },
      alertEnv(),
      ctx,
    );
    await flush();
    expect(res.status).toBe(200);
    expect(alerts()).toHaveLength(2);
    expect(String(alerts()[0]!.payload.text)).toContain('Ошибка в боте (/start)');
    expect(String(alerts()[0]!.payload.text)).toContain('no such table');
  });

  it('routes are normalized so one bug = one signature', () => {
    expect(normalizeRoute('/api/staff/purchase/0b6f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/reverse')).toBe('/api/staff/purchase/:id/reverse');
    expect(normalizeRoute('/api/owner/staff/123456789')).toBe('/api/owner/staff/:id');
  });
});

describe('monitoring: nightly job', () => {
  it('every run stores a summary row; /health shows it; ALERT_DAILY=1 sends «Ночная задача: ок»', async () => {
    const me = await register(T + 5001);
    await buy(FLORIST, me.client!.id, 500_000);
    await moveClock(90);
    expect(await scheduled(alertEnv({ ALERT_DAILY: '1' }))).toBeNull();
    const run = await testEnv.DB.prepare('SELECT trigger, status, checked, expired, burned, failed FROM cron_runs').first();
    expect(run).toEqual({ trigger: 'cron', status: 'ok', checked: 1, expired: 1, burned: 5_000, failed: 0 });
    expect(alerts()).toHaveLength(2);
    expect(String(alerts()[0]!.payload.text)).toMatch(/Ночная задача: ок[\s\S]*проверено 1, напоминаний 0, сгорело у 1 \(5 000 мёда\)/);

    const health = await json(call('/health'));
    expect(health).toMatchObject({ ok: true, db: 'ok', lastCron: { trigger: 'cron', status: 'ok', checked: 1, burned: 5_000 } });
    expect(JSON.stringify(health)).not.toMatch(/token|secret|key/i);

    // Without ALERT_DAILY a good run is silent; with it, only the 09:00 run sends the summary
    // (the job runs every hour); the manual button also records a run.
    await scheduled(alertEnv());
    await scheduled(alertEnv({ ALERT_DAILY: '1' }), nineAm() + 3 * 3_600_000);
    expect(alerts()).toHaveLength(2);
    await call('/api/test/run-expiry', { user: OWNER, body: {} });
    expect((await json(call('/health'))).lastCron).toMatchObject({ trigger: 'manual', status: 'ok' });
  });

  it('a partially failed run is stored as partial and alerts', async () => {
    const a = await register(T + 5001);
    const b = await register(T + 5002);
    await buy(FLORIST, a.client!.id, 500_000);
    await buy(FLORIST, b.client!.id, 500_000);
    await moveClock(90);
    const orig = D1Repository.prototype.outcomeStmts;
    let calls = 0;
    vi.spyOn(D1Repository.prototype, 'outcomeStmts').mockImplementation(function (this: D1Repository, ...args) {
      if (++calls === 1) throw new Error('disk I/O error');
      return orig.apply(this, args);
    });
    expect(await scheduled(alertEnv())).toBeNull();
    const run = await testEnv.DB.prepare('SELECT status, failed, error FROM cron_runs').first<{ status: string; failed: number; error: string }>();
    expect(run).toMatchObject({ status: 'partial', failed: 1 });
    expect(run!.error).toContain('disk I/O error');
    expect(alerts()).toHaveLength(2);
    expect(String(alerts()[0]!.payload.text)).toMatch(/выполнена частично[\s\S]*ошибок 1/);
  });

  it('a failed run is stored as failed, alerts and marks the invocation failed', async () => {
    vi.spyOn(D1Repository.prototype, 'expiryCandidates').mockRejectedValue(new Error('D1 is overloaded'));
    const err = await scheduled(alertEnv());
    expect(String(err)).toContain('D1 is overloaded');
    expect(await testEnv.DB.prepare('SELECT status, error FROM cron_runs').first()).toEqual({ status: 'failed', error: 'Error: D1 is overloaded' });
    expect(alerts()).toHaveLength(2);
    expect(String(alerts()[0]!.payload.text)).toContain('Ночная задача упала');
    expect((await json(call('/health'))).lastCron).toMatchObject({ status: 'failed' });
  });
});
