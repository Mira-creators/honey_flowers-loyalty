/**
 * «Склад» (prototype) — shared Worker helpers: feature flag, config, idempotency, the posting batch
 * (header → guard → the rest → posted), D1 error mapping, generic statements.
 *
 * Posting rule (architecture §4.1): inside one db.batch only the FIRST statement (unique idempotency
 * key) or the guard right after it (CHECK stock_lots_bounds on the moves insert, or the bouquet
 * status transition) may legitimately fail. All moves of a document are inserted by ONE statement
 * (INSERT … SELECT FROM json_each), so moves and their trigger-maintained caches are atomic even
 * without relying on how D1 rolls a batch back.
 */
import type { PublicStockConfigDTO } from '@honey/contracts';
import { can, DEFAULT_STOCK_CONFIG, mergeStockConfig, publicConfig, tashkentDay, type StockAction, type StockConfig } from '@honey/stock';
import { z } from 'zod';
import { actingStaff, type Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';

export const stockEnabled = (env: Env) => (env.STOCK_ENABLED ?? '').trim() === '1';

export type Row = Record<string, unknown>;
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const todayOf = (app: AppContext) => tashkentDay(app.now());

// ------------------------------------------------------------------ config

const pct = z.number().min(0).max(1000);
export const stockConfigSchema = z
  .object({
    negativePolicy: z.enum(['block', 'warn', 'allow']),
    receiptRoles: z.array(z.enum(['florist', 'manager', 'owner'])).max(3),
    backdateDays: z.number().int().min(0).max(30),
    assemblyCancelHours: z.number().int().min(0).max(72),
    writeoffApprovalUzs: z.number().int().min(0).max(1_000_000_000),
    labourInCost: z.boolean(),
    pricing: z.object({
      flowersMultiplier: z.number().min(1).max(20),
      suppliesMultiplier: z.number().min(1).max(20),
      labourPct: pct,
      round: z.object({ step: z.number().int().min(1).max(1_000_000), offset: z.number().int().min(0).max(1_000_000) }),
      targets: z.object({ costShare: z.number().min(1).max(100), flowersShare: z.number().min(1).max(100), amberBandPp: z.number().min(0).max(50) }),
      priceMode: z.enum(['suggest', 'fixed']),
    }),
    wasteTargets: z.object({ normPct: z.number().min(0).max(100), alarmPct: z.number().min(0).max(100) }),
    showcaseStaleDays: z.number().int().min(1).max(30),
    defaults: z.record(z.object({ vaseLifeDays: z.number().int().min(1).max(365).nullable(), sellDays: z.number().int().min(1).max(365).nullable(), warnDays: z.number().int().min(0).max(30) })),
  })
  .refine((c) => c.pricing.round.offset < c.pricing.round.step, { message: 'смещение округления должно быть меньше шага', path: ['pricing', 'round', 'offset'] });

export function parseStoredConfig(raw: string | null | undefined): StockConfig {
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const merged = mergeStockConfig(parsed);
  // A broken stored value never breaks the module: fall back to defaults.
  return stockConfigSchema.safeParse(merged).success ? merged : mergeStockConfig({});
}

export async function loadConfig(db: D1Database): Promise<StockConfig> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = 'stock_config'`).all<{ value: string }>();
  return parseStoredConfig(r.results[0]?.value);
}

export const configStmt = (db: D1Database) => db.prepare(`SELECT key, value FROM settings WHERE key IN ('stock_config', 'stock_rev', 'stock_catalog_rev', 'stock_uses')`);

export function settingsFrom(rows: Row[]): { config: StockConfig; rev: string; catalogRev: string; uses: { day: string; n: Record<string, number> } | null } {
  const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  let uses: { day: string; n: Record<string, number> } | null = null;
  try {
    const u = JSON.parse(m.get('stock_uses') ?? 'null') as { day?: unknown; n?: unknown } | null;
    if (u && typeof u.day === 'string' && u.n && typeof u.n === 'object') uses = { day: u.day, n: u.n as Record<string, number> };
  } catch {
    uses = null;
  }
  return { config: parseStoredConfig(m.get('stock_config')), rev: m.get('stock_rev') ?? '0', catalogRev: m.get('stock_catalog_rev') ?? '0', uses };
}

export const publicConfigDTO = (c: StockConfig): PublicStockConfigDTO => publicConfig(c) as PublicStockConfigDTO;
export { DEFAULT_STOCK_CONFIG };

// ------------------------------------------------------------------ permissions / actor

export interface Actor {
  id: string;
  role: 'florist' | 'manager' | 'owner';
  name: string;
}

export function actorOf(caller: Caller): Actor {
  const s = actingStaff(caller);
  return { id: s.id, role: s.role, name: s.name };
}

const FORBIDDEN: Partial<Record<StockAction, string>> = {
  'receipt.post': 'Вносить приход может только владелец (настройка склада)',
  'receipt.backdate': 'Приход задним числом может вносить только владелец',
  'catalog.edit': 'Каталог меняет только владелец',
  'writeoff.approve': 'Подтверждать списания может только владелец',
};

export function requireStock(caller: Caller, action: StockAction, config: StockConfig): void {
  if (!can(caller.role, action, config)) {
    throw new HttpError(403, 'forbidden', FORBIDDEN[action] ?? (caller.role === 'client' ? 'Доступно только сотрудникам' : 'Недостаточно прав для этого действия'));
  }
}

// ------------------------------------------------------------------ idempotency

/** SHA-256 hex of the canonical JSON (sorted keys) of the request without idempotencyKey. */
export async function payloadHash(req: unknown): Promise<string> {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).filter((k) => k !== 'idempotencyKey' && o[k] !== undefined).sort().map((k) => [k, canon(o[k])]));
    }
    return v;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canon(req)));
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const idemKey = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_:-]+$/, 'ключ операции: латиница, цифры, - _ :');

export interface DocRow {
  id: string;
  kind: string;
  number: number;
  status: string;
  payload_hash: string;
  doc_date: string;
  approval: string;
  actor_id: string;
  created_at: string;
}

export const docByKeyStmt = (db: D1Database, key: string) =>
  db.prepare('SELECT id, kind, number, status, payload_hash, doc_date, approval, actor_id, created_at FROM stock_docs WHERE idempotency_key = ?').bind(key);

/**
 * A document with this key exists: same payload → replay (return it); different → 409.
 * Still `posting` → 409 posting_in_progress.
 */
export function replayOf(doc: DocRow | null | undefined, hash: string, kind: string): DocRow | null {
  if (!doc) return null;
  if (doc.kind !== kind || doc.payload_hash !== hash) throw new HttpError(409, 'conflict', 'Этот ключ уже использован для другой операции');
  if (doc.status === 'posting') throw new HttpError(409, 'posting_in_progress', 'Операция ещё проводится — повторите через минуту');
  if (doc.status === 'failed') throw new HttpError(409, 'conflict', 'Операция с этим ключом не прошла — начните заново');
  return doc;
}

// ------------------------------------------------------------------ D1 errors

export type DbFailure = 'lot_bounds' | 'idempotency' | 'bouquet_state' | 'doc_guard' | 'already_cancelled' | 'already_reversed_move' | 'period_closed' | 'frozen' | null;

export function classifyDbError(e: unknown): DbFailure {
  const m = String((e as Error)?.message ?? e);
  if (m.includes('stock_lots_bounds')) return 'lot_bounds';
  if (m.includes('stock_docs.idempotency_key')) return 'idempotency';
  if (m.includes('stock_docs.cancels_doc_id') || m.includes('stock_docs_cancels_uq')) return 'already_cancelled';
  if (m.includes('stock_moves.reverses_move_id') || m.includes('stock_moves_reverses_uq')) return 'already_reversed_move';
  if (m.includes('букет уже продан')) return 'bouquet_state';
  if (m.includes('недопустимое изменение документа')) return 'doc_guard';
  if (m.includes('период закрыт')) return 'period_closed';
  if (m.includes('заморожена')) return 'frozen';
  return null;
}

/** Full-jitter backoff before a retry after a lost race (20–400 ms). */
export const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(400, 20 * 2 ** (attempt + 1))));

// ------------------------------------------------------------------ statements

export interface DocHeader {
  id: string;
  kind: 'receipt' | 'assembly' | 'sale' | 'writeoff' | 'disassembly' | 'storno';
  docDate: string;
  key: string;
  hash: string;
  actor: Actor;
  now: string;
  supplierId?: string | null;
  cancelsDocId?: string | null;
  extraCostUzs?: number;
  currency?: 'UZS' | 'USD';
  fxRateX100?: number | null;
  priceMode?: 'lines' | 'total' | null;
  inputTotal?: number | null;
  approval?: 'none' | 'pending';
  note?: string | null;
  demo?: boolean;
}

/** Statement 1 of every posting batch: the header in `posting`, number = MAX + 1 of its kind. */
export function headerStmt(db: D1Database, h: DocHeader): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stock_docs (id, kind, number, status, doc_date, idempotency_key, payload_hash, actor_id, actor_role, supplier_id, cancels_doc_id,
         extra_cost_uzs, currency, fx_rate_x100, price_mode, input_total, approval, note, demo, created_at)
       VALUES (?1, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM stock_docs WHERE kind = ?2), 'posting', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    )
    .bind(
      h.id, h.kind, h.docDate, h.key, h.hash, h.actor.id, h.actor.role, h.supplierId ?? null, h.cancelsDocId ?? null,
      h.extraCostUzs ?? 0, h.currency ?? 'UZS', h.fxRateX100 ?? null, h.priceMode ?? null, h.inputTotal ?? null, h.approval ?? 'none', h.note ?? null, h.demo ? 1 : 0, h.now,
    );
}

export const postedStmt = (db: D1Database, id: string, totalValueMu: bigint, now: string) =>
  db.prepare(`UPDATE stock_docs SET status = 'posted', posted_at = ?, total_value_mu = ? WHERE id = ?`).bind(now, Number(totalValueMu), id);

/** stock_rev + 1 (ETag of the builder catalog); upsert because a TEST_MODE wipe deletes settings. */
export const revStmt = (db: D1Database, key: 'stock_rev' | 'stock_catalog_rev' = 'stock_rev') =>
  db.prepare(`INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).bind(key);

