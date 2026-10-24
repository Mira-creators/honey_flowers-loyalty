import type { AppContext } from '../context.js';
import { runDailyJob, type DailyJobOptions, type DailyJobResult } from '../cron.js';
import { pruneBuyersStmt } from './statsRead.js';
import type { Env } from '../env.js';
import { testPolicy } from './testAccess.js';
import { alertChatIds, envName, sendAlert, sendToAlertChats, type Alert } from './alerts.js';

/**
 * Monitoring of the daily job: every run (cron or the TEST_MODE button) stores a
 * summary row in `cron_runs`; a failed or partially failed run sends an alert;
 * ALERT_DAILY=1 adds a short «Ночная задача: ок …» message once a day (after the 09:00 Tashkent run).
 */

export type CronTrigger = 'cron' | 'manual';
export type CronStatus = 'ok' | 'partial' | 'failed';

export interface CronRunRow {
  trigger: CronTrigger;
  startedAt: string;
  finishedAt: string;
  status: CronStatus;
  checked: number;
  warned: number;
  expired: number;
  burned: number;
  failed: number;
  more: boolean;
  error: string | null;
  /** Messages sent / failed in this run, messages waiting in the outbox, subrequests used (migration 0009). */
  sent?: number;
  sendFailed?: number;
  queued?: number;
  subrequests?: number;
}

const fmt = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** One batch: the run row (queued = pending outbox rows, counted in SQL) + pruning of old cached stats windows. */
export async function recordCronRun(db: D1Database, r: CronRunRow): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO cron_runs (trigger, started_at, finished_at, status, checked, warned, expired, burned, failed, more, error, sent, send_failed, queued, subrequests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) FROM outbox WHERE status = 'pending'), ?)`,
      )
      .bind(r.trigger, r.startedAt, r.finishedAt, r.status, r.checked, r.warned, r.expired, r.burned, r.failed, r.more ? 1 : 0, r.error, r.sent ?? 0, r.sendFailed ?? 0, (r.subrequests ?? 0) + 1),
    pruneBuyersStmt(db, r.finishedAt),
  ]);
}

export async function lastCronRun(db: D1Database): Promise<CronRunRow | null> {
  const r = await db.prepare('SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1').first<Record<string, unknown>>();
  if (!r) return null;
  return {
    trigger: String(r.trigger) as CronTrigger,
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at),
    status: String(r.status) as CronStatus,
    checked: Number(r.checked),
    warned: Number(r.warned),
    expired: Number(r.expired),
    burned: Number(r.burned),
    failed: Number(r.failed),
    more: Number(r.more) === 1,
    error: r.error === null ? null : String(r.error),
    sent: Number(r.sent ?? 0),
    sendFailed: Number(r.send_failed ?? 0),
    queued: Number(r.queued ?? 0),
    subrequests: Number(r.subrequests ?? 0),
  };
}

function summaryLine(r: CronRunRow): string {
  return (
    `проверено ${r.checked}, напоминаний ${r.warned}, сгорело у ${r.expired} (${fmt(r.burned)} мёда)` +
    (r.failed ? `, ошибок ${r.failed}` : '') +
    (r.sent ? `, отправлено сообщений ${r.sent}` : '') +
    (r.queued ? `, в очереди ${r.queued}` : '') +
    (r.more ? ' · остальные клиенты — в следующий запуск' : '')
  );
}

function cronAlert(env: Env, r: CronRunRow): Alert {
  const head = `Honey Flowers · ${envName(env)}`;
  if (r.status === 'failed') {
    return {
      kind: 'cron',
      signature: `cron|failed|${(r.error ?? '').replace(/\d+/g, '#').slice(0, 160)}`,
      text: `🚨 ${head}\nНочная задача упала (${r.trigger === 'cron' ? 'по расписанию' : 'вручную'}).\n${r.error ?? 'неизвестная ошибка'}`,
    };
  }
  return {
    kind: 'cron',
    signature: 'cron|partial',
    text: `⚠️ ${head}\nНочная задача выполнена частично: ${summaryLine(r)}.${r.error ? `\nОшибки: ${r.error}` : ''}`,
  };
}

/**
 * Run the daily job, store the run summary, alert on failure / partial failure.
 * Alert delivery goes through `app.defer` (never delays or breaks the caller).
 * Re-throws a total failure so the cron invocation is marked failed in Cloudflare.
 */
export async function runDailyJobMonitored(app: AppContext, trigger: CronTrigger, opts: DailyJobOptions = {}): Promise<DailyJobResult> {
  const startedAt = new Date().toISOString();
  let res: DailyJobResult | null = null;
  let error: unknown = null;
  try {
    res = await runDailyJob(app, opts);
  } catch (e) {
    error = e;
  }
  const row: CronRunRow = {
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: error ? 'failed' : res!.failed > 0 ? 'partial' : 'ok',
    checked: res?.checked ?? 0,
    warned: res?.warned ?? 0,
    expired: res?.expired ?? 0,
    burned: res?.burned ?? 0,
    failed: res?.failed ?? 0,
    more: res?.more ?? false,
    sent: res?.sent ?? 0,
    sendFailed: res?.sendFailed ?? 0,
    subrequests: opts.budget ? opts.budget.used : res?.subrequests ?? 0,
    error: error ? (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500) : res!.errors.length ? res!.errors.join('; ').slice(0, 500) : null,
  };
  try {
    await recordCronRun(app.env.DB, row);
  } catch (e) {
    console.error('cron_runs insert failed', e);
  }
  if (alertChatIds(app.env).length) {
    if (row.status !== 'ok') {
      app.defer(sendAlert(app.env, cronAlert(app.env, row)));
    } else if (trigger === 'cron' && app.env.ALERT_DAILY === '1' && isDailySummaryHour(opts.realNowMs ?? Date.parse(row.startedAt))) {
      app.defer(sendToAlertChats(app.env, `🐝 Ночная задача: ок · ${envName(app.env)}\n${summaryLine(row)}.`));
    }
  }
  if (error) throw error;
  return res!;
}

/** The job runs hourly: the «Ночная задача: ок» summary goes out once a day, after the 09:00 run. */
function isDailySummaryHour(realMs: number): boolean {
  return new Date(realMs + 5 * 3_600_000).getUTCHours() === 9;
}

/** GET /health payload: liveness, DB reachability, last daily job run. No secrets. */
export async function healthInfo(env: Env, testMode: boolean) {
  let db = false;
  try {
    db = (await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>())?.ok === 1;
  } catch {
    db = false;
  }
  let lastCron: CronRunRow | null = null;
  if (db) {
    try {
      lastCron = await lastCronRun(env.DB);
    } catch {
      lastCron = null; // table missing until migration 0006 is applied
    }
  }
  const ageHours = lastCron ? Math.round(((Date.now() - Date.parse(lastCron.finishedAt)) / 3_600_000) * 10) / 10 : null;
  return {
    ok: db,
    testMode,
    // Who may use the test features: 'everyone' (dev polygon), 'listed' (TEST_USERS), 'off'.
    testUsers: testPolicy(env).mode,
    env: envName(env),
    db: db ? 'ok' : 'unreachable',
    alerts: alertChatIds(env).length > 0,
    lastCron: lastCron ? { ...lastCron, ageHours } : null,
  };
}
