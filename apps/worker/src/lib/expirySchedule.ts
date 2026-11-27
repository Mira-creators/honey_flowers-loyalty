import {
  balanceOf,
  birthdayRewardId,
  birthdayWindow,
  isBirthdayReward,
  levelReset,
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
 * look at a client — the EARLIEST of: the next unsent мёд reminder or the expiry day; the next
 * level-reset reminder or the reset day (sticky levels, a separate timer); the birthday gift window
 * or the day after a birthday gift's last day — or NULL when nothing is pending. Computed PRECISELY on every write,
 * in the same batch (D1Repository.saveOutcome, createClient, import, demo seed), and recomputed for
 * everybody in SQL when the rules or the test clock change (nextChecksSql). The daily job reads
 * only rows with next_check_on <= today, oldest date first (index clients_next_check_idx), so a busy
 * day of purchases never starves reminders and expiries.
 */
export function nextCheckOn(rules: LoyaltyRules, state: ClientState, now: Date): string | null {
  const today = localDateKey(now, rules.timezone);
  // Something to do right now (overdue expiry, a reminder whose day has come, a level reset message,
  // a birthday gift to unlock or revoke): today.
  if (hasEffects(runExpiry(rules, state, now))) return today;
  const dates: string[] = [];
  const sent = new Set(state.sentNotificationKeys);
  const day = (key: string, minus: number) => keyFromDayNumber(dayNumberFromKey(key) - minus);

  // мёд (expiry.*)
  const info = expiryInfo(rules, state, now);
  if (info.daysLeft <= 0) {
    // Overdue but nothing left to settle (already burned / nothing to burn).
    if (hasEffects(settleExpiry(rules, state, now))) dates.push(today);
  } else {
    const balance = balanceOf(state);
    if (balance > 0) {
      for (const d of rules.expiry.expiryWarnDays) {
        if (d < info.daysLeft && !sent.has(`expiry_warning:${info.anchorKey}:${d}`)) dates.push(day(info.expiresOn, d));
      }
    }
    if (balance > 0 || rules.expiry.onExpiry !== 'balance_only') dates.push(info.expiresOn);
  }

  // sticky level: a separate timer (levels.resetAfterDays, resetWarnDays)
  const lr = levelReset(rules, state, now);
  if (lr && lr.daysLeft > 0) {
    for (const d of rules.levels.resetWarnDays) {
      if (d < lr.daysLeft && !sent.has(`level_warning:${lr.anchorKey}:${d}`)) dates.push(day(lr.resetsOn, d));
    }
    if (!sent.has(`level_reset:${lr.anchorKey}`)) dates.push(lr.resetsOn);
  }

  // birthday gift: the next window, and the day after an available gift's last day (revoke)
  const bw = birthdayWindow(rules, state.birthday, now);
  if (bw && !state.rewards.some((r) => r.id === birthdayRewardId(state.clientId, bw.year))) dates.push(bw.current ? today : bw.from);
  for (const r of state.rewards) {
    if (r.status === 'available' && r.validUntil && isBirthdayReward(r)) dates.push(day(r.validUntil, -1));
  }
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
  // Sticky level timer: the level is kept from the last purchase (or the level override) day.
  const levelDay = `date(MAX(COALESCE(NULLIF(s.last_purchase_at, ''), ''), COALESCE(c.level_override_at, '')), '+5 hours')`;
  const lvMode = `json_extract(${rules}, '$.levels.mode')`;
  const lvReset = `CAST(json_extract(${rules}, '$.levels.resetAfterDays') AS INTEGER)`;
  const bd = `json_extract(${rules}, '$.birthdayReward')`;
  // D1 allows only a few terms per compound SELECT: one small compound per timer, combined by MIN.
  return `UPDATE clients SET next_check_on = (
      SELECT MIN(v) FROM (
        SELECT (SELECT MIN(d) FROM (
          SELECT MAX(date(x.exp, '-' || CAST(w.value AS INTEGER) || ' days'), ${today}) AS d
            FROM json_each(${rules}, '$.expiry.expiryWarnDays') w
            WHERE x.bal > 0 AND x.exp > ${today}
              AND NOT EXISTS (SELECT 1 FROM notification_keys k
                              WHERE k.client_id = x.id AND k.key = 'expiry_warning:' || x.aday || ':' || CAST(w.value AS INTEGER))
          UNION ALL
          SELECT MAX(x.exp, ${today}) WHERE x.bal > 0 OR json_extract(${rules}, '$.expiry.onExpiry') <> 'balance_only')) AS v
        UNION ALL
        -- sticky level: reminders before the reset and the reset day (only above the first tier)
        SELECT (SELECT MIN(d) FROM (
          SELECT MAX(date(x.lreset, '-' || CAST(w.value AS INTEGER) || ' days'), ${today}) AS d
            FROM json_each(${rules}, '$.levels.resetWarnDays') w
            WHERE x.lreset IS NOT NULL AND x.lreset > ${today}
          UNION ALL
          SELECT MAX(x.lreset, ${today}) WHERE x.lreset IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM notification_keys k WHERE k.client_id = x.id AND k.key = 'level_reset:' || x.lday)))
        UNION ALL
        -- birthday gift: one day early (29 Feb), never later than the engine; today if inside the window
        SELECT CASE WHEN date(x.bthis, '+' || CAST(json_extract(${bd}, '$.daysAfter') AS INTEGER) || ' days') >= ${today}
                    THEN MAX(date(x.bthis, '-' || (CAST(json_extract(${bd}, '$.daysBefore') AS INTEGER) + 1) || ' days'), ${today})
                    ELSE date(x.bthis, '+1 year', '-' || (CAST(json_extract(${bd}, '$.daysBefore') AS INTEGER) + 1) || ' days') END
          WHERE x.bthis IS NOT NULL AND json_extract(${bd}, '$.enabled') = 1 AND json_extract(${bd}, '$.type') <> 'points'
        UNION ALL
        SELECT (SELECT MIN(MAX(date(r.valid_until, '+1 day'), ${today})) FROM rewards r
          WHERE r.client_id = x.id AND r.status = 'available' AND r.valid_until IS NOT NULL AND r.id LIKE 'bday-%')
      ))
    FROM (SELECT c.id AS id, COALESCE(s.balance, 0) AS bal, ${anchorDay} AS aday,
            date(${anchorDay}, '+' || CAST(json_extract(${rules}, '$.expiry.expiryDays') AS INTEGER) || ' days') AS exp,
            ${levelDay} AS lday,
            CASE WHEN ${lvMode} = 'sticky' AND ${lvReset} > 0 AND s.level_id IS NOT NULL
                      AND s.level_id <> json_extract(${rules}, '$.levels.tiers[0].id') AND ${levelDay} IS NOT NULL
                 THEN date(${levelDay}, '+' || ${lvReset} || ' days') END AS lreset,
            CASE WHEN c.birthday IS NOT NULL AND length(c.birthday) = 10
                 THEN date(substr(${today}, 1, 4) || replace(substr(c.birthday, 5), '-02-29', '-02-28')) END AS bthis
          FROM clients c LEFT JOIN client_stats s ON s.client_id = c.id WHERE ${where.replace(/\bclients\./g, 'c.')}) x
    WHERE x.id = clients.id`;
}

/** Rows per statement when recomputing everybody (one batch, several rowid ranges). */
export const NEXT_CHECK_CHUNK = 5000;
