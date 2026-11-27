/**
 * M4 Bouquet assembly (architecture §2.5, §4.1, §4.3, §4.9, §4.10): the florist sends only items and
 * quantities; the server picks lots FIFO/FEFO, freezes the cost and posts the consumption atomically.
 * Concurrency: two florists taking the last stems → the second batch hits CHECK stock_lots_bounds,
 * the server re-reads the lots and re-plans (≤ 3 times) → 409 stock_short with what is missing,
 * or «собрать в минус» onto the deficit lot when the florist confirms with a comment (policy warn).
 * Also: showcase, disassembly into the original lots, cancellation (storno), templates.
 */
import type { AssembleRequest, AssembleResultDTO, BouquetDTO, DisassembleResultDTO, StockShortDetails } from '@honey/contracts';
import {
  bouquetCost, daysBetween, muToUzs, pickLots, planDisassembly, shares, shortBlocks, suggestPrice, tashkentDay,
  type CostLine, type PickLot, type StockConfig, type StockKind, type TakenLot,
} from '@honey/stock';
import { z } from 'zod';
import type { Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import {
  actorOf, backoff, classifyDbError, deficitLotsStmt, docByKeyStmt, headerStmt, idemKey, mapPostingError, movesStmt, num, numOrNull, payloadHash,
  postedStmt, replayOf, requireStock, revStmt, strOrNull, stornoStatements, todayOf, totalValue, type DocRow, type MoveIn, type Row,
} from './core.js';

export const assembleSchema = z.object({
  idempotencyKey: idemKey,
  kind: z.enum(['order', 'showcase']).default('order'),
  templateId: z.string().min(1).max(64).nullish(),
  lines: z.array(z.object({ itemId: z.string().min(1).max(64), qty: z.number().int().min(1).max(10_000), plannedQty: z.number().int().min(0).max(10_000).nullish() })).min(1).max(40),
  price: z.number().int().positive().max(100_000_000).nullish(),
  allowShort: z.boolean().optional(),
  shortComment: z.string().trim().max(500).nullish(),
  expectedCost: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
});

interface ItemRow {
  id: string;
  name: string;
  kind: StockKind;
  track: boolean;
  active: boolean;
  stdCostMu: number | null;
  lastCostMu: number | null;
  markupX100: number | null;
}

async function loadForAssembly(app: AppContext, itemIds: string[], key: string) {
  const db = app.repo.db;
  const ph = itemIds.map(() => '?').join(',');
  const [items, lots, doc] = await db.batch<Row>([
    db.prepare(`SELECT i.id, i.name, i.kind, i.track_stock, i.active, i.std_cost_mu, i.markup_x100, b.last_cost_mu FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id WHERE i.id IN (${ph})`).bind(...itemIds),
    db.prepare(`SELECT id, item_id, qty_on_hand, unit_cost_mu, priority, expires_on, received_at FROM stock_lots WHERE item_id IN (${ph}) AND qty_on_hand > 0 ORDER BY item_id, priority DESC, expires_on, received_at, id`).bind(...itemIds),
    docByKeyStmt(db, key),
  ]);
  const map = new Map<string, ItemRow>(
    items!.results.map((r) => [String(r.id), {
      id: String(r.id), name: String(r.name), kind: r.kind as StockKind, track: num(r.track_stock) === 1, active: num(r.active) === 1,
      stdCostMu: numOrNull(r.std_cost_mu), lastCostMu: numOrNull(r.last_cost_mu), markupX100: numOrNull(r.markup_x100),
    }]),
  );
  const open: PickLot[] = lots!.results.map((l) => ({
    id: String(l.id), itemId: String(l.item_id), qty: num(l.qty_on_hand), unitCostMu: num(l.unit_cost_mu), priority: num(l.priority), expiresOn: strOrNull(l.expires_on), receivedAt: String(l.received_at),
  }));
  return { items: map, lots: open, doc: (doc!.results[0] as unknown as DocRow) ?? null };
}

export async function assemble(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig, opts: { demo?: boolean; nowIso?: string; docDate?: string } = {}): Promise<AssembleResultDTO> {
  requireStock(caller, 'bouquet.assemble', cfg);
  const req = assembleSchema.parse(body) as AssembleRequest & z.infer<typeof assembleSchema>;
  const ids = req.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'validation', 'Позиция в букете повторяется — объедините строки');
  const confirmed = !!req.allowShort;
  if (confirmed && cfg.negativePolicy === 'warn' && (req.shortComment ?? '').trim().length < 3) {
    throw new HttpError(400, 'validation', 'Сборка в минус: напишите комментарий (минимум 3 символа)');
  }
  // expectedCost is a UI hint (cost the florist saw), not part of the operation: a retry after a lost response
  // may carry a refreshed hint and must still replay, not 409 (audit CODE-3).
  const { expectedCost: _hint, ...hashed } = req;
  const hash = await payloadHash(hashed);
  const actor = actorOf(caller);
  const db = app.repo.db;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { items, lots, doc } = await loadForAssembly(app, ids, req.idempotencyKey);
    const prior = replayOf(doc, hash, 'assembly');
    if (prior) {
      const b = await db.prepare('SELECT id FROM stock_bouquets WHERE assembly_doc_id = ?').bind(prior.id).all<Row>();
      return { bouquet: (await loadBouquet(app, String(b.results[0]!.id)))!, replayed: true, warnings: [], costChanged: false };
    }
    for (const l of req.lines) {
      const it = items.get(l.itemId);
      if (!it || !it.active) throw new HttpError(400, 'validation', 'В букете есть неизвестная или скрытая позиция — обновите каталог');
      if (it.kind === 'service') throw new HttpError(400, 'validation', `«${it.name}» — услуга, её добавляют при продаже, а не в букет`);
    }
    if (req.templateId) {
      const t = await db.prepare('SELECT id FROM stock_templates WHERE id = ?').bind(req.templateId).all<Row>();
      if (!t.results.length) throw new HttpError(400, 'validation', 'Шаблон не найден');
    }
    const tracked = req.lines.filter((l) => items.get(l.itemId)!.track);
    const { picks, short } = pickLots(lots, tracked.map((l) => ({ itemId: l.itemId, qty: l.qty })), {
      policy: cfg.negativePolicy, confirmedShort: confirmed, deficitCostMu: (id) => items.get(id)?.lastCostMu ?? items.get(id)?.stdCostMu ?? 0,
    });
    if (shortBlocks(short, cfg.negativePolicy, confirmed)) {
      const details: StockShortDetails = { short: short.map((s) => ({ ...s, name: items.get(s.itemId)?.name ?? '' })), canForce: cfg.negativePolicy === 'warn' };
      const what = details.short.map((s) => `${s.name} — нужно ${s.need}, на складе ${s.have}`).join('; ');
      throw new HttpError(409, 'stock_short', `Не хватает: ${what}. ${cfg.negativePolicy === 'warn' ? 'Измените состав или соберите в минус с комментарием' : 'Измените состав или внесите приход'}`, details);
    }
    const usedDeficit = picks.some((p) => p.deficit);
    // cost per line: picked lots + untracked supplies at std cost
    const lineCost = new Map<string, bigint>();
    for (const p of picks) lineCost.set(p.itemId, (lineCost.get(p.itemId) ?? 0n) + p.valueMu);
    for (const l of req.lines) {
      const it = items.get(l.itemId)!;
      if (!it.track) lineCost.set(l.itemId, BigInt(l.qty) * BigInt(it.stdCostMu ?? 0));
    }
    const costLines: CostLine[] = req.lines.map((l) => ({ kind: items.get(l.itemId)!.kind, valueMu: lineCost.get(l.itemId) ?? 0n, markupX100: items.get(l.itemId)!.markupX100 }));
    const cost = bouquetCost(costLines);
    const suggested = suggestPrice(costLines, cfg.pricing);
    const price = cfg.pricing.priceMode === 'fixed' ? suggested : req.price ?? suggested;
    if (!(price > 0)) throw new HttpError(400, 'validation', 'Укажите цену букета');

    const now = opts.nowIso ?? app.now().toISOString();
    const docDate = opts.docDate ?? tashkentDay(now);
    const docId = crypto.randomUUID();
    const bouquetId = crypto.randomUUID();
    const lineNo = new Map(req.lines.map((l, k) => [l.itemId, k + 1]));
    const moves: MoveIn[] = picks.map((p) => ({ l: lineNo.get(p.itemId)!, i: p.itemId, o: p.lotId, q: -p.qty, v: -Number(p.valueMu), r: 'assembly', b: bouquetId }));
    const deficitLots = [...new Map(picks.filter((p) => p.deficit).map((p) => [p.lotId, { id: p.lotId, itemId: p.itemId, costMu: p.unitCostMu }])).values()];
    const stmts: D1PreparedStatement[] = [
      headerStmt(db, { id: docId, kind: 'assembly', docDate, key: req.idempotencyKey, hash, actor, now, note: usedDeficit ? req.shortComment ?? null : null, demo: opts.demo }),
      ...(deficitLots.length ? [deficitLotsStmt(db, deficitLots, now)] : []),
      ...(moves.length ? [movesStmt(db, docId, docDate, actor.id, now, moves)] : []),
      db
        .prepare(
          `INSERT INTO stock_doc_lines (doc_id, line_no, item_id, qty, qty_planned, value_mu)
           SELECT ?1, json_extract(value,'$.n'), json_extract(value,'$.i'), json_extract(value,'$.q'), json_extract(value,'$.p'), json_extract(value,'$.v') FROM json_each(?2)`,
        )
        .bind(docId, JSON.stringify(req.lines.map((l, k) => ({ n: k + 1, i: l.itemId, q: l.qty, p: l.plannedQty ?? null, v: Number(lineCost.get(l.itemId) ?? 0n) })))),
      db
        .prepare(
          `INSERT INTO stock_bouquets (id, assembly_doc_id, template_id, kind, status, florist_id, florist_name, cost_mu, cost_uzs, flowers_cost_uzs, supplies_cost_uzs,
             suggested_price_uzs, price_uzs, price_current_uzs, used_deficit, deficit_comment, demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(bouquetId, docId, req.templateId ?? null, req.kind, req.kind === 'showcase' ? 'on_showcase' : 'assembled', actor.id, actor.name, Number(cost.costMu), cost.costUzs,
          cost.flowersCostUzs, cost.suppliesCostUzs, suggested, price, price, usedDeficit ? 1 : 0, usedDeficit ? req.shortComment ?? null : null, opts.demo ? 1 : 0, now),
      postedStmt(db, docId, totalValue(moves), now),
      revStmt(db),
    ];
    try {
      await db.batch(stmts);
    } catch (e) {
      const k = classifyDbError(e);
      if (k === 'idempotency') continue;
      if (k === 'lot_bounds') {
        // Somebody took these stems between our read and write: re-read and re-plan.
        if (attempt < 3) await backoff(attempt);
        continue;
      }
      mapPostingError(e);
    }
    const bouquet = (await loadBouquet(app, bouquetId))!;
    const warnings: string[] = [];
    const costChanged = req.expectedCost !== null && req.expectedCost !== undefined && req.expectedCost !== bouquet.cost;
    if (costChanged) warnings.push(`Себестоимость обновлена: ${bouquet.cost.toLocaleString('ru-RU')} сум (партии изменились)`);
    if (usedDeficit) warnings.push('Собрано в минус: недостачу закроет следующий приход');
    return { bouquet, replayed: false, warnings, costChanged };
  }
  throw new HttpError(409, 'conflict', 'Остаток одновременно изменился — проверьте и повторите');
}

/** BouquetDTO: bouquet + lines (with the lots they came from). */
export async function loadBouquet(app: AppContext, id: string): Promise<BouquetDTO | null> {
  const db = app.repo.db;
  const [b, lines, moves] = await db.batch<Row>([
    db.prepare('SELECT b.*, d.number FROM stock_bouquets b JOIN stock_docs d ON d.id = b.assembly_doc_id WHERE b.id = ?').bind(id),
    db.prepare(`SELECT l.item_id, l.qty, l.qty_planned, l.value_mu, i.name, i.kind FROM stock_doc_lines l JOIN stock_bouquets b ON b.assembly_doc_id = l.doc_id JOIN stock_items i ON i.id = l.item_id WHERE b.id = ? ORDER BY l.line_no`).bind(id),
    db.prepare(`SELECT m.item_id, m.lot_id, -m.qty AS qty, t.received_at, t.kind FROM stock_moves m JOIN stock_bouquets b ON b.assembly_doc_id = m.doc_id JOIN stock_lots t ON t.id = m.lot_id WHERE b.id = ? AND m.reason = 'assembly' AND m.reverses_move_id IS NULL ORDER BY m.id`).bind(id),
  ]);
  const r = b!.results[0];
  if (!r) return null;
  return bouquetDTO(r, lines!.results, moves!.results, tashkentDay(app.now()));
}

export function bouquetDTO(r: Row, lines: Row[], moves: Row[], today: string): BouquetDTO {
  const price = num(r.price_current_uzs);
  const cost = { costMu: BigInt(num(r.cost_mu)), costUzs: num(r.cost_uzs), flowersCostUzs: num(r.flowers_cost_uzs), suppliesCostUzs: num(r.supplies_cost_uzs) };
  const sh = shares(cost, price);
  return {
    id: String(r.id),
    number: num(r.number),
    kind: r.kind as BouquetDTO['kind'],
    status: r.status as BouquetDTO['status'],
    cost: cost.costUzs,
    flowersCost: cost.flowersCostUzs,
    suppliesCost: cost.suppliesCostUzs,
    suggestedPrice: num(r.suggested_price_uzs),
    price: num(r.price_uzs),
    priceCurrent: price,
    costShare: sh.costShare,
    flowersShare: sh.flowersShare,
    lines: lines.map((l) => ({
      itemId: String(l.item_id), name: String(l.name), kind: l.kind as StockKind, qty: num(l.qty), plannedQty: numOrNull(l.qty_planned), cost: muToUzs(num(l.value_mu)),
      lots: moves.filter((m) => m.item_id === l.item_id).map((m) => ({ lotId: String(m.lot_id), receivedOn: String(m.received_at).slice(0, 10), qty: num(m.qty), deficit: m.kind === 'deficit' })),
    })),
    usedDeficit: num(r.used_deficit) === 1,
    deficitComment: strOrNull(r.deficit_comment),
    florist: String(r.florist_name ?? ''),
    createdAt: String(r.created_at),
    saleId: strOrNull(r.sale_id),
    ageDays: Math.max(0, daysBetween(tashkentDay(String(r.created_at)), today)),
  };
}

/** Showcase list: bouquets not sold yet (assembled «под заказ» and on the showcase). */
export async function listOpenBouquets(app: AppContext): Promise<BouquetDTO[]> {
  const db = app.repo.db;
  const [bs, lines] = await db.batch<Row>([
    db.prepare(`SELECT b.*, d.number FROM stock_bouquets b JOIN stock_docs d ON d.id = b.assembly_doc_id WHERE b.status IN ('assembled','on_showcase') ORDER BY b.created_at DESC LIMIT 100`),
    db.prepare(
      `SELECT l.doc_id, l.item_id, l.qty, l.qty_planned, l.value_mu, i.name, i.kind FROM stock_bouquets b JOIN stock_doc_lines l ON l.doc_id = b.assembly_doc_id JOIN stock_items i ON i.id = l.item_id
        WHERE b.status IN ('assembled','on_showcase') ORDER BY l.doc_id, l.line_no`,
    ),
  ]);
  const today = todayOf(app);
  return bs!.results.map((b) => bouquetDTO(b, lines!.results.filter((l) => l.doc_id === b.assembly_doc_id), [], today));
}

export async function toShowcase(app: AppContext, caller: Caller, id: string, cfg: StockConfig): Promise<BouquetDTO> {
  requireStock(caller, 'bouquet.assemble', cfg);
  const db = app.repo.db;
  const cur = await db.prepare('SELECT status FROM stock_bouquets WHERE id = ?').bind(id).all<Row>();
  if (!cur.results.length) throw new HttpError(404, 'not_found', 'Букет не найден');
  const status = cur.results[0]!.status;
  if (status === 'on_showcase') return (await loadBouquet(app, id))!;
  // Only a bouquet assembled «под заказ» goes to the showcase. A sold / disassembled / cancelled one never
  // comes back (audit CODE-1: a stale showcase list on a second phone re-opened sold bouquets).
  if (status !== 'assembled') throw new HttpError(409, 'bouquet_state', 'Букет уже продан, разобран или отменён — обновите витрину');
  try {
    // No status condition on purpose: if it changed meanwhile, the transition trigger aborts → 409 bouquet_state.
    await db.batch([db.prepare(`UPDATE stock_bouquets SET status = 'on_showcase' WHERE id = ?`).bind(id), revStmt(db)]);
  } catch (e) {
    mapPostingError(e);
  }
  return (await loadBouquet(app, id))!;
}

const disassembleSchema = z.object({
  idempotencyKey: idemKey,
  good: z.array(z.object({ itemId: z.string().min(1).max(64), qty: z.number().int().min(0).max(10_000) })).max(40).default([]),
});

export async function disassemble(app: AppContext, caller: Caller, id: string, body: unknown, cfg: StockConfig, opts: { demo?: boolean; nowIso?: string } = {}): Promise<DisassembleResultDTO> {
  requireStock(caller, 'bouquet.disassemble', cfg);
  const req = disassembleSchema.parse(body);
  const hash = await payloadHash({ ...req, bouquet: id });
  const actor = actorOf(caller);
  const db = app.repo.db;
  const [b, taken, doc] = await db.batch<Row>([
    db.prepare('SELECT id, status, assembly_doc_id FROM stock_bouquets WHERE id = ?').bind(id),
    db.prepare(
      `SELECT m.lot_id, m.item_id, -m.qty AS taken, t.unit_cost_mu, t.priority, t.expires_on, t.received_at, t.kind
         FROM stock_moves m JOIN stock_bouquets b ON b.assembly_doc_id = m.doc_id JOIN stock_lots t ON t.id = m.lot_id
        WHERE b.id = ? AND m.reason = 'assembly' AND m.reverses_move_id IS NULL ORDER BY m.id`,
    ).bind(id),
    docByKeyStmt(db, req.idempotencyKey),
  ]);
  const prior = replayOf((doc!.results[0] as unknown as DocRow) ?? null, hash, 'disassembly');
  if (prior) return disassemblyResult(app, id, prior.id, true);
  const bo = b!.results[0];
  if (!bo) throw new HttpError(404, 'not_found', 'Букет не найден');
  if (bo.status !== 'assembled' && bo.status !== 'on_showcase') throw new HttpError(409, 'bouquet_state', bo.status === 'sold' ? 'Букет уже продан' : 'Букет уже разобран или отменён');
  const lots: TakenLot[] = taken!.results.map((t) => ({
    id: String(t.lot_id), itemId: String(t.item_id), qty: 0, unitCostMu: num(t.unit_cost_mu), priority: num(t.priority), expiresOn: strOrNull(t.expires_on),
    receivedAt: String(t.received_at), taken: num(t.taken), deficit: t.kind === 'deficit',
  }));
  // same lot may appear in several moves (never in one assembly, but be safe): merge
  const merged = new Map<string, TakenLot>();
  for (const l of lots) {
    const m = merged.get(l.id);
    if (m) m.taken += l.taken;
    else merged.set(l.id, { ...l });
  }
  // «в минус» stems go back too (audit API-1): the open shortage of the deficit lot, then the receipt lots that settled it
  const deficits = [...merged.values()].filter((l) => l.deficit);
  if (deficits.length) {
    const rows = await db.batch<Row>(deficits.flatMap((d) => [
      db.prepare('SELECT qty_on_hand FROM stock_lots WHERE id = ?').bind(d.id),
      db.prepare(
        `SELECT DISTINCT t.id, t.qty_received - t.qty_on_hand AS room, t.unit_cost_mu, t.priority, t.expires_on, t.received_at
           FROM stock_moves d JOIN stock_moves r ON r.doc_id = d.doc_id AND r.line_no = d.line_no AND r.reason = 'deficit_settle' AND r.qty < 0
           JOIN stock_lots t ON t.id = r.lot_id
          WHERE d.lot_id = ? AND d.reason = 'deficit_settle' AND d.qty > 0 AND d.reverses_move_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM stock_moves x WHERE x.reverses_move_id = d.id)
            AND t.qty_received > t.qty_on_hand
          ORDER BY t.received_at DESC, t.id`,
      ).bind(d.id),
    ]));
    deficits.forEach((d, k) => {
      d.deficitOpen = Math.max(0, -num(rows[2 * k]!.results[0]?.qty_on_hand));
      d.refill = rows[2 * k + 1]!.results.map((r) => ({
        id: String(r.id), itemId: d.itemId, qty: 0, room: num(r.room), unitCostMu: num(r.unit_cost_mu), priority: num(r.priority),
        expiresOn: strOrNull(r.expires_on), receivedAt: String(r.received_at),
      }));
    });
  }
  const plan = planDisassembly([...merged.values()], new Map(req.good.map((g) => [g.itemId, g.qty])));
  const now = opts.nowIso ?? app.now().toISOString();
  const docDate = tashkentDay(now);
  const docId = crypto.randomUUID();
  const lineOf = new Map([...new Set(lots.map((l) => l.itemId))].map((it, k) => [it, k + 1]));
  const moves: MoveIn[] = plan.moves.map((m) => ({ l: lineOf.get(m.itemId)!, i: m.itemId, o: m.lotId, q: m.qty, v: m.qty * m.unitCostMu, r: m.reason, b: id }));
  const stmts: D1PreparedStatement[] = [
    headerStmt(db, { id: docId, kind: 'disassembly', docDate, key: req.idempotencyKey, hash, actor, now, demo: opts.demo }),
    // guard: status transition (a sold / already disassembled bouquet aborts the batch here)
    db.prepare(`UPDATE stock_bouquets SET status = 'disassembled', closed_doc_id = ?, closed_at = ? WHERE id = ?`).bind(docId, now, id),
    ...(moves.length ? [movesStmt(db, docId, docDate, actor.id, now, moves)] : []),
    postedStmt(db, docId, totalValue(moves), now),
    revStmt(db),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (classifyDbError(e) === 'idempotency') {
      const again = await docByKeyStmt(db, req.idempotencyKey).all<Row>();
      const p = replayOf((again.results[0] as unknown as DocRow) ?? null, hash, 'disassembly');
      if (p) return disassemblyResult(app, id, p.id, true);
    }
    mapPostingError(e);
  }
  return disassemblyResult(app, id, docId, false);
}

async function disassemblyResult(app: AppContext, bouquetId: string, docId: string, replayed: boolean): Promise<DisassembleResultDTO> {
  const { results } = await app.repo.db.prepare(`SELECT reason, SUM(qty) AS q, SUM(value_mu) AS v FROM stock_moves WHERE doc_id = ? GROUP BY reason`).bind(docId).all<Row>();
  const ret = results.find((r) => r.reason === 'disassembly_return');
  const waste = results.find((r) => r.reason === 'disassembly_waste');
  return {
    bouquet: (await loadBouquet(app, bouquetId))!,
    returned: num(ret?.q) - Math.abs(num(waste?.q)),
    wasted: Math.abs(num(waste?.q)),
    wasteUzs: muToUzs(Math.abs(num(waste?.v))),
    replayed,
  };
}

/** Cancel an assembly (storno): a florist — own, within assemblyCancelHours; the owner — always. */
export async function cancelAssembly(app: AppContext, caller: Caller, id: string, cfg: StockConfig): Promise<BouquetDTO> {
  const actor = actorOf(caller);
  const db = app.repo.db;
  const r = await db.prepare('SELECT id, status, assembly_doc_id, florist_id, created_at, used_deficit FROM stock_bouquets WHERE id = ?').bind(id).all<Row>();
  const b = r.results[0];
  if (!b) throw new HttpError(404, 'not_found', 'Букет не найден');
  if (caller.role !== 'owner') {
    requireStock(caller, 'bouquet.cancel.own', cfg);
    if (b.florist_id !== actor.id) throw new HttpError(403, 'forbidden', 'Отменить можно только свою сборку — обратитесь к владельцу');
    if (app.now().getTime() - Date.parse(String(b.created_at)) > cfg.assemblyCancelHours * 3_600_000) {
      throw new HttpError(409, 'window_expired', `Отменить сборку можно только в течение ${cfg.assemblyCancelHours} ч — обратитесь к владельцу`);
    }
  }
  if (b.status !== 'assembled' && b.status !== 'on_showcase') throw new HttpError(409, 'bouquet_state', b.status === 'sold' ? 'Букет уже продан — сначала отмените продажу' : 'Букет уже разобран или отменён');
  const now = app.now().toISOString();
  const { stmts } = await stornoStatements(app, { id: String(b.assembly_doc_id) }, actor, `storno:${String(b.assembly_doc_id)}`, now, [
    db.prepare(`UPDATE stock_bouquets SET status = 'cancelled', closed_at = ? WHERE id = ?`).bind(now, id),
  ]);
  try {
    await db.batch(stmts);
  } catch (e) {
    const kind = classifyDbError(e);
    if (kind === 'idempotency') throw new HttpError(409, 'already_cancelled', 'Сборка уже отменена');
    // A storno mirrors the assembly moves. If the bouquet was assembled «в минус» and a receipt has since settled
    // the shortfall, mirroring into the settled deficit lot is impossible (audit CODE-4). Disassembly handles
    // this case correctly (stems go back to the lots that actually hold them), so point the user there.
    if (kind === 'lot_bounds' && num(b.used_deficit) === 1) {
      throw new HttpError(409, 'conflict', 'Букет собирали «в минус», а недостачу уже закрыла поставка — отменить сборку нельзя. Разберите букет: все стебли вернутся на склад');
    }
    mapPostingError(e);
  }
  return (await loadBouquet(app, id))!;
}

export { type DocRow };
