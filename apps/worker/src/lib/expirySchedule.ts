import {
  balanceOf,
  dayNumberFromKey,
  expiryInfo,
  keyFromDayNumber,
  localDateKey,
  runExpiry,
  settleExpiry,
  type ClientState,
  type LoyaltyRules,
} from '@honey/core';
import { hasEffects } from '@honey/service';

/**
 * clients.next_check_on (migrations 0003 / 0008): the Tashkent date on which the daily job must
 * look at a client — the next unsent expiry reminder or the expiry day — or NULL when nothing is
 * pending (e.g. zero balance with expiry mode 'balance_only'). Computed PRECISELY on every write,
 * in the same batch (D1Repository.saveOutcome, createClient, import, demo seed), and recomputed for
 * everybody in SQL when the rules or the test clock change (nextChecksSql). The daily job reads
 * only rows with next_check_on <= today, oldest date first (index clients_next_check_idx), so a busy
 * day of purchases never starves reminders and expiries.
 */
export function nextCheckOn(rules: LoyaltyRules, state: ClientState, now: Date): string | null {
  const today = localDateKey(now, rules.timezone);
  // Something to do right now (overdue expiry, a reminder whose day has come): today.
  if (hasEffects(runExpiry(rules, state, now))) return today;
  const info = expiryInfo(rules, state, now);
  if (info.daysLeft <= 0) {
    // Overdue but nothing left to settle (already burned / nothing to burn).
    return hasEffects(settleExpiry(rules, state, now)) ? today : null;
  }
  const balance = balanceOf(state);
  const dates: string[] = [];
  if (balance > 0) {
    const sent = new Set(state.sentNotificationKeys);
    for (const d of rules.expiry.expiryWarnDays) {
      if (d < info.daysLeft && !sent.has(`expiry_warning:${info.anchorKey}:${d}`)) {
        dates.push(keyFromDayNumber(dayNumberFromKey(info.expiresOn) - d));
      }
    }
  }
  if (balance > 0 || rules.expiry.onExpiry !== 'balance_only') dates.push(info.expiresOn);
  return dates.length ? dates.sort()[0]! : null;
}

/**
 * The same schedule for MANY clients, set-based (rules change, test clock move, migration 0008).
 * Reads client_stats (balance, expiry anchor) and the sent reminder keys; never later than the
 * engine's date (it may say "today" for a client whose overdue expiry is already settled: the
 * daily job then looks at it once and stores the exact value).
 *
 * `rules` / `today` are SQL expressions (bound parameters or subqueries); `where` limits the rows
 * (e.g. a rowid range for chunking).
 */
export function nextChecksSql(rules: string, today: string, where = 'true'): string {
  const anchorDay = `date(COALESCE(NULLIF(s.activity_at, ''), c.created_at), '+5 hours')`;
  return `UPDATE clients SET next_check_on = (
      SELECT MIN(d) FROM (
        SELECT MAX(date(x.exp, '-' || CAST(w.value AS INTEGER) || ' days'), ${today}) AS d
          FROM json_each(${rules}, '$.expiry.expiryWarnDays') w
          WHERE x.bal > 0 AND x.exp > ${today}
            AND NOT EXISTS (SELECT 1 FROM notification_keys k
                            WHERE k.client_id = x.id AND k.key = 'expiry_warning:' || x.aday || ':' || CAST(w.value AS INTEGER))
        UNION ALL
        SELECT MAX(x.exp, ${today}) WHERE x.bal > 0 OR json_extract(${rules}, '$.expiry.onExpiry') <> 'balance_only'
      ))
    FROM (SELECT c.id AS id, COALESCE(s.balance, 0) AS bal, ${anchorDay} AS aday,
            date(${anchorDay}, '+' || CAST(json_extract(${rules}, '$.expiry.expiryDays') AS INTEGER) || ' days') AS exp
          FROM clients c LEFT JOIN client_stats s ON s.client_id = c.id WHERE ${where.replace(/\bclients\./g, 'c.')}) x
    WHERE x.id = clients.id`;
}

/** Rows per statement when recomputing everybody (one batch, several rowid ranges). */
export const NEXT_CHECK_CHUNK = 5000;
