import type { LedgerEntry } from '@honey/core';

/**
 * Daily aggregates for the owner's statistics (migration 0007, table stats_daily): one row per
 * Tashkent calendar day plus the all-time row day = '*'. Owner stats, the bot's /stats and the
 * console overview read ≤ a few hundred of these rows instead of every purchase / ledger row.
 *
 * Maintained INCREMENTALLY in the same db.batch as the facts (D1Repository.saveOutcome,
 * createClient), so a rolled-back write rolls its aggregates back too:
 *   - ledger rows are append-only → their day deltas are added from the outcome (JS);
 *   - purchase and reward rows can change status → the statement batch subtracts the row's
 *     contribution BEFORE the write and adds it back AFTER (SQL reading that one row), so a
 *     reversal / gift hand-out / revoke is exact whatever the previous status was;
 *   - per-client shapes (distinct buyers of a day, the client's first / last / second-last
 *     purchase day) are recomputed the same way, with index lookups on purchases_client_cover.
 * Bulk writers (migration backfill, demo seed / clear, base import / undo, deleting a client)
 * add or subtract the contribution of a SET of clients with one set-based statement
 * (contributionStmts). qa/lib/invariants.mjs recomputes the whole table from the raw rows.
 *
 * Columns (by the day of the instant in Asia/Tashkent, UTC+5 without DST):
 *   purchases, revenue        active purchases, by creation day
 *   first_purchases           active purchases made at their client's earliest active instant;
 *                             repeat purchases of a day = purchases − first_purchases
 *   buyers                    distinct clients with an active purchase that day
 *   last_buyers, prev_buyers  clients whose last / second-to-last active purchase is that day:
 *                             distinct buyers (and repeaters) of a window ending today = Σ over d ≥ start
 *   new_clients               registered that day, not created by a base import (demo counts)
 *   imported_clients          created by a base import that day
 *   honey_accrued / _redeemed / _expired   the owner-stats classification (reversals net into the
 *                             side they undo); honey_imported = starting мёд of a base import
 *                             (NOT "issued"); outstanding = accrued − redeemed − expired + imported
 *   gifts_unlocked            gifts not revoked, by unlock day; gifts_used: used gifts, by use day
 *   reversals, reversed_amount purchases reversed that day (by reversal day)
 * In the '*' row the distinct columns are plain sums (buyers = purchase-days, last_buyers =
 * clients that ever bought, prev_buyers = clients with ≥ 2 purchases).
 */

export const TOTAL_DAY = '*';

export const STATS_COLUMNS = [
  'purchases', 'revenue', 'first_purchases', 'buyers', 'last_buyers', 'prev_buyers', 'new_clients', 'imported_clients',
  'honey_accrued', 'honey_redeemed', 'honey_expired', 'honey_imported', 'gifts_unlocked', 'gifts_used', 'reversals', 'reversed_amount',
] as const;
export type StatsColumn = (typeof STATS_COLUMNS)[number];
export type StatsRow = { day: string } & Record<StatsColumn, number>;

/** Tashkent calendar day (YYYY-MM-DD) of an instant. */
export function tashkentDay(d: Date | string): string {
  const ms = typeof d === 'string' ? Date.parse(d) : d.getTime();
  return new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);
}

/** [start, end) ISO instants of a Tashkent day. */
export function dayBounds(day: string): [string, string] {
  const start = Date.parse(`${day}T00:00:00+05:00`);
  return [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()];
}

/** SQL: day of an ISO column. */
const dayOf = (col: string) => `date(${col}, '+5 hours')`;

/** Ledger classification (shared with qa/lib/invariants.mjs and the console's ledger totals). */
export function ledgerClass(e: Pick<LedgerEntry, 'type' | 'amount' | 'idempotencyKey'>): { col: StatsColumn; amount: number } | null {
  const imported = (e.idempotencyKey ?? '').startsWith('import:');
  switch (e.type) {
    case 'accrual':
    case 'welcome':
      return { col: 'honey_accrued', amount: e.amount };
    case 'redeem':
      return { col: 'honey_redeemed', amount: -e.amount };
    case 'expire':
      return { col: 'honey_expired', amount: -e.amount };
    case 'reversal':
      return e.amount < 0 ? { col: 'honey_accrued', amount: e.amount } : { col: 'honey_redeemed', amount: -e.amount };
    case 'manual_adjust':
      if (e.amount > 0) return imported ? { col: 'honey_imported', amount: e.amount } : { col: 'honey_accrued', amount: e.amount };
      return { col: 'honey_redeemed', amount: -e.amount };
  }
  return null;
}

