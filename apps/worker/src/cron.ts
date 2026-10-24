import { applyOutcome, localDateKey, runExpiry, type LoyaltyEvent } from '@honey/core';
import { hasEffects, type VersionedState } from '@honey/service';
import type { AppContext } from './context.js';
import { D1Repository } from './db/d1Repository.js';
import { alertChatIds } from './lib/alerts.js';
import { SubrequestBudget } from './lib/budget.js';
import { nextCheckOn } from './lib/expirySchedule.js';
import { inSendWindow, outboxInsertStmt, sendOutbox } from './lib/outbox.js';

export interface DailyJobResult {
  /** Clients whose points burned (or level/card was reset) in this run. */
  expired: number;
  /** Expiry reminders produced in this run (queued in the outbox; sent 09:00–21:00 Tashkent). */
  warned: number;
  /** Clients looked at in this run. */
  checked: number;
  /** Clients whose processing threw (logged, retried on the next run). */
  failed: number;
  /** More clients were due than processed: the rest are processed by the next run (an hour later). */
  more: boolean;
  /** мёд burned in this run, сум. */
  burned: number;
  /** First few per-client errors ("<clientId>: <message>") for the monitoring alert. */
  errors: string[];
  /** Messages Telegram accepted in this run (from the outbox). */
  sent: number;
  /** Send attempts that failed (retried later, or failed for good after a permanent error). */
  sendFailed: number;
  /** Messages still waiting in the outbox after this run. */
  queued: number;
  /** D1 round trips + fetches charged to this run's budget. */
  subrequests: number;
}

export interface DailyJobOptions {
  /** Clients processed per run (default CRON_MAX_CLIENTS or 100). */
  maxClients?: number;
  /** Messages sent per run (default CRON_MAX_SENDS or 25). */
  maxSends?: number;
  /** Scheduled job: send only 09:00–21:00 Tashkent (real time). The test button sends at any hour. */
  respectQuietHours?: boolean;
  /** Real time of the run (ScheduledController.scheduledTime) for the send window. */
  realNowMs?: number;
  /** Subrequest budget shared with the caller (index.ts wraps env.DB with countingD1). */
  budget?: SubrequestBudget;
}

/** Defaults: 100 clients per run × 24 hourly runs = 2 400 due clients a day; 25 messages per run. */
export const DEFAULT_MAX_CLIENTS = 100;
export const DEFAULT_MAX_SENDS = 25;

/**
 * Daily job, run every hour (cron "0 * * * *"; also POST /api/test/run-expiry).
 *
 * Within the Workers Free budget of 50 subrequests (D1 round trips + fetches) — at most 45:
 *   rules (1) + due clients (1) + their states (1 batch) + ALL writes (1 batch: expiry facts,
 *   reminder keys, client_stats, stats_daily, next_check_on and the outbox rows) + outbox select (1)
 *   + one sendMessage per message (≤ maxSends) + outbox/log batch (1) + cron_runs (1) + alerts.
 * Only clients due today are loaded (clients.next_check_on <= today, earliest first, precise dates:
 * lib/expirySchedule.ts). Expiries / reminders are applied at any hour; their messages go to the
 * outbox (same batch as the facts) and are sent 09:00–21:00 Tashkent, marked sent only after
 * Telegram accepted them (lib/outbox.ts). If the combined write batch fails (a purchase at the same
 * moment changed a client: version conflict), clients are written one by one while the budget
 * allows; a client not written keeps its next_check_on and is retried next run — nothing is lost.
 */
