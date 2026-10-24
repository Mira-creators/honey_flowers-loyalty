import type {
  ClientActivity,
  ConsoleClientSort,
  ConsoleClientRow,
  ConsoleClientsPageDTO,
  ConsoleCohortsDTO,
  ConsoleMetrics,
  ConsoleOpKind,
  ConsoleOperationRow,
  ConsoleOperationsPageDTO,
  ConsoleOpsTotals,
  ConsoleOverviewDTO,
  Granularity,
} from '@honey/contracts';
import { CONSOLE_OP_KINDS } from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, monthsBeforeKey, type LoyaltyRules } from '@honey/core';
import { tashkentDayStartIso } from '../lib/dto.js';
import { DayTable, daysFromStmt, distinctBuyers, type Window } from '../lib/statsRead.js';

/**
 * SQL for the owner console. Every endpoint is ONE D1 round trip (a single statement or one
 * batch), aggregates run inside SQLite (never row-by-row in the Worker, which has 10 ms of CPU),
 * every list has a LIMIT and keyset pagination. Times are stored as ISO UTC strings, so a
 * Tashkent day [D 00:00, D+1 00:00) is the string range [tashkentDayStartIso(D), …(D+1)).
 */

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Numbered bind parameters (?1, ?2 …); the same named value is bound once and reused. */
export class Params {
  readonly values: unknown[] = [];
  private named = new Map<string, string>();
  add(v: unknown): string {
    this.values.push(v);
    return `?${this.values.length}`;
  }
  get(name: string, v: unknown): string {
    let ph = this.named.get(name);
    if (!ph) {
      ph = this.add(v);
      this.named.set(name, ph);
    }
    return ph;
  }
}

// ------------------------------------------------------------------ periods

export interface Period {
  from: string; // YYYY-MM-DD inclusive
  to: string;
  days: number;
  startIso: string; // instant of from 00:00 Tashkent
  endIso: string; // instant of (to + 1 day) 00:00 Tashkent (exclusive)
}

export function period(from: string, to: string): Period {
  const a = dayNumberFromKey(from);
  const b = dayNumberFromKey(to);
  return { from, to, days: b - a + 1, startIso: tashkentDayStartIso(from), endIso: tashkentDayStartIso(keyFromDayNumber(b + 1)) };
}

/** The period of the same length right before `p`. */
export function previousPeriod(p: Period): Period {
  const a = dayNumberFromKey(p.from);
  return period(keyFromDayNumber(a - p.days), keyFromDayNumber(a - 1));
}

export function granularityFor(days: number): Granularity {
  return days <= 62 ? 'day' : days <= 400 ? 'week' : 'month';
}

/** SQL expression of the Tashkent-local bucket start (YYYY-MM-DD) of an ISO column. */
function bucketExpr(col: string, g: Granularity): string {
  if (g === 'day') return `date(${col}, '+5 hours')`;
  if (g === 'week') return `date(${col}, '+5 hours', '-6 days', 'weekday 1')`;
  return `strftime('%Y-%m-01', ${col}, '+5 hours')`;
}

