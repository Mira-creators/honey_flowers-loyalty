/**
 * Slim M6: write-offs and freshness (architecture §2.8, §6.4).
 *  - A write-off is posted at once (the stems are physically gone; FIFO must not hand them to the
 *    next bouquet). From writeoffApprovalUzs (200 000 сум) a florist's write-off gets
 *    approval = 'pending'; the owner approves (approval only) or rejects (= storno: mirror moves).
 *    The owner's own write-offs are approved immediately. No photos in the prototype.
 *  - Freshness: open lots by sell-by date — overdue / today / soon / fresh, money at risk.
 */
import type { FreshnessDTO, FreshLotDTO, PendingWriteoffDTO, StockFreshness, WriteoffResultDTO } from '@honey/contracts';
import { freshnessOf, muToUzs, pickLots, type PickLot, type StockConfig } from '@honey/stock';
import { z } from 'zod';
import type { Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import { auditStmt } from './catalog.js';
import {
  actorOf, classifyDbError, docByKeyStmt, headerStmt, idemKey, mapPostingError, movesStmt, num, payloadHash, postedStmt, replayOf, requireStock, revStmt,
  strOrNull, stornoStatements, todayOf, totalValue, type DocRow, type MoveIn, type Row,
} from './core.js';

export const REASONS = { wilt: 'writeoff_wilt', damage: 'writeoff_damage', supplier: 'writeoff_supplier', other: 'writeoff_other' } as const;
export const REASON_LABELS: Record<string, string> = {
  writeoff_wilt: 'увяли', writeoff_damage: 'сломаны', writeoff_supplier: 'брак поставщика', writeoff_other: 'другое', disassembly_waste: 'отходы разборки',
};

const writeoffSchema = z.object({
  idempotencyKey: idemKey,
  lines: z
    .array(z.object({ itemId: z.string().min(1).max(64), qty: z.number().int().min(1).max(10_000), reason: z.enum(['wilt', 'damage', 'supplier', 'other']), lotId: z.string().min(1).max(100).nullish() }))
    .min(1)
    .max(30),
  note: z.string().trim().max(500).nullish(),
});

export async function postWriteoff(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig, opts: { demo?: boolean; nowIso?: string } = {}): Promise<WriteoffResultDTO> {
  requireStock(caller, 'writeoff.post', cfg);
  const req = writeoffSchema.parse(body);
  const keyOf = (l: { itemId: string; lotId?: string | null }) => `${l.itemId}|${l.lotId ?? ''}`;
  if (new Set(req.lines.map(keyOf)).size !== req.lines.length) throw new HttpError(400, 'validation', 'Позиция в списании повторяется');
  if (req.lines.some((l) => l.reason === 'other') && (req.note ?? '').length < 3) throw new HttpError(400, 'validation', 'Причина «другое»: напишите комментарий');
  const hash = await payloadHash(req);
  const actor = actorOf(caller);
  const db = app.repo.db;
  const ids = [...new Set(req.lines.map((l) => l.itemId))];
  const ph = ids.map(() => '?').join(',');
  for (let attempt = 0; attempt < 3; attempt++) {
    const today = new Date(Date.parse(opts.nowIso ?? app.now().toISOString()) + 5 * 3_600_000).toISOString().slice(0, 10);
    const [items, lots, doc, day] = await db.batch<Row>([
      db.prepare(`SELECT id, name, track_stock, kind FROM stock_items WHERE id IN (${ph})`).bind(...ids),
      db.prepare(`SELECT id, item_id, qty_on_hand, unit_cost_mu, priority, expires_on, received_at FROM stock_lots WHERE item_id IN (${ph}) AND qty_on_hand > 0 ORDER BY item_id, priority DESC, expires_on, received_at, id`).bind(...ids),
      docByKeyStmt(db, req.idempotencyKey),
      // the same florist's write-offs earlier today (Tashkent): the approval threshold is per day, so it cannot be
      // bypassed by splitting one big write-off into several small documents (audit CODE-10)
      db.prepare(`SELECT COALESCE(SUM(total_value_mu), 0) AS v FROM stock_docs WHERE kind = 'writeoff' AND actor_id = ? AND doc_date = ? AND status = 'posted' AND approval <> 'rejected'`).bind(actor.id, today),
    ]);
    const prior = replayOf((doc!.results[0] as unknown as DocRow) ?? null, hash, 'writeoff');
    if (prior) return writeoffResult(app, prior.id, true);
    const names = new Map(items!.results.map((i) => [String(i.id), i]));
    for (const l of req.lines) {
      const it = names.get(l.itemId);
      if (!it) throw new HttpError(400, 'validation', 'Позиция не найдена');
      if (num(it.track_stock) !== 1) throw new HttpError(400, 'validation', `«${String(it.name)}» не учитывается на складе — списывать нечего`);
    }
    const open: PickLot[] = lots!.results.map((l) => ({ id: String(l.id), itemId: String(l.item_id), qty: num(l.qty_on_hand), unitCostMu: num(l.unit_cost_mu), priority: num(l.priority), expiresOn: strOrNull(l.expires_on), receivedAt: String(l.received_at) }));
    const moves: MoveIn[] = [];
    const short: Array<{ itemId: string; name: string; need: number; have: number }> = [];
    req.lines.forEach((l, k) => {
      const reason = REASONS[l.reason];
      if (l.lotId) {
        const lot = open.find((x) => x.id === l.lotId && x.itemId === l.itemId);
        if (!lot || lot.qty < l.qty) {
          short.push({ itemId: l.itemId, name: String(names.get(l.itemId)!.name), need: l.qty, have: lot?.qty ?? 0 });
          return;
        }
        lot.qty -= l.qty;
        moves.push({ l: k + 1, i: l.itemId, o: lot.id, q: -l.qty, v: -l.qty * lot.unitCostMu, r: reason });
        return;
      }
      const { picks, short: s } = pickLots(open, [{ itemId: l.itemId, qty: l.qty }], { policy: 'block', confirmedShort: false, deficitCostMu: () => 0 });
      if (s.length) {
        short.push({ itemId: l.itemId, name: String(names.get(l.itemId)!.name), need: l.qty, have: s[0]!.have });
        return;
      }
      for (const p of picks) {
        open.find((x) => x.id === p.lotId)!.qty -= p.qty;
        moves.push({ l: k + 1, i: l.itemId, o: p.lotId, q: -p.qty, v: -Number(p.valueMu), r: reason });
      }
    });
    if (short.length) {
      throw new HttpError(409, 'stock_short', `Нельзя списать больше остатка: ${short.map((s) => `${s.name} — списать ${s.need}, на складе ${s.have}`).join('; ')}`, { short, canForce: false });
    }
    const valueMu = totalValue(moves);
    const valueUzs = muToUzs(valueMu);
    const dayBeforeUzs = muToUzs(num(day!.results[0]?.v));
    const big = valueUzs >= cfg.writeoffApprovalUzs || (caller.role !== 'owner' && dayBeforeUzs + valueUzs >= cfg.writeoffApprovalUzs);
    const pending = caller.role !== 'owner' && big;
    const now = opts.nowIso ?? app.now().toISOString();
    const docDate = new Date(Date.parse(now) + 5 * 3_600_000).toISOString().slice(0, 10);
    const docId = crypto.randomUUID();
    const stmts: D1PreparedStatement[] = [
      headerStmt(db, { id: docId, kind: 'writeoff', docDate, key: req.idempotencyKey, hash, actor, now, approval: big ? 'pending' : 'none', note: req.note ?? null, demo: opts.demo }),
      movesStmt(db, docId, docDate, actor.id, now, moves),
      db
        .prepare(`INSERT INTO stock_doc_lines (doc_id, line_no, item_id, qty, reason, lot_id) SELECT ?1, key + 1, json_extract(value,'$.i'), json_extract(value,'$.q'), json_extract(value,'$.r'), json_extract(value,'$.o') FROM json_each(?2)`)
        .bind(docId, JSON.stringify(req.lines.map((l) => ({ i: l.itemId, q: l.qty, r: REASONS[l.reason], o: l.lotId ?? null })))),
      postedStmt(db, docId, valueMu, now),
      // the owner's own big write-off is approved at once (pending → approved in the same batch)
      ...(big && !pending ? [db.prepare(`UPDATE stock_docs SET approval = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`).bind(actor.id, now, docId)] : []),
      revStmt(db),
    ];
    try {
      await db.batch(stmts);
    } catch (e) {
      const k = classifyDbError(e);
      if (k === 'idempotency' || k === 'lot_bounds') continue;
      mapPostingError(e);
    }
    return writeoffResult(app, docId, false);
  }
  throw new HttpError(409, 'conflict', 'Остаток одновременно изменился — проверьте и повторите');
}

async function writeoffResult(app: AppContext, docId: string, replayed: boolean): Promise<WriteoffResultDTO> {
  const r = await app.repo.db.prepare('SELECT number, total_value_mu, approval FROM stock_docs WHERE id = ?').bind(docId).all<Row>();
  const d = r.results[0]!;
  return { docId, number: num(d.number), valueUzs: muToUzs(num(d.total_value_mu)), approval: d.approval as WriteoffResultDTO['approval'], replayed };
}

export async function pendingWriteoffs(app: AppContext, limit = 30): Promise<PendingWriteoffDTO[]> {
  const db = app.repo.db;
  const [docs, lines] = await db.batch<Row>([
    db.prepare(`SELECT id, number, total_value_mu, created_at, actor_id, note FROM stock_docs WHERE approval = 'pending' ORDER BY created_at LIMIT ?`).bind(limit),
    db.prepare(
      `SELECT m.doc_id, i.name, -SUM(m.qty) AS qty, m.reason, -SUM(m.value_mu) AS v FROM stock_moves m JOIN stock_items i ON i.id = m.item_id
        WHERE m.doc_id IN (SELECT id FROM stock_docs WHERE approval = 'pending' ORDER BY created_at LIMIT ?) GROUP BY m.doc_id, m.item_id, m.reason`,
    ).bind(limit),
  ]);
  const names = await app.repo.actorNames(docs!.results.map((d) => String(d.actor_id)));
  return docs!.results.map((d) => ({
    docId: String(d.id), number: num(d.number), valueUzs: muToUzs(num(d.total_value_mu)), createdAt: String(d.created_at), actor: names.get(String(d.actor_id)) ?? String(d.actor_id), note: strOrNull(d.note),
    lines: lines!.results.filter((l) => l.doc_id === d.id).map((l) => ({ name: String(l.name), qty: num(l.qty), reason: REASON_LABELS[String(l.reason)] ?? String(l.reason), valueUzs: muToUzs(num(l.v)) })),
  }));
}

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).nullish() });