/** SQL CASE expressions of the ledger classification over a points_ledger alias `l`. */
const LEDGER_SQL = {
  honey_accrued: `CASE WHEN l.type IN ('accrual', 'welcome') OR (l.type = 'manual_adjust' AND l.amount > 0 AND COALESCE(l.idempotency_key, '') NOT LIKE 'import:%') OR (l.type = 'reversal' AND l.amount < 0) THEN l.amount ELSE 0 END`,
  honey_redeemed: `CASE WHEN l.type = 'redeem' OR (l.type = 'manual_adjust' AND l.amount < 0) OR (l.type = 'reversal' AND l.amount > 0) THEN -l.amount ELSE 0 END`,
  honey_expired: `CASE WHEN l.type = 'expire' THEN -l.amount ELSE 0 END`,
  honey_imported: `CASE WHEN l.type = 'manual_adjust' AND l.amount > 0 AND COALESCE(l.idempotency_key, '') LIKE 'import:%' THEN l.amount ELSE 0 END`,
};

const upsertTail = (sign: 1 | -1) =>
  `ON CONFLICT(day) DO UPDATE SET ${STATS_COLUMNS.map((c) => `${c} = ${c} ${sign > 0 ? '+' : '-'} excluded.${c}`).join(', ')}`;

/**
 * Add `deltas` to the row of `day` and to the '*' row. One statement, no reads.
 * Zero-only deltas produce no statement.
 */
export function addStmt(db: D1Database, day: string, deltas: Partial<Record<StatsColumn, number>>): D1PreparedStatement | null {
  const cols = STATS_COLUMNS.filter((c) => (deltas[c] ?? 0) !== 0);
  if (!cols.length) return null;
  const vals = cols.map((c) => deltas[c]!);
  const ph = `(?, ${cols.map(() => '?').join(', ')})`;
  return db
    .prepare(
      `INSERT INTO stats_daily (day, ${cols.join(', ')}) VALUES ${ph}, ${ph}
       ON CONFLICT(day) DO UPDATE SET ${cols.map((c) => `${c} = ${c} + excluded.${c}`).join(', ')}`,
    )
    .bind(day, ...vals, TOTAL_DAY, ...vals);
}

/** Ledger rows of an outcome → per-day deltas (one statement per day touched, usually one). */
export function ledgerStmts(db: D1Database, entries: readonly LedgerEntry[]): D1PreparedStatement[] {
  const byDay = new Map<string, Partial<Record<StatsColumn, number>>>();
  for (const e of entries) {
    const k = ledgerClass(e);
    if (!k) continue;
    const day = tashkentDay(e.createdAt);
    const d = byDay.get(day) ?? {};
    d[k.col] = (d[k.col] ?? 0) + k.amount;
    byDay.set(day, d);
  }
  return [...byDay].map(([day, d]) => addStmt(db, day, d)).filter((s): s is D1PreparedStatement => !!s);
}

/**
 * Contribution of single rows, read from the database at the moment the statement runs:
 * placed before a write with sign −1 and after it with sign +1, the net effect is exactly the
 * change the write made to these rows (a row that does not exist contributes nothing).
 */