export interface MoveIn {
  /** line_no */
  l: number;
  /** item_id */
  i: string;
  /** lot_id */
  o: string;
  /** qty (signed) */
  q: number;
  /** value_mu = q × lot.unit_cost_mu (checked by trigger) */
  v: number;
  /** reason */
  r: string;
  /** bouquet_id */
  b?: string | null;
  /** reverses_move_id */
  m?: number | null;
}

/** All moves of a document in ONE statement (array order = id order). */
export function movesStmt(db: D1Database, docId: string, docDate: string, actorId: string, now: string, moves: MoveIn[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stock_moves (doc_id, line_no, item_id, lot_id, qty, value_mu, reason, doc_date, bouquet_id, reverses_move_id, actor_id, created_at)
       SELECT ?1, json_extract(value, '$.l'), json_extract(value, '$.i'), json_extract(value, '$.o'), json_extract(value, '$.q'), json_extract(value, '$.v'),
              json_extract(value, '$.r'), ?2, json_extract(value, '$.b'), json_extract(value, '$.m'), ?3, ?4
         FROM json_each(?5) ORDER BY key`,
    )
    .bind(docId, docDate, actorId, now, JSON.stringify(moves));
}

export const totalValue = (moves: MoveIn[]) => moves.reduce((a, m) => a + BigInt(Math.abs(m.v)), 0n);

/** Deficit lots («в минус») are created on first use: INSERT OR IGNORE (id = def:<item>:<cost>). */
export function deficitLotsStmt(db: D1Database, lots: Array<{ id: string; itemId: string; costMu: number }>, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO stock_lots (id, item_id, kind, received_at, qty_received, unit_cost_mu, created_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.item'), 'deficit', ?1, 0, json_extract(value, '$.cost'), ?1 FROM json_each(?2)`,
    )
    .bind(now, JSON.stringify(lots.map((l) => ({ id: l.id, item: l.itemId, cost: l.costMu }))));
}