/** Owner: approve (approval only) or reject (storno of the moves + approval 'rejected'). */
export async function decideWriteoff(app: AppContext, caller: Caller, docId: string, body: unknown, cfg: StockConfig): Promise<{ docId: string; approval: 'approved' | 'rejected' }> {
  requireStock(caller, 'writeoff.approve', cfg);
  const v = decisionSchema.parse(body);
  if (v.decision === 'reject' && (v.reason ?? '').length < 3) throw new HttpError(400, 'validation', 'Укажите причину отклонения (минимум 3 символа)');
  const db = app.repo.db;
  const r = await db.prepare('SELECT id, kind, approval, status FROM stock_docs WHERE id = ?').bind(docId).all<Row>();
  const d = r.results[0];
  if (!d || d.kind !== 'writeoff') throw new HttpError(404, 'not_found', 'Списание не найдено');
  if (d.approval !== 'pending') throw new HttpError(409, 'already_decided', 'Списание уже подтверждено или отклонено');
  const actor = actorOf(caller);
  const now = app.now().toISOString();
  const decided = v.decision === 'approve' ? 'approved' : 'rejected';
  const approvalStmt = db.prepare(`UPDATE stock_docs SET approval = ?, approved_by = ?, approved_at = ? WHERE id = ?`).bind(decided, actor.id, now, docId);
  const audit = auditStmt(app, actor, 'stock.approval', 'stock_docs', docId, { decision: decided, reason: v.reason ?? null });
  try {
    if (v.decision === 'approve') await db.batch([approvalStmt, audit]);
    else {
      // guard first: a second decision aborts on the approval transition before any move
      const { stmts } = await stornoStatements(app, { id: docId }, actor, `storno:${docId}`, now, [approvalStmt, audit]);
      await db.batch(stmts);
    }
  } catch (e) {
    const k = classifyDbError(e);
    if (k === 'doc_guard' || k === 'idempotency' || k === 'already_cancelled') throw new HttpError(409, 'already_decided', 'Списание уже подтверждено или отклонено');
    mapPostingError(e);
  }
  return { docId, approval: decided };
}

