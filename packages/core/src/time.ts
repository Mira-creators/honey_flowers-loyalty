/**
 * Calendar helpers. All "day" logic (daily cell limit, expiry, level window)
 * works on LOCAL calendar dates in the rules' time zone (Asia/Tashkent),
 * never on UTC dates. Nothing here reads the clock: callers pass `now`.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Local calendar date as 'YYYY-MM-DD'. */
export function localDateKey(date: Date, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Days since 1970-01-01 of the local calendar date (for day differences). */
export function localDayNumber(date: Date, timeZone: string): number {
  return dayNumberFromKey(localDateKey(date, timeZone));
}

export function dayNumberFromKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function keyFromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` in the given zone (can be negative). */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  return localDayNumber(to, timeZone) - localDayNumber(from, timeZone);
}

/**
 * Local date key N calendar months before `date` (day clamped to month end),
 * e.g. 2026-05-31 minus 3 months = 2026-02-28.
 */
export function monthsBeforeKey(date: Date, months: number, timeZone: string): string {
  const [y, m, d] = localDateKey(date, timeZone).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}
