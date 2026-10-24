import { dayNumberFromKey, keyFromDayNumber } from '@honey/core';
import { dayBounds, STATS_COLUMNS, TOTAL_DAY, type StatsColumn, type StatsRow } from './statsDaily.js';

/**
 * Reading stats_daily (migration 0007, lib/statsDaily.ts). Every reader is one or two D1 round
 * trips over ≤ a few hundred day rows, independent of the number of purchases.
 */

type Row = Record<string, unknown>;

export const emptyStats = (day: string): StatsRow =>
  Object.assign({ day }, Object.fromEntries(STATS_COLUMNS.map((c) => [c, 0]))) as unknown as StatsRow;

export function toStatsRow(r: Row): StatsRow {
  const out = emptyStats(String(r.day));
  for (const c of STATS_COLUMNS) out[c] = Number(r[c] ?? 0);
  return out;
}

/** Day rows with day >= fromDay (all later days too: needed for the "last buyers" sums), plus '*' if asked. */
export function daysFromStmt(db: D1Database, fromDay: string, withTotal = false): D1PreparedStatement {
  return withTotal
    ? db.prepare(`SELECT * FROM stats_daily WHERE day >= ?1 OR day = '${TOTAL_DAY}'`).bind(fromDay)
    : db.prepare(`SELECT * FROM stats_daily WHERE day >= ?1 AND day <> '${TOTAL_DAY}'`).bind(fromDay);
}

export class DayTable {
  readonly byDay = new Map<string, StatsRow>();
  total: StatsRow = emptyStats(TOTAL_DAY);
  constructor(rows: Row[]) {
    for (const r of rows) {
      const s = toStatsRow(r);
      if (s.day === TOTAL_DAY) this.total = s;
      else this.byDay.set(s.day, s);
    }
  }
  /** Σ column over the days [from, to] (inclusive). */
  sum(col: StatsColumn, from: string, to: string): number {
    let n = 0;
    for (const [d, r] of this.byDay) if (d >= from && d <= to) n += r[col];
    return n;
  }
  sumAll(from: string, to: string): StatsRow {
    const out = emptyStats(`${from}..${to}`);
    for (const [d, r] of this.byDay) if (d >= from && d <= to) for (const c of STATS_COLUMNS) out[c] += r[c];
    return out;
  }
  /** Any purchase activity strictly after `day` (TEST_MODE clock moved back)? */
  activityAfter(day: string): boolean {
    for (const [d, r] of this.byDay) if (d > day && (r.last_buyers || r.purchases)) return true;
    return false;
  }
}

export interface Window {
  from: string;
  to: string;
}

/**
 * Distinct clients with an active purchase in each window [from, to] (Tashkent days).
 *  - window ending today (nothing bought after it): Σ last_buyers over d ≥ from — exact, from `days`
 *    (which must hold every row with day >= from);
 *  - past window: stats_buyers cache, computed once on a miss with one COUNT(DISTINCT) over the
 *    covering index (O(purchases in that window), then ~1 row read per view).
 * At most one extra round trip (cache lookup + misses in one batch).
 */
export async function distinctBuyers(db: D1Database, days: DayTable, windows: Window[], today: string, nowIso: string): Promise<number[]> {
  const out = new Array<number>(windows.length).fill(0);
  const past: number[] = [];
  windows.forEach((w, i) => {
    if (w.to >= today && !days.activityAfter(w.to)) out[i] = days.sum('last_buyers', w.from, '9999-12-31');
    else past.push(i);
  });
  if (!past.length) return out;
  const live = past.filter((i) => windows[i]!.to >= today); // not over yet (clock moved back): never cached
  const cached = past.filter((i) => windows[i]!.to < today);
  const spec = (ids: number[]) =>
    JSON.stringify(ids.map((i) => ({ f: windows[i]!.from, t: windows[i]!.to, s: dayBounds(windows[i]!.from)[0], e: dayBounds(windows[i]!.to)[1] })));
  const w = `(SELECT json_extract(value, '$.f') AS f, json_extract(value, '$.t') AS t, json_extract(value, '$.s') AS s, json_extract(value, '$.e') AS e FROM json_each(?1)) w`;
  const count = `(SELECT COUNT(DISTINCT client_id) FROM purchases WHERE status = 'active' AND created_at >= w.s AND created_at < w.e)`;
  // Two statements whatever the number of windows: fill the misses (the count runs only for them),
  // then read every window. A hit reads one primary-key row and writes nothing.
  const stmts: D1PreparedStatement[] = [];
  if (cached.length) {
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO stats_buyers (from_day, to_day, buyers, computed_at)
        SELECT w.f, w.t, ${count}, ?2 FROM ${w} WHERE NOT EXISTS (SELECT 1 FROM stats_buyers b WHERE b.from_day = w.f AND b.to_day = w.t)`).bind(spec(cached), nowIso),
      db.prepare(`SELECT b.from_day AS f, b.to_day AS t, b.buyers FROM ${w} JOIN stats_buyers b ON b.from_day = w.f AND b.to_day = w.t`).bind(spec(cached)),
    );
  }
  if (live.length) stmts.push(db.prepare(`SELECT w.f, w.t, ${count} AS buyers FROM ${w}`).bind(spec(live)));
  const res = await db.batch<Row>(stmts);
  const got = new Map<string, number>();
  for (const r of [...(cached.length ? res[1]!.results : []), ...(live.length ? res[res.length - 1]!.results : [])]) got.set(`${r.f}|${r.t}`, Number(r.buyers ?? 0));
  for (const i of past) out[i] = got.get(`${windows[i]!.from}|${windows[i]!.to}`) ?? 0;
  return out;
}

/** Drop cached windows nobody looks at any more (called by the daily job). */
export function pruneBuyersStmt(db: D1Database, nowIso: string): D1PreparedStatement {
  return db.prepare('DELETE FROM stats_buyers WHERE computed_at < ?1').bind(new Date(Date.parse(nowIso) - 30 * 86_400_000).toISOString());
}

/** Monday (YYYY-MM-DD) of the week containing `day`. */
export function mondayOf(day: string): string {
  const dn = dayNumberFromKey(day);
  const dow = (new Date(dn * 86_400_000).getUTCDay() + 6) % 7;
  return keyFromDayNumber(dn - dow);
}

export const addDays = (day: string, n: number) => keyFromDayNumber(dayNumberFromKey(day) + n);