function rowsContribution(db: D1Database, sign: 1 | -1, terms: string[], binds: unknown[], guard = 'true'): D1PreparedStatement[] {
  const sums = STATS_COLUMNS.map((c) => `COALESCE(SUM(${c}), 0)`).join(', ');
  const out: D1PreparedStatement[] = [];
  // D1 allows at most 5 terms in a compound SELECT: split the UNION ALL into groups.
  for (let i = 0; i < terms.length; i += MAX_COMPOUND) {
    const inner = terms.slice(i, i + MAX_COMPOUND).join('\n UNION ALL ');
    const select = (dayExpr: string, group: string) => `SELECT ${dayExpr}, ${sums} FROM (${inner}) WHERE ${guard} ${group}`;
    // D1 wants exactly as many values as the highest ?N the statement uses.
    const used = Math.max(0, ...[...`${inner} ${guard}`.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
    const args = binds.slice(0, used);
    // Rows with all-zero sums are written too (cheap: these are tiny statements) — keeps the SQL simple.
    out.push(
      db.prepare(`INSERT INTO stats_daily (day, ${STATS_COLUMNS.join(', ')}) ${select('day', 'GROUP BY day')} ${upsertTail(sign)}`).bind(...args),
      db.prepare(`INSERT INTO stats_daily (day, ${STATS_COLUMNS.join(', ')}) ${select(`'${TOTAL_DAY}'`, '')} ${upsertTail(sign)}`).bind(...args),
    );
  }
  return out;
}

/** D1 limit: terms of one compound SELECT. */
export const MAX_COMPOUND = 5;

/** Column list for the inner UNION: every source yields (day, all columns). */
function cols(values: Partial<Record<StatsColumn, string>>): string {
  return STATS_COLUMNS.map((c) => `${values[c] ?? '0'} AS ${c}`).join(', ');
}

/**
 * One purchase row (status active / reversed) and one client's purchase shape for one day:
 *   purchases / revenue / reversals of the purchase row,
 *   buyers of `day` for the client, the client's first-purchase instant count, last and
 *   second-last purchase days. ?1 = purchase id, ?2 = client id, ?3/?4 = [start, end) of `day`.
 */
export function purchaseContribution(db: D1Database, sign: 1 | -1, purchaseId: string, clientId: string, day: string): D1PreparedStatement[] {
  const [start, end] = dayBounds(day);
  const cover = `FROM purchases q WHERE q.status = 'active' AND q.client_id = ?2`;
  const terms = [
    `SELECT ${dayOf('p.created_at')} AS day, ${cols({ purchases: '1', revenue: 'p.amount' })} FROM purchases p WHERE p.id = ?1 AND p.status = 'active'`,
    `SELECT ${dayOf('p.reversed_at')} AS day, ${cols({ reversals: '1', reversed_amount: 'p.amount' })} FROM purchases p WHERE p.id = ?1 AND p.status = 'reversed'`,
    `SELECT ?5 AS day, ${cols({ buyers: '1' })} WHERE EXISTS (SELECT 1 ${cover} AND q.created_at >= ?3 AND q.created_at < ?4)`,
    `SELECT ${dayOf('m.at')} AS day, ${cols({ first_purchases: `(SELECT COUNT(*) ${cover} AND q.created_at = m.at)` })}
       FROM (SELECT q.created_at AS at ${cover} ORDER BY q.created_at LIMIT 1) m`,
    `SELECT ${dayOf('m.at')} AS day, ${cols({ last_buyers: '1' })} FROM (SELECT q.created_at AS at ${cover} ORDER BY q.created_at DESC LIMIT 1) m`,
    `SELECT ${dayOf('m.at')} AS day, ${cols({ prev_buyers: '1' })} FROM (SELECT q.created_at AS at ${cover} ORDER BY q.created_at DESC LIMIT 1 OFFSET 1) m`,
  ];
  return rowsContribution(db, sign, terms, [purchaseId, clientId, start, end, day]);
}

/** Gifts (rewards rows) by id: unlocked (not revoked) on the unlock day, used on the use day. */
export function rewardsContribution(db: D1Database, sign: 1 | -1, ids: string[]): D1PreparedStatement[] {
  if (!ids.length) return [];
  const terms = [
    `SELECT ${dayOf('r.unlocked_at')} AS day, ${cols({ gifts_unlocked: '1' })} FROM rewards r WHERE r.id IN (SELECT value FROM json_each(?1)) AND r.status <> 'revoked'`,
    `SELECT ${dayOf('r.used_at')} AS day, ${cols({ gifts_used: '1' })} FROM rewards r WHERE r.id IN (SELECT value FROM json_each(?1)) AND r.status = 'used'`,
  ];
  return rowsContribution(db, sign, terms, [JSON.stringify(ids)]);
}

/**
 * Everything a SET of clients contributes (`clientFilter` = SQL condition on a client id
 * column `X`, e.g. "X IN (SELECT id FROM clients WHERE demo = 1)", with its binds).
 * Used with +1 after bulk inserts and −1 before bulk deletes, and by the migration backfill.
 */
export function contributionTerms(clientFilter: (col: string) => string): string[] {
  const f = clientFilter;
  return [
    `SELECT ${dayOf('p.created_at')} AS day, ${cols({ purchases: '1', revenue: 'p.amount' })} FROM purchases p WHERE p.status = 'active' AND ${f('p.client_id')}`,
    `SELECT ${dayOf('p.reversed_at')} AS day, ${cols({ reversals: '1', reversed_amount: 'p.amount' })} FROM purchases p WHERE p.status = 'reversed' AND ${f('p.client_id')}`,
    `SELECT x.day, ${cols({ buyers: '1' })} FROM (SELECT DISTINCT p.client_id, ${dayOf('p.created_at')} AS day FROM purchases p WHERE p.status = 'active' AND ${f('p.client_id')}) x`,
    `SELECT ${dayOf('p.created_at')} AS day, ${cols({ first_purchases: '1' })} FROM purchases p
       WHERE p.status = 'active' AND ${f('p.client_id')}
         AND p.created_at = (SELECT MIN(q.created_at) FROM purchases q WHERE q.status = 'active' AND q.client_id = p.client_id)`,
    `SELECT ${dayOf('MAX(p.created_at)')} AS day, ${cols({ last_buyers: '1' })} FROM purchases p WHERE p.status = 'active' AND ${f('p.client_id')} GROUP BY p.client_id`,
    `SELECT ${dayOf('x.at')} AS day, ${cols({ prev_buyers: '1' })} FROM (
       SELECT (SELECT q.created_at FROM purchases q WHERE q.status = 'active' AND q.client_id = c.id ORDER BY q.created_at DESC LIMIT 1 OFFSET 1) AS at
       FROM clients c WHERE ${f('c.id')}) x WHERE x.at IS NOT NULL`,
    `SELECT ${dayOf('c.created_at')} AS day, ${cols({
      new_clients: 'CASE WHEN EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id) THEN 0 ELSE 1 END',
      imported_clients: 'CASE WHEN EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id) THEN 1 ELSE 0 END',
    })} FROM clients c WHERE ${f('c.id')}`,
    `SELECT ${dayOf('l.created_at')} AS day, ${cols(LEDGER_SQL)} FROM points_ledger l WHERE ${f('l.client_id')}`,
    `SELECT ${dayOf('r.unlocked_at')} AS day, ${cols({ gifts_unlocked: '1' })} FROM rewards r WHERE r.status <> 'revoked' AND ${f('r.client_id')}`,
    `SELECT ${dayOf('r.used_at')} AS day, ${cols({ gifts_used: '1' })} FROM rewards r WHERE r.status = 'used' AND ${f('r.client_id')}`,
  ];
}

/**
 * ± the contribution of a set of clients (two statements: per day and '*').
 * `guard` (optional SQL condition) lets a batch apply it only when e.g. a maintenance flag is set.
 */
export function contributionStmts(
  db: D1Database,
  sign: 1 | -1,
  clientFilter: (col: string) => string,
  binds: unknown[] = [],
  guard = 'true',
): D1PreparedStatement[] {
  return rowsContribution(db, sign, contributionTerms(clientFilter), binds, guard);
}

/** Clients by id list (JSON in one bound parameter: no 100-parameter limit). ?1 must be the JSON. */
export const byIds = (col: string) => `${col} IN (SELECT value FROM json_each(?1))`;

/** Cached distinct-buyer counts of past windows are invalid after any change of past purchases. */
export function invalidateBuyersStmt(db: D1Database, day?: string): D1PreparedStatement {
  return day
    ? db.prepare('DELETE FROM stats_buyers WHERE from_day <= ?1 AND to_day >= ?1').bind(day)
    : db.prepare('DELETE FROM stats_buyers');
}
