import { applyOutcome, localDateKey, runExpiry, type LoyaltyEvent } from '@honey/core';
import { ConcurrencyError, hasEffects } from '@honey/service';
import type { AppContext } from './context.js';
import { nextCheckOn } from './lib/expirySchedule.js';

export interface DailyJobResult {
  /** Clients whose points burned (or level/card was reset) in this run. */
  expired: number;
  /** Expiry warnings sent in this run. */
  warned: number;
  /** Clients looked at in this run. */
  checked: number;
  /** Clients whose processing threw (logged, retried on the next run). */
  failed: number;
  /** More clients were due than `maxClients`: the rest are processed on the next run. */
  more: boolean;
}

/** Default for CRON_MAX_CLIENTS: clients processed per run (Workers Free: 50 subrequests per invocation). */
export const DEFAULT_MAX_CLIENTS = 40;

/**
 * Daily job (cron "0 4 * * *" = 09:00 Tashkent, also POST /api/test/run-expiry).
 *
 * Only clients due today are loaded (clients.next_check_on, set by the previous
 * run; NULL after any activity), at most `maxClients` per run — oldest first, the
 * rest wait for the next run. Round trips: 2 fixed + 1 batch for all states +
 * 1 write per client with effects + 1 batch for next_check_on; notifications go
 * out after the writes (one Bot API call per client, one batch for the log).
 * A failing client never stops the others.
 */
export async function runDailyJob(app: AppContext, maxClients?: number): Promise<DailyJobResult> {
  const limit = Math.max(1, maxClients ?? (Number(app.env.CRON_MAX_CLIENTS) || DEFAULT_MAX_CLIENTS));
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const today = localDateKey(now, rules.timezone);
  const ids = await app.repo.expiryCandidates(today, limit + 1);
  const more = ids.length > limit;
  if (more) ids.pop();
  const states = ids.length ? await app.repo.loadClientStates(ids) : new Map();

  const events: LoyaltyEvent[] = [];
  const schedule: Array<{ clientId: string; on: string }> = [];
  let failed = 0;
  for (const id of ids) {
    const loaded = states.get(id);
    if (!loaded) continue;
    try {
      let after = loaded.state;
      const outcome = runExpiry(rules, loaded.state, now);
      if (hasEffects(outcome)) {
        try {
          await app.repo.saveOutcome(id, outcome, loaded.version);
          after = applyOutcome(loaded.state, outcome);
          events.push(...outcome.events);
        } catch (e) {
          if (!(e instanceof ConcurrencyError)) throw e;
          // Someone wrote this client meanwhile (a purchase at 09:00): re-run on fresh state.
          const res = await app.service.execute(id, ({ rules: r, state, now: n }) => runExpiry(r, state, n));
          after = res.state;
          // execute() notified by itself; only the schedule is ours.
        }
      }
      schedule.push({ clientId: id, on: nextCheckOn(rules, after, now) });
    } catch (err) {
      failed++;
      console.error(`daily job: client ${id} failed`, err);
    }
  }
  await app.repo.setNextChecks(schedule);
  await app.service.notify(events);

  const expiredClients = new Set(
    events.filter((e) => e.type === 'points_expired' || e.type === 'level_down' || e.type === 'card_reset').map((e) => e.clientId),
  );
  return { expired: expiredClients.size, warned: events.filter((e) => e.type === 'expiry_warning').length, checked: ids.length, failed, more };
}