export async function runDailyJob(app: AppContext, opts: number | DailyJobOptions = {}): Promise<DailyJobResult> {
  const o: DailyJobOptions = typeof opts === 'number' ? { maxClients: opts } : opts;
  const budget = o.budget ?? new SubrequestBudget(Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, o.maxClients ?? (Number(app.env.CRON_MAX_CLIENTS) || DEFAULT_MAX_CLIENTS));
  const maxSends = Math.max(0, o.maxSends ?? (Number(app.env.CRON_MAX_SENDS) || DEFAULT_MAX_SENDS));
  // Kept for the end of the run: outbox write batch, cron_runs row, alert throttle + one fetch per chat.
  const reserve = 2 + (alertChatIds(app.env).length ? 1 + alertChatIds(app.env).length : 0);
  const now = app.now();
  const nowIso = new Date().toISOString();
  const { rules } = await app.repo.getActiveRules(now);
  const today = localDateKey(now, rules.timezone);
  const ids = await app.repo.expiryCandidates(today, limit + 1);
  const more = ids.length > limit;
  if (more) ids.pop();
  const states: Map<string, VersionedState> = ids.length ? await app.repo.loadClientStates(ids, { now, rules }) : new Map(); // bounded states (db/stateLoader.ts)

  const happened: LoyaltyEvent[] = [];
  const errors: string[] = [];
  let failed = 0;
  /** Per client: the statements of its write (facts + outbox) and its events. */
  const groups: Array<{ id: string; stmts: D1PreparedStatement[]; events: LoyaltyEvent[] }> = [];
  const schedule: D1PreparedStatement[] = [];
  for (const id of ids) {
    const loaded = states.get(id);
    if (!loaded) continue;
    try {
      const outcome = runExpiry(rules, loaded.state, now);
      if (!hasEffects(outcome)) {
        schedule.push(app.repo.nextCheckStmt(id, nextCheckOn(rules, loaded.state, now)));
        continue;
      }
      const after = applyOutcome(loaded.state, outcome);
      const stmts = app.repo.outcomeStmts(id, outcome, loaded.version, { rules, state: after, now });
      if (outcome.events.length) stmts.push(outboxInsertStmt(app.repo.db, id, outcome.events, nowIso));
      groups.push({ id, stmts, events: outcome.events });
    } catch (err) {
      failed++;
      if (errors.length < 3) errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`daily job: client ${id} failed`, err);
    }
  }

  // ONE batch for everything; on failure, isolate client by client while the budget allows.
  const all = [...groups.flatMap((g) => g.stmts), ...schedule];
  if (all.length) {
    try {
      await app.repo.db.batch(all);
      for (const g of groups) happened.push(...g.events);
    } catch (batchErr) {
      console.error('daily job: combined write failed, writing client by client', batchErr);
      const fallback = [...(schedule.length ? [{ id: 'schedule', stmts: schedule, events: [] as LoyaltyEvent[] }] : []), ...groups];
      for (const g of fallback) {
        if (budget.left() <= reserve + 3) break; // the rest stays due: next run
        try {
          await app.repo.db.batch(g.stmts);
          happened.push(...g.events);
        } catch (err) {
          const e = D1Repository.mapWriteError(err);
          // A purchase changed this client meanwhile: not an error, it is still due and retried next run.
          if (e instanceof Error && e.name === 'ConcurrencyError') continue;
          failed++;
          if (errors.length < 3) errors.push(`${g.id}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`daily job: client ${g.id} failed`, err);
        }
      }
    }
  }

  // Messages: the scheduled job sends only in the daytime window; the outbox keeps the rest.
  const send = !o.respectQuietHours || inSendWindow(o.realNowMs ?? Date.now());
  const s = send && maxSends > 0
    ? await sendOutbox(app.env, app.repo, rules, await app.origin(), { max: maxSends, budget, reserve, nowMs: Date.now(), testNow: now })
    : { sent: 0, failed: 0, skipped: 0, queued: -1 };

  const expiredClients = new Set(
    happened.filter((e) => e.type === 'points_expired' || e.type === 'level_down' || e.type === 'card_reset').map((e) => e.clientId),
  );
  return {
    expired: expiredClients.size,
    warned: happened.filter((e) => e.type === 'expiry_warning').length,
    checked: ids.length,
    failed,
    more,
    burned: happened.reduce((sum, e) => sum + (e.type === 'points_expired' ? e.amount : 0), 0),
    errors,
    sent: s.sent,
    sendFailed: s.failed,
    queued: s.queued,
    subrequests: budget.used,
  };
}