/**
 * Storno of a document (architecture §4.5): new doc kind 'storno' dated today, one mirror move per
 * original move (same lot, −qty, same reason, reverses_move_id), in REVERSE order so a lot never
 * crosses its bounds inside the statement; then the original → 'cancelled'.
 */
export async function stornoStatements(
  app: AppContext,
  original: { id: string },
  actor: Actor,
  key: string,
  now: string,
  extra: D1PreparedStatement[] = [],
): Promise<{ stmts: D1PreparedStatement[]; stornoId: string; moves: MoveIn[] }> {
  const db = app.repo.db;
  const { results } = await db
    .prepare('SELECT id, line_no, item_id, lot_id, qty, value_mu, reason, bouquet_id FROM stock_moves WHERE doc_id = ? AND reverses_move_id IS NULL ORDER BY id DESC')
    .bind(original.id)
    .all<Row>();
  const stornoId = crypto.randomUUID();
  const moves: MoveIn[] = results.map((m) => ({
    l: num(m.line_no), i: String(m.item_id), o: String(m.lot_id), q: -num(m.qty), v: -num(m.value_mu), r: String(m.reason), b: strOrNull(m.bouquet_id), m: num(m.id),
  }));
  const today = tashkentDay(app.now());
  const stmts = [
    headerStmt(db, { id: stornoId, kind: 'storno', docDate: today, key, hash: key, actor, now, cancelsDocId: original.id }),
    ...extra,
    ...(moves.length ? [movesStmt(db, stornoId, today, actor.id, now, moves)] : []),
    db.prepare(`UPDATE stock_docs SET status = 'cancelled' WHERE id = ?`).bind(original.id),
    postedStmt(db, stornoId, totalValue(moves), now),
    revStmt(db),
  ];
  return { stmts, stornoId, moves };
}

export function mapPostingError(e: unknown): never {
  const k = classifyDbError(e);
  if (k === 'already_cancelled' || k === 'already_reversed_move') throw new HttpError(409, 'already_cancelled', 'Документ уже отменён');
  if (k === 'bouquet_state') throw new HttpError(409, 'bouquet_state', 'Букет уже продан, разобран или отменён');
  if (k === 'doc_guard') throw new HttpError(409, 'already_decided', 'Документ уже изменён другим действием — обновите экран');
  if (k === 'lot_bounds') throw new HttpError(409, 'conflict', 'Остаток одновременно изменился — проверьте и повторите');
  if (k === 'period_closed') throw new HttpError(409, 'period_closed', 'Период закрыт — проведите документ сегодняшней датой');
  throw e;
}

/** Display names of actors (staff ids / tg:<id> testers). */
export async function actorNames(app: AppContext, ids: Array<string | null>): Promise<Map<string, string>> {
  return app.repo.actorNames(ids);
}