/** Every bucket start of the period (so the chart has no gaps). */
export function bucketsOf(p: Period, g: Granularity): string[] {
  const out: string[] = [];
  const first = dayNumberFromKey(p.from);
  const last = dayNumberFromKey(p.to);
  if (g === 'day') for (let d = first; d <= last; d++) out.push(keyFromDayNumber(d));
  else if (g === 'week') {
    const dow = (new Date(first * 86_400_000).getUTCDay() + 6) % 7;
    for (let d = first - dow; d <= last; d += 7) out.push(keyFromDayNumber(d));
  } else {
    let [y, m] = p.from.split('-').map(Number) as [number, number];
    const end = p.to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > end) break;
      out.push(`${key}-01`);
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ overview

/**
 * Overview from the daily aggregates (stats_daily, migration 0007): one query over the day rows of
 * both periods (+ later days for the "last buyers" sums) and one batch for distinct buyers of past
 * windows (stats_buyers cache: computed once per window, then 1 row). ~2 × period days rows read.
 */
export async function overview(db: D1Database, cur: Period, today: string, nowIso: string): Promise<ConsoleOverviewDTO> {
  const prev = previousPeriod(cur);
  const g = granularityFor(cur.days);
  const days = new DayTable((await daysFromStmt(db, prev.from).all<Row>()).results);
  const buckets = bucketsOf(cur, g);
  const bucketEnd = (b: string, i: number) => {
    const next = buckets[i + 1];
    const end = next ? keyFromDayNumber(dayNumberFromKey(next) - 1) : cur.to;
    return end > cur.to ? cur.to : end;
  };
  // Distinct buyers: the two periods, and every bucket of the chart (a day bucket is a stored column).
  const windows: Window[] = [{ from: cur.from, to: cur.to }, { from: prev.from, to: prev.to }];
  if (g !== 'day') buckets.forEach((b, i) => windows.push({ from: b < cur.from ? cur.from : b, to: bucketEnd(b, i) }));
  const distinct = await distinctBuyers(db, days, windows, today, nowIso);
  const metrics = (p: Period, buyers: number): ConsoleMetrics => {
    const r = days.sumAll(p.from, p.to);
    const repeat = r.purchases - r.first_purchases;
    return {
      revenue: r.revenue,
      purchases: r.purchases,
      avgCheck: r.purchases ? Math.round(r.revenue / r.purchases) : 0,
      activeClients: buyers,
      newClients: r.new_clients,
      repeatPurchases: repeat,
      repeatShare: r.purchases ? repeat / r.purchases : 0,
      honeyAccrued: r.honey_accrued,
      honeyRedeemed: r.honey_redeemed,
      honeyExpired: r.honey_expired,
      giftsUnlocked: r.gifts_unlocked,
      giftsUsed: r.gifts_used,
    };
  };
  return {
    from: cur.from,
    to: cur.to,
    prevFrom: prev.from,
    prevTo: prev.to,
    granularity: g,
    current: metrics(cur, distinct[0]!),
    previous: metrics(prev, distinct[1]!),
    series: buckets.map((b, i) => {
      const from = b < cur.from ? cur.from : b;
      const to = g === 'day' ? b : bucketEnd(b, i);
      return {
        bucket: b,
        purchases: days.sum('purchases', from, to),
        revenue: days.sum('revenue', from, to),
        buyers: g === 'day' ? days.byDay.get(b)?.buyers ?? 0 : distinct[2 + i]!,
      };
    }),
  };
}

// ------------------------------------------------------------------ clients

export interface ClientQuery {
  period: Period | null; // purchase aggregates over this period; null = all time
  level?: string | null;
  minCount?: number | null;
  maxCount?: number | null;
  minTotal?: number | null;
  maxTotal?: number | null;
  minAvg?: number | null;
  maxAvg?: number | null;
  activity?: ClientActivity | null;
  bmonth?: number | null;
  registered?: Period | null;
  gift?: boolean;
  linked?: 'tg' | 'pending' | null;
  q?: string | null;
  sort: ConsoleClientSort;
  dir: 'asc' | 'desc';
  cursor?: { v: string | number; id: string } | null;
  limit: number;
}

const SORT_SQL: Record<ConsoleClientSort, string> = {
  name: `COALESCE(x.name, '')`,
  registered: 'x.created_at',
  count: 'x.n',
  total: 'x.total',
  avg: 'x.avg',
  last: 'x.last_at',
  balance: 'x.balance',
  level: 'x.lvl',
};

/** Single-quoted SQL string literal (rules tier ids are validated, this is belt and braces). */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * Owner console client list, on top of client_stats (migration 0004: balance, purchases count,
 * last purchase, level, gifts — kept by saveOutcome in the same transaction as the facts).
 *
 * Purchases are read only when the view needs sums: a period is chosen, or the list is sorted
 * or filtered by total / average check. Then each client's purchases come from the covering
 * index purchases_client_cover (status, client_id, created_at, amount), restricted to the
 * period. The default view (all time, sorted by last purchase / name / balance …) reads only
 * clients + client_stats, plus the order total of the page rows (≤ limit index range scans).
 */
export async function clientsPage(db: D1Database, rules: LoyaltyRules, nowIso: string, f: ClientQuery): Promise<ConsoleClientsPageDTO> {
  const P = new Params();
  const tiers = rules.levels.tiers;
  const needSums = !!f.period || f.sort === 'total' || f.sort === 'avg' || f.minTotal != null || f.maxTotal != null || f.minAvg != null || f.maxAvg != null;
  const lvl = `CASE s.level_id ${tiers.map((t, i) => `WHEN ${lit(t.id)} THEN ${i}`).join(' ')} ELSE 0 END`;

  const where: string[] = [];
  if (f.bmonth) where.push(`substr(c.birthday, 6, 2) = ${P.add(String(f.bmonth).padStart(2, '0'))}`);
  if (f.registered) where.push(`c.created_at >= ${P.add(f.registered.startIso)} AND c.created_at < ${P.add(f.registered.endIso)}`);
  if (f.gift) where.push('COALESCE(s.gifts_available, 0) > 0');
  // "In Telegram" = everyone except unclaimed imports (TEST_MODE demo clients act as real clients).
  if (f.linked === 'tg') where.push('NOT (c.telegram_id < 0 AND EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id))');
  // Imported from the old base and not claimed yet (demo clients have negative ids too, but are not imports).
  if (f.linked === 'pending') where.push('c.telegram_id < 0 AND EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id)');
  if (f.q) {
    const q = f.q.trim();
    const digits = q.replace(/\D/g, '');
    const parts = [`instr(lower(COALESCE(c.name, '')), lower(${P.add(q)})) > 0`, `c.code = upper(${P.add(q.replace(/\s/g, ''))})`];
    if (digits.length >= 3) parts.push(`instr(COALESCE(c.phone, ''), ${P.add(digits)}) > 0`);
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.activity) {
    const nowMs = Date.parse(nowIso);
    const d30 = new Date(nowMs - 30 * 86_400_000).toISOString();
    const d60 = new Date(nowMs - 60 * 86_400_000).toISOString();
    const last = `COALESCE(s.last_purchase_at, '')`;
    if (f.activity === 'active') where.push(`${last} >= ${P.add(d30)}`);
    if (f.activity === 'sleeping') where.push(`${last} >= ${P.add(d60)} AND ${last} < ${P.add(d30)}`);
    if (f.activity === 'gone') where.push(`${last} <> '' AND ${last} < ${P.add(d60)}`);
    if (f.activity === 'never') where.push(`${last} = ''`);
  }
  if (f.level) {
    const idx = tiers.findIndex((t) => t.id === f.level);
    where.push(`(${lvl}) = ${idx < 0 ? -99 : idx}`);
  }

  let base: string;
  if (needSums) {
    const pf = P.add(f.period?.startIso ?? '');
    const pt = P.add(f.period?.endIso ?? '9999');
    base = `
      SELECT c.id, c.name, c.phone, c.code, c.birthday, c.created_at, c.telegram_id, (c.telegram_id < 0 AND EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id)) AS pending,
        COUNT(p.client_id) AS n, COALESCE(SUM(p.amount), 0) AS total,
        CASE WHEN COUNT(p.client_id) > 0 THEN CAST(ROUND(1.0 * SUM(p.amount) / COUNT(p.client_id)) AS INTEGER) ELSE 0 END AS avg,
        COALESCE(s.last_purchase_at, '') AS last_at, COALESCE(s.balance, 0) AS balance, COALESCE(s.gifts_available, 0) AS gifts, ${lvl} AS lvl
      FROM clients c
      LEFT JOIN client_stats s ON s.client_id = c.id
      LEFT JOIN purchases p ON p.status = 'active' AND p.client_id = c.id AND p.created_at >= ${pf} AND p.created_at < ${pt}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY c.id`;
  } else {
    base = `
      SELECT c.id, c.name, c.phone, c.code, c.birthday, c.created_at, c.telegram_id, (c.telegram_id < 0 AND EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id)) AS pending,
        COALESCE(s.purchases_count, 0) AS n, NULL AS total, NULL AS avg,
        COALESCE(s.last_purchase_at, '') AS last_at, COALESCE(s.balance, 0) AS balance, COALESCE(s.gifts_available, 0) AS gifts, ${lvl} AS lvl
      FROM clients c LEFT JOIN client_stats s ON s.client_id = c.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  }

  const agg: string[] = [];
  const range = (col: string, min?: number | null, max?: number | null) => {
    if (min != null) agg.push(`${col} >= ${P.add(min)}`);
    if (max != null) agg.push(`${col} <= ${P.add(max)}`);
  };
  range('b.n', f.minCount, f.maxCount);
  range('b.total', f.minTotal, f.maxTotal);
  range('b.avg', f.minAvg, f.maxAvg);

  const sortSql = SORT_SQL[f.sort];
  const cmp = f.dir === 'asc' ? '>' : '<';
  const keyset = f.cursor
    ? `WHERE (${sortSql} ${cmp} ${P.add(f.cursor.v)} OR (${sortSql} = ${P.get('cv', f.cursor.v)} AND x.id > ${P.add(f.cursor.id)}))`
    : '';
  // All-time order total of the page rows only.
  const pageTotal = `(SELECT COALESCE(SUM(q.amount), 0) FROM purchases q WHERE q.status = 'active' AND q.client_id = x.id)`;
  const sql = `
    WITH b AS (${base})
    SELECT x.id, x.name, x.phone, x.code, x.birthday, x.created_at, x.telegram_id, x.pending, x.n, x.last_at, x.lvl, x.balance, x.gifts,
      ${needSums ? 'x.total, x.avg' : `${pageTotal} AS total, NULL AS avg`},
      x.matched, x.matched_total, x.matched_n, ${sortSql} AS sort_v
    FROM (
      SELECT b.*, COUNT(*) OVER () AS matched, ${needSums ? 'COALESCE(SUM(b.total) OVER (), 0)' : 'NULL'} AS matched_total,
        COALESCE(SUM(b.n) OVER (), 0) AS matched_n
      FROM b ${agg.length ? `WHERE ${agg.join(' AND ')}` : ''}
    ) x
    ${keyset}
    ORDER BY ${sortSql} ${f.dir === 'asc' ? 'ASC' : 'DESC'}, x.id ASC
    LIMIT ${P.add(f.limit + 1)}`;
  const { results } = await db.prepare(sql).bind(...P.values).all<Row>();
  const more = results.length > f.limit;
  const page = more ? results.slice(0, f.limit) : results;
  const rows: ConsoleClientRow[] = page.map((r) => {
    const t = tiers[Math.max(0, Math.min(tiers.length - 1, n(r.lvl)))]!;
    const purchases = n(r.n);
    const total = n(r.total);
    return {
      id: String(r.id),
      name: s(r.name) ?? '',
      phone: s(r.phone),
      code: String(r.code),
      birthday: s(r.birthday),
      registeredAt: String(r.created_at),
      // Only an imported client nobody has claimed yet is "not in Telegram" (demo clients act as real ones).
      linked: n(r.pending) !== 1,
      level: t.id,
      levelName: t.title,
      purchases,
      total,
      avg: r.avg === null || r.avg === undefined ? (purchases ? Math.round(total / purchases) : 0) : n(r.avg),
      lastPurchaseAt: r.last_at ? String(r.last_at) : null,
      balance: n(r.balance),
      hasGift: n(r.gifts) > 0,
    };
  });
  const last = page[page.length - 1];
  const first = results[0];
  return {
    rows,
    // With a cursor the window counts are still over all matches (the keyset filter is applied outside).
    matched: first ? n(first.matched) : f.cursor ? -1 : 0,
    matchedTotal: !needSums ? null : first ? n(first.matched_total) : 0,
    matchedPurchases: first ? n(first.matched_n) : 0,
    nextCursor: more && last ? encodeCursor({ v: last.sort_v as string | number, id: String(last.id) }) : null,
  };
}

// ------------------------------------------------------------------ cursors

export function encodeCursor(c: Record<string, unknown>): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor<T>(raw: string | undefined | null, check: (v: unknown) => v is T): T | null {
  if (!raw) return null;
  try {
    const b = raw.replace(/-/g, '+').replace(/_/g, '/');
    const v = JSON.parse(decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4)))));
    return check(v) ? v : null;
  } catch {
    return null;
  }
}

export const isClientCursor = (v: unknown): v is { v: string | number; id: string } =>
  !!v && typeof v === 'object' && (typeof (v as { v: unknown }).v === 'string' || typeof (v as { v: unknown }).v === 'number') && typeof (v as { id: unknown }).id === 'string';

export const isOpsCursor = (v: unknown): v is { at: string; id: string } =>
  !!v && typeof v === 'object' && typeof (v as { at: unknown }).at === 'string' && typeof (v as { id: unknown }).id === 'string';

// ------------------------------------------------------------------ operations

export interface OpsQuery {
  period: Period;
  kinds: ConsoleOpKind[];
  staff?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  cursor?: { at: string; id: string } | null;
  limit: number;
  totals: boolean;
}

const LEDGER_KIND: Partial<Record<ConsoleOpKind, string>> = { redeem: 'redeem', adjust: 'manual_adjust', welcome: 'welcome', expire: 'expire' };

function opsBranches(q: OpsQuery, P: Params, withKeyset: boolean): { purchase: string[]; reversal: string[]; ledger: string[]; ledgerTypes: string[]; gift: string[] } {
  const f = P.get('from', q.period.startIso);
  const t = P.get('to', q.period.endIso);
  const amountFilter = q.minAmount != null || q.maxAmount != null;
  const kinds = new Set(amountFilter ? q.kinds.filter((k) => k === 'purchase' || k === 'reversal') : q.kinds);
  const staff = q.staff ? P.get('staff', q.staff) : null;
  const amount = (col: string) =>
    [q.minAmount != null ? `${col} >= ${P.get('min', q.minAmount)}` : null, q.maxAmount != null ? `${col} <= ${P.get('max', q.maxAmount)}` : null].filter(Boolean) as string[];
  const ks = (atCol: string, idExpr: string) =>
    withKeyset && q.cursor ? [`(${atCol} < ${P.get('ca', q.cursor.at)} OR (${atCol} = ${P.get('ca', q.cursor.at)} AND ${idExpr} < ${P.get('ci', q.cursor.id)}))`] : [];

  const out = { purchase: [] as string[], reversal: [] as string[], ledger: [] as string[], ledgerTypes: [] as string[], gift: [] as string[] };
  if (kinds.has('purchase')) out.purchase = [`p.created_at >= ${f}`, `p.created_at < ${t}`, ...(staff ? [`p.staff_id = ${staff}`] : []), ...amount('p.amount'), ...ks('p.created_at', 'p.id')];
  if (kinds.has('reversal')) {
    out.reversal = [`p.status = 'reversed'`, `p.reversed_at >= ${f}`, `p.reversed_at < ${t}`, ...(staff ? [`p.reversed_by = ${staff}`] : []), ...amount('p.amount'), ...ks('p.reversed_at', `('rev-' || p.id)`)];
  }
  out.ledgerTypes = [...kinds].map((k) => LEDGER_KIND[k]).filter((x): x is string => !!x);
  if (out.ledgerTypes.length) {
    out.ledger = [`l.purchase_id IS NULL`, `l.type IN (${out.ledgerTypes.map(lit).join(', ')})`, `l.created_at >= ${f}`, `l.created_at < ${t}`, ...(staff ? [`l.staff_id = ${staff}`] : []), ...ks('l.created_at', 'l.id')];
  }
  if (kinds.has('gift') && !staff) {
    out.gift = [`r.status = 'used'`, `r.used_in_purchase IS NULL`, `r.used_at >= ${f}`, `r.used_at < ${t}`, ...ks('r.used_at', `('gift-' || r.id)`)];
  }
  return out;
}

export async function operationsPage(db: D1Database, q: OpsQuery): Promise<ConsoleOperationsPageDTO> {
  const P = new Params();
  const br = opsBranches(q, P, true);
  const lim = P.get('lim', q.limit + 1);
  const parts: string[] = [];
  if (br.purchase.length) {
    parts.push(`SELECT * FROM (SELECT p.id AS id, p.created_at AS at, 'purchase' AS kind, p.client_id AS client_id, p.staff_id AS staff_id, p.amount AS amount,
      p.points_redeemed AS redeemed, p.status AS status, NULL AS reason, p.id AS pid, 0 AS lpoints
      FROM purchases p WHERE ${br.purchase.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ${lim})`);
  }
  if (br.reversal.length) {
    parts.push(`SELECT * FROM (SELECT 'rev-' || p.id AS id, p.reversed_at AS at, 'reversal' AS kind, p.client_id AS client_id, p.reversed_by AS staff_id, p.amount AS amount,
      0 AS redeemed, p.status AS status, p.reversed_reason AS reason, p.id AS pid, 0 AS lpoints
      FROM purchases p WHERE ${br.reversal.join(' AND ')} ORDER BY p.reversed_at DESC, p.id DESC LIMIT ${lim})`);
  }
  if (br.ledger.length) {
    parts.push(`SELECT * FROM (SELECT l.id AS id, l.created_at AS at, CASE l.type WHEN 'manual_adjust' THEN 'adjust' ELSE l.type END AS kind, l.client_id AS client_id,
      l.staff_id AS staff_id, NULL AS amount, 0 AS redeemed, NULL AS status, l.reason AS reason, NULL AS pid, l.amount AS lpoints
      FROM points_ledger l WHERE ${br.ledger.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ${lim})`);
  }
  if (br.gift.length) {
    parts.push(`SELECT * FROM (SELECT 'gift-' || r.id AS id, r.used_at AS at, 'gift' AS kind, r.client_id AS client_id, NULL AS staff_id, NULL AS amount,
      0 AS redeemed, NULL AS status, r.title AS reason, NULL AS pid, 0 AS lpoints
      FROM rewards r WHERE ${br.gift.join(' AND ')} ORDER BY r.used_at DESC, r.id DESC LIMIT ${lim})`);
  }
  if (!parts.length) return { rows: [], nextCursor: null, totals: q.totals ? emptyTotals() : null };

  const pageSql = `
    SELECT u.*, c.name AS client_name, c.phone AS client_phone,
      CASE u.kind
        WHEN 'purchase' THEN (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = u.pid AND l.type IN ('accrual', 'redeem'))
        WHEN 'reversal' THEN (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = u.pid AND l.type = 'reversal')
        ELSE u.lpoints END AS points,
      COALESCE(s.name, CASE WHEN u.staff_id LIKE 'tg:%' THEN COALESCE(t.first_name, 'Тестер') || ' (тест)' END) AS staff_name
    FROM (${parts.join(' UNION ALL ')}) u
    LEFT JOIN clients c ON c.id = u.client_id
    LEFT JOIN staff s ON s.id = u.staff_id
    LEFT JOIN tg_users t ON u.staff_id LIKE 'tg:%' AND t.telegram_id = CAST(substr(u.staff_id, 4) AS INTEGER)
    ORDER BY u.at DESC, u.id DESC
    LIMIT ${lim}`;
  const stmts = [db.prepare(pageSql).bind(...P.values)];
  if (q.totals) {
    const T = new Params();
    const tb = opsBranches(q, T, false);
    const tparts: string[] = [];
    if (tb.purchase.length) {
      tparts.push(`SELECT 'purchase' AS kind, COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS amount,
        (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.type IN ('accrual', 'redeem') AND l.purchase_id IN (SELECT p.id FROM purchases p WHERE ${tb.purchase.join(' AND ')})) AS points
        FROM purchases p WHERE ${tb.purchase.join(' AND ')}`);
    }
    if (tb.reversal.length) {
      tparts.push(`SELECT 'reversal', COUNT(*), COALESCE(SUM(p.amount), 0),
        (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.type = 'reversal' AND l.purchase_id IN (SELECT p.id FROM purchases p WHERE ${tb.reversal.join(' AND ')}))
        FROM purchases p WHERE ${tb.reversal.join(' AND ')}`);
    }
    if (tb.ledger.length) {
      tparts.push(`SELECT CASE l.type WHEN 'manual_adjust' THEN 'adjust' ELSE l.type END, COUNT(*), 0, COALESCE(SUM(l.amount), 0)
        FROM points_ledger l WHERE ${tb.ledger.join(' AND ')} GROUP BY l.type`);
    }
    if (tb.gift.length) tparts.push(`SELECT 'gift', COUNT(*), 0, 0 FROM rewards r WHERE ${tb.gift.join(' AND ')}`);
    stmts.push(db.prepare(tparts.join(' UNION ALL ')).bind(...T.values));
  }
  const [page, totalsRes] = await db.batch<Row>(stmts);
  const results = page!.results;
  const more = results.length > q.limit;
  const rows: ConsoleOperationRow[] = (more ? results.slice(0, q.limit) : results).map((r) => ({
    id: String(r.id),
    at: String(r.at),
    kind: String(r.kind) as ConsoleOpKind,
    clientId: String(r.client_id),
    clientName: s(r.client_name) ?? '',
    clientPhone: s(r.client_phone),
    staffId: s(r.staff_id),
    staffName: s(r.staff_name),
    amount: r.amount === null || r.amount === undefined ? null : n(r.amount),
    points: n(r.points),
    redeemed: n(r.redeemed),
    status: (s(r.status) as 'active' | 'reversed' | null) ?? null,
    reason: s(r.reason),
  }));
  let totals: ConsoleOpsTotals | null = null;
  if (q.totals) {
    totals = emptyTotals();
    for (const r of totalsRes?.results ?? []) {
      const k = String(r.kind) as ConsoleOpKind;
      if (!totals.byKind[k]) continue;
      totals.byKind[k] = { count: n(r.n), amount: n(r.amount), points: n(r.points) };
      totals.count += n(r.n);
    }
  }
  const last = rows[rows.length - 1];
  return { rows, nextCursor: more && last ? encodeCursor({ at: last.at, id: last.id }) : null, totals };
}

function emptyTotals(): ConsoleOpsTotals {
  return { count: 0, byKind: Object.fromEntries(CONSOLE_OP_KINDS.map((k) => [k, { count: 0, amount: 0, points: 0 }])) as ConsoleOpsTotals['byKind'] };
}

// ------------------------------------------------------------------ cohorts

/**
 * Retention by month of the first purchase: share of clients who came back for a second
 * purchase on a LATER Tashkent day within 30 / 60 / 90 days. Only clients whose N-day window
 * has fully passed are counted for N (eN), so young cohorts are not understated.
 */
export async function cohorts(db: D1Database, nowIso: string, months: number): Promise<ConsoleCohortsDTO> {
  const now = new Date(nowIso);
  const firstMonth = monthsBeforeKey(now, months - 1, 'Asia/Tashkent').slice(0, 7);
  const since = tashkentDayStartIso(`${firstMonth}-01`);
  const { results } = await db
    .prepare(
      `WITH f AS (
         SELECT client_id, MIN(created_at) AS first_at FROM purchases WHERE status = 'active' GROUP BY client_id
       ),
       s AS (
         SELECT f.first_at,
           julianday(?2) - julianday(f.first_at) AS age,
           julianday((SELECT MIN(q.created_at) FROM purchases q
              WHERE q.client_id = f.client_id AND q.status = 'active'
                AND q.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', date(f.first_at, '+5 hours', '+1 day'), '-5 hours'))) - julianday(f.first_at) AS gap
         FROM f WHERE f.first_at >= ?1 AND f.first_at <= ?2
       )
       SELECT strftime('%Y-%m', first_at, '+5 hours') AS m, COUNT(*) AS n,
         SUM(age >= 30) AS e30, SUM(age >= 30 AND gap <= 30) AS r30,
         SUM(age >= 60) AS e60, SUM(age >= 60 AND gap <= 60) AS r60,
         SUM(age >= 90) AS e90, SUM(age >= 90 AND gap <= 90) AS r90
       FROM s GROUP BY m ORDER BY m`,
    )
    .bind(since, nowIso)
    .all<Row>();
  return {
    cohorts: results.map((r) => ({
      month: String(r.m),
      clients: n(r.n),
      r30: n(r.r30),
      e30: n(r.e30),
      r60: n(r.r60),
      e60: n(r.e60),
      r90: n(r.r90),
      e90: n(r.e90),
    })),
  };
}