export async function freshness(app: AppContext): Promise<FreshnessDTO> {
  const today = todayOf(app);
  const { results } = await app.repo.db
    .prepare(
      `SELECT l.id, l.item_id, l.qty_on_hand, l.unit_cost_mu, l.received_at, l.sell_by, l.priority, i.name, i.emoji, i.warn_days
         FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.qty_on_hand > 0 ORDER BY l.sell_by, l.received_at`,
    )
    .all<Row>();
  const empty = () => ({ count: 0, valueUzs: 0, lots: [] as FreshLotDTO[] });
  const groups: FreshnessDTO['groups'] = { overdue: empty(), today: empty(), soon: empty(), fresh: empty() };
  for (const r of results) {
    const f = freshnessOf(strOrNull(r.sell_by), num(r.warn_days), today);
    const value = muToUzs(BigInt(num(r.qty_on_hand)) * BigInt(num(r.unit_cost_mu)));
    const g = groups[f];
    g.count++;
    g.valueUzs += value;
    g.lots.push({
      lotId: String(r.id), itemId: String(r.item_id), name: String(r.name), emoji: strOrNull(r.emoji), qty: num(r.qty_on_hand), valueUzs: value,
      receivedOn: String(r.received_at).slice(0, 10), sellBy: strOrNull(r.sell_by), freshness: f, priority: num(r.priority) === 1,
    });
  }
  // fresh lots: only the count/value matter on the phone; keep the list short
  groups.fresh.lots = groups.fresh.lots.slice(0, 300);
  const atRisk = (['overdue', 'today', 'soon'] as StockFreshness[]).reduce((a, k) => a + groups[k].valueUzs, 0);
  return { today, atRiskUzs: atRisk, groups };
}

export async function setLotPriority(app: AppContext, caller: Caller, lotId: string, on: boolean, cfg: StockConfig): Promise<{ lotId: string; priority: boolean }> {
  requireStock(caller, 'lot.priority', cfg);
  const db = app.repo.db;
  const [r] = await db.batch([db.prepare(`UPDATE stock_lots SET priority = ? WHERE id = ? AND kind = 'normal'`).bind(on ? 1 : 0, lotId), revStmt(db)]);
  if (!r?.meta.changes) throw new HttpError(404, 'not_found', 'Партия не найдена');
  return { lotId, priority: on };
}
