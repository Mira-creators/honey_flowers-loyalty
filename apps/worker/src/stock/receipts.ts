/**
 * M2/M3 Receipts → lots → ledger (architecture §2.3, §4.6, §4.7).
 * Preview (no writes) and posting share one computation (packages/stock computeReceipt).
 * Posting batch: header → lots → moves (receipt + deficit settle, ONE statement) → lines →
 * last purchase price → posted → stock_rev. Cancel = storno, only while the lots are untouched.
 */
import type { ReceiptFormDTO, ReceiptListItemDTO, ReceiptPreviewDTO, ReceiptRequest, ReceiptResultDTO } from '@honey/contracts';
import { addDays, computeReceipt, divRound, muToUzs, ReceiptError, type ReceiptInput, type ReceiptItemInfo, type StockConfig } from '@honey/stock';
import { z } from 'zod';
import type { Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import {
  actorOf, backoff, classifyDbError, docByKeyStmt, headerStmt, idemKey, mapPostingError, movesStmt, num, numOrNull, payloadHash, postedStmt, replayOf,
  requireStock, revStmt, strOrNull, stornoStatements, todayOf, totalValue, type Actor, type DocRow, type MoveIn, type Row,
} from './core.js';

const money2 = z.number().nonnegative().max(1e13).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'не больше 2 знаков после запятой');

export const receiptSchema = z
  .object({
    idempotencyKey: idemKey,
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    supplierId: z.string().min(1).max(64).nullish(),
    currency: z.enum(['UZS', 'USD']),
    fxRate: z.number().positive().max(1_000_000).nullish(),
    priceMode: z.enum(['lines', 'total']),
    total: money2.nullish(),
    extraCost: z.number().int().min(0).max(10_000_000_000).default(0),
    lines: z
      .array(
        z.object({
          itemId: z.string().min(1).max(64),
          qty: z.number().int().min(1).max(1_000_000),
          unit: z.enum(['base', 'pack']).default('base'),
          price: money2.nullish(),
          per: z.enum(['unit', 'pack', 'line']).optional(),
        }),
      )
      .min(1)
      .max(60),
    note: z.string().trim().max(500).nullish(),
    confirm: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.currency === 'USD' && !v.fxRate) ctx.addIssue({ code: 'custom', path: ['fxRate'], message: 'укажите курс доллара' });
    if (v.currency === 'USD' && v.fxRate && Math.abs(v.fxRate * 100 - Math.round(v.fxRate * 100)) > 1e-6) ctx.addIssue({ code: 'custom', path: ['fxRate'], message: 'курс — не больше 2 знаков после запятой' });
    if (v.priceMode === 'total' && (v.total === null || v.total === undefined)) ctx.addIssue({ code: 'custom', path: ['total'], message: 'укажите сумму поставки' });
    if (v.currency === 'UZS') {
      if (v.total !== null && v.total !== undefined && !Number.isInteger(v.total)) ctx.addIssue({ code: 'custom', path: ['total'], message: 'сумма в сумах — целое число' });
      v.lines.forEach((l, i) => {
        if (l.price !== null && l.price !== undefined && !Number.isInteger(l.price)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'price'], message: 'цена в сумах — целое число' });
      });
    }
  });

export type ReceiptReq = z.infer<typeof receiptSchema>;

const toMinor = (v: number, cur: 'UZS' | 'USD') => (cur === 'USD' ? Math.round(v * 100) : Math.round(v));

interface Loaded {
  items: Map<string, ReceiptItemInfo & { sellDays: number | null; vaseLifeDays: number | null }>;
  deficits: Array<{ id: string; itemId: string; qty: number; costMu: number }>;
}

async function loadForReceipt(app: AppContext, req: ReceiptReq): Promise<Loaded & { doc: DocRow | null; supplierOk: boolean }> {
  const db = app.repo.db;
  const ids = [...new Set(req.lines.map((l) => l.itemId))];
  const ph = ids.map(() => '?').join(',');
  const [items, deficits, doc, sup] = await db.batch<Row>([
    db
      .prepare(
        `SELECT i.id, i.name, i.kind, i.pack_size, i.track_stock, i.std_cost_mu, i.sell_days, i.vase_life_days, i.active, b.last_cost_mu
           FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id WHERE i.id IN (${ph})`,
      )
      .bind(...ids),
    db.prepare(`SELECT id, item_id, qty_on_hand, unit_cost_mu FROM stock_lots WHERE kind = 'deficit' AND qty_on_hand < 0 AND item_id IN (${ph}) ORDER BY created_at, id`).bind(...ids),
    docByKeyStmt(db, req.idempotencyKey),
    db.prepare('SELECT COUNT(*) AS n FROM stock_suppliers WHERE id = ?').bind(req.supplierId ?? ''),
  ]);
  const map: Loaded['items'] = new Map();
  for (const r of items!.results) {
    if (num(r.active) !== 1) continue;
    map.set(String(r.id), {
      id: String(r.id), name: String(r.name), kind: r.kind as ReceiptItemInfo['kind'], packSize: numOrNull(r.pack_size), trackStock: num(r.track_stock) === 1,
      lastCostMu: numOrNull(r.last_cost_mu), stdCostMu: numOrNull(r.std_cost_mu), sellDays: numOrNull(r.sell_days), vaseLifeDays: numOrNull(r.vase_life_days),
    });
  }
  return {
    items: map,
    deficits: deficits!.results.map((d) => ({ id: String(d.id), itemId: String(d.item_id), qty: num(d.qty_on_hand), costMu: num(d.unit_cost_mu) })),
    doc: (doc!.results[0] as unknown as DocRow) ?? null,
    supplierOk: !req.supplierId || num(sup!.results[0]?.n) > 0,
  };
}

function checkDate(app: AppContext, caller: Caller, req: ReceiptReq, cfg: StockConfig): { docDate: string; backdated: boolean } {
  const today = todayOf(app);
  const docDate = req.docDate ?? today;
  if (Number.isNaN(Date.parse(`${docDate}T00:00:00Z`)) || new Date(`${docDate}T00:00:00Z`).toISOString().slice(0, 10) !== docDate) {
    throw new HttpError(400, 'validation', 'Неверные данные: docDate: такой даты нет');
  }
  if (docDate > today) throw new HttpError(400, 'validation', 'Дата прихода не может быть в будущем');
  if (docDate < today) {
    requireStock(caller, 'receipt.backdate', cfg);
    if (docDate < addDays(today, -cfg.backdateDays)) throw new HttpError(400, 'validation', `Задним числом можно провести не больше ${cfg.backdateDays} дн.`);
  }
  return { docDate, backdated: docDate < today };
}

function computeOrThrow(req: ReceiptReq, items: Loaded['items']) {
  const input: ReceiptInput = {
    currency: req.currency,
    fxRateX100: req.currency === 'USD' ? Math.round((req.fxRate ?? 0) * 100) : null,
    priceMode: req.priceMode,
    total: req.priceMode === 'total' && req.total !== null && req.total !== undefined ? toMinor(req.total, req.currency) : null,
    extraCostUzs: req.extraCost,
    lines: req.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unit: l.unit, price: l.price === null || l.price === undefined ? null : toMinor(l.price, req.currency), per: l.per })),
  };
  try {
    return { input, result: computeReceipt(input, items) };
  } catch (e) {
    if (e instanceof ReceiptError) throw new HttpError(e.code === 'receipt_total_short' ? 422 : 400, e.code === 'receipt_total_short' ? 'receipt_total_short' : 'validation', e.message);
    throw e;
  }
}

function previewDTO(req: ReceiptReq, comp: ReturnType<typeof computeOrThrow>, items: Loaded['items'], extraWarnings: ReceiptPreviewDTO['warnings']): ReceiptPreviewDTO {
  const usd = req.currency === 'USD';
  const fx = comp.input.fxRateX100;
  const curOfMu = (mu: bigint) => (usd && fx ? Number(divRound(mu * 10n, BigInt(fx))) / 100 : muToUzs(mu)); // dollars (2 decimals) or сум
  return {
    currency: req.currency,
    fxRate: usd ? (fx ?? 0) / 100 : null,
    lines: comp.result.lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      name: items.get(l.itemId)?.name ?? '',
      qtyBase: l.qtyBase,
      manual: l.manual,
      lineValue: curOfMu(l.valueMu),
      unitCostUzs: Math.round(l.unitCostMu / 10) / 100,
      unitCostCur: usd && fx ? Math.round(l.unitCostMu * 10 / fx) / 100 : Math.round(l.unitCostMu / 10) / 100,
      unitCostMu: l.unitCostMu,
      landedUzs: muToUzs(l.landedMu),
      lastCostUzs: items.get(l.itemId)?.lastCostMu ? Math.round(items.get(l.itemId)!.lastCostMu! / 10) / 100 : null,
    })),
    goodsUzs: muToUzs(comp.result.goodsMu),
    goodsCur: curOfMu(comp.result.goodsMu),
    extraUzs: muToUzs(comp.result.extraMu),
    totalUzs: muToUzs(comp.result.goodsMu + comp.result.extraMu),
    warnings: [...comp.result.warnings, ...extraWarnings],
  };
}

export async function previewReceipt(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig): Promise<ReceiptPreviewDTO> {
  requireStock(caller, 'receipt.post', cfg);
  const req = receiptSchema.parse(body);
  const d = checkDate(app, caller, req, cfg);
  const loaded = await loadForReceipt(app, req);
  const comp = computeOrThrow(req, loaded.items);
  return previewDTO(req, comp, loaded.items, d.backdated ? [{ code: 'backdate', message: `Приход задним числом: ${d.docDate}` }] : []);
}

/** Moves settling deficit lots of the received items (§4.6), right after each receipt move. */
function settleMoves(lineNo: number, itemId: string, lotId: string, qty: number, unitCostMu: number, deficits: Loaded['deficits']): MoveIn[] {
  const out: MoveIn[] = [];
  let left = qty;
  for (const d of deficits) {
    if (d.itemId !== itemId || d.qty >= 0 || left <= 0) continue;
    const k = Math.min(-d.qty, left);
    out.push({ l: lineNo, i: itemId, o: lotId, q: -k, v: -k * unitCostMu, r: 'deficit_settle' });
    out.push({ l: lineNo, i: itemId, o: d.id, q: k, v: k * d.costMu, r: 'deficit_settle' });
    d.qty += k;
    left -= k;
  }
  return out;
}

export async function postReceipt(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig, opts: { demo?: boolean; nowIso?: string } = {}): Promise<ReceiptResultDTO> {
  requireStock(caller, 'receipt.post', cfg);
  const req = receiptSchema.parse(body);
  const hash = await payloadHash({ ...req, confirm: undefined });
  const actor = actorOf(caller);
  const d = checkDate(app, caller, req, cfg);
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await loadForReceipt(app, req);
    const prior = replayOf(loaded.doc, hash, 'receipt');
    if (prior) return receiptResult(app, prior.id, true);
    if (!loaded.supplierOk) throw new HttpError(400, 'validation', 'Поставщик не найден');
    const comp = computeOrThrow(req, loaded.items);
    const warnings = [...comp.result.warnings, ...(d.backdated ? [{ code: 'backdate' as const, message: `Приход задним числом: ${d.docDate}` }] : [])];
    if (warnings.length && !req.confirm) {
      throw new HttpError(409, 'confirm_required', `Проверьте предупреждения и подтвердите: ${warnings.map((w) => w.message).join('; ')}`, { warnings });
    }
    const now = opts.nowIso ?? app.now().toISOString();
    const db = app.repo.db;
    const docId = crypto.randomUUID();
    const receivedAt = `${d.docDate}T${now.slice(11)}`;
    const lots = comp.result.lines.map((l) => {
      const it = loaded.items.get(l.itemId)!;
      return {
        id: crypto.randomUUID(), item: l.itemId, sup: req.supplierId ?? null, recv: receivedAt,
        sell: it.sellDays ? addDays(d.docDate, it.sellDays) : null, exp: it.vaseLifeDays ? addDays(d.docDate, it.vaseLifeDays) : null,
        qty: l.qtyBase, cost: l.unitCostMu, cur: l.priceCurX100, line: l.lineNo,
      };
    });
    const deficits = loaded.deficits.map((x) => ({ ...x }));
    const moves: MoveIn[] = [];
    let settled = 0;
    for (const lot of lots) {
      moves.push({ l: lot.line, i: lot.item, o: lot.id, q: lot.qty, v: lot.qty * lot.cost, r: 'receipt' });
      const s = settleMoves(lot.line, lot.item, lot.id, lot.qty, lot.cost, deficits);
      settled += s.filter((m) => m.q > 0).reduce((a, m) => a + m.q, 0);
      moves.push(...s);
    }
    const stmts: D1PreparedStatement[] = [
      headerStmt(db, {
        id: docId, kind: 'receipt', docDate: d.docDate, key: req.idempotencyKey, hash, actor, now, supplierId: req.supplierId ?? null, extraCostUzs: req.extraCost,
        currency: req.currency, fxRateX100: comp.input.fxRateX100, priceMode: req.priceMode, inputTotal: comp.input.total ?? null, note: req.note ?? null, demo: opts.demo,
      }),
      db
        .prepare(
          `INSERT INTO stock_lots (id, item_id, kind, receipt_doc_id, supplier_id, received_at, sell_by, expires_on, qty_received, unit_cost_mu, price_cur_x100, currency, created_at)
           SELECT json_extract(value,'$.id'), json_extract(value,'$.item'), 'normal', ?1, json_extract(value,'$.sup'), json_extract(value,'$.recv'), json_extract(value,'$.sell'),
                  json_extract(value,'$.exp'), json_extract(value,'$.qty'), json_extract(value,'$.cost'), json_extract(value,'$.cur'), ?2, ?3
             FROM json_each(?4)`,
        )
        .bind(docId, req.currency, now, JSON.stringify(lots)),
      movesStmt(db, docId, d.docDate, actor.id, now, moves),
      db
        .prepare(
          `INSERT INTO stock_doc_lines (doc_id, line_no, item_id, qty, input_qty, input_unit, input_price, input_price_per, ref_cost_mu, manual_price, value_mu, unit_cost_mu, landed_mu, rounding_mu, lot_id)
           SELECT ?1, json_extract(value,'$.n'), json_extract(value,'$.i'), json_extract(value,'$.q'), json_extract(value,'$.iq'), json_extract(value,'$.iu'), json_extract(value,'$.ip'),
                  json_extract(value,'$.per'), json_extract(value,'$.ref'), json_extract(value,'$.man'), json_extract(value,'$.val'), json_extract(value,'$.uc'), json_extract(value,'$.lm'),
                  json_extract(value,'$.rm'), json_extract(value,'$.lot')
             FROM json_each(?2)`,
        )
        .bind(docId, JSON.stringify(comp.result.lines.map((l, k) => ({
          n: l.lineNo, i: l.itemId, q: l.qtyBase, iq: l.inputQty, iu: l.inputUnit, ip: l.inputPrice, per: l.per, ref: l.refCostMu, man: l.manual ? 1 : 0,
          val: Number(l.valueMu), uc: l.unitCostMu, lm: Number(l.landedMu), rm: l.roundingMu, lot: lots[k]!.id,
        })))),
      // Reference price for the next receipt / deficit cost: the last purchase price of the item.
      db
        .prepare(
          `INSERT INTO stock_item_balances (item_id, qty, value_mu, last_cost_mu, last_receipt_on, updated_at)
           SELECT json_extract(value,'$.i'), 0, 0, json_extract(value,'$.c'), ?1, ?2 FROM json_each(?3) WHERE true
           ON CONFLICT(item_id) DO UPDATE SET last_cost_mu = excluded.last_cost_mu, last_receipt_on = excluded.last_receipt_on
            WHERE stock_item_balances.last_receipt_on IS NULL OR stock_item_balances.last_receipt_on <= excluded.last_receipt_on`,
        )
        .bind(d.docDate, now, JSON.stringify(lots.map((l) => ({ i: l.item, c: l.cost })))),
      postedStmt(db, docId, totalValue(moves.filter((m) => m.r === 'receipt')), now),
      revStmt(db),
    ];
    try {
      await db.batch(stmts);
      const out = await receiptResult(app, docId, false);
      return { ...out, settledDeficit: settled };
    } catch (e) {
      const k = classifyDbError(e);
      if (k === 'idempotency') continue; // re-read: replay or conflict
      if (k === 'lot_bounds' && attempt < 3) {
        await backoff(attempt); // the deficit changed meanwhile (§4.6): plan again on fresh numbers
        continue;
      }
      if (k === 'lot_bounds') throw new HttpError(409, 'conflict', 'Остаток одновременно изменился — проверьте и повторите');
      mapPostingError(e);
    }
  }
  throw new HttpError(409, 'conflict', 'Остаток одновременно изменился — проверьте и повторите');
}

async function receiptResult(app: AppContext, docId: string, replayed: boolean): Promise<ReceiptResultDTO> {
  const db = app.repo.db;
  const [doc, lines] = await db.batch<Row>([
    db.prepare('SELECT id, number, currency, fx_rate_x100, extra_cost_uzs, total_value_mu FROM stock_docs WHERE id = ?').bind(docId),
    db.prepare(`SELECT l.line_no, l.item_id, i.name, l.qty, l.manual_price, l.value_mu, l.unit_cost_mu, l.landed_mu FROM stock_doc_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.doc_id = ? ORDER BY l.line_no`).bind(docId),
  ]);
  const d = doc!.results[0]!;
  const usd = d.currency === 'USD';
  const fx = numOrNull(d.fx_rate_x100);
  const curOfMu = (mu: number) => (usd && fx ? Math.round((mu * 10) / fx) / 100 : Math.round(mu / 1000));
  const goodsMu = lines!.results.reduce((a, l) => a + num(l.value_mu), 0);
  const preview: ReceiptPreviewDTO = {
    currency: usd ? 'USD' : 'UZS',
    fxRate: fx ? fx / 100 : null,
    lines: lines!.results.map((l) => ({
      lineNo: num(l.line_no), itemId: String(l.item_id), name: String(l.name), qtyBase: num(l.qty), manual: num(l.manual_price) === 1,
      lineValue: curOfMu(num(l.value_mu)), unitCostUzs: Math.round(num(l.unit_cost_mu) / 10) / 100,
      unitCostCur: usd && fx ? Math.round((num(l.unit_cost_mu) * 10) / fx) / 100 : Math.round(num(l.unit_cost_mu) / 10) / 100,
      unitCostMu: num(l.unit_cost_mu), landedUzs: muToUzs(num(l.landed_mu)), lastCostUzs: null,
    })),
    goodsUzs: muToUzs(goodsMu),
    goodsCur: curOfMu(goodsMu),
    extraUzs: num(d.extra_cost_uzs),
    totalUzs: muToUzs(num(d.total_value_mu)),
    warnings: [],
  };
  return { receiptId: docId, number: num(d.number), replayed, preview, settledDeficit: 0 };
}

export async function receiptForm(app: AppContext, caller: Caller, cfg: StockConfig): Promise<ReceiptFormDTO> {
  requireStock(caller, 'receipt.post', cfg);
  const db = app.repo.db;
  const [fx, sup, n] = await db.batch<Row>([
    db.prepare(`SELECT fx_rate_x100 FROM stock_docs WHERE kind = 'receipt' AND currency = 'USD' AND status = 'posted' ORDER BY created_at DESC LIMIT 1`),
    db.prepare('SELECT id, name, phone FROM stock_suppliers WHERE active = 1 ORDER BY name LIMIT 200'),
    db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM stock_docs WHERE kind = 'receipt'`),
  ]);
  const f = numOrNull(fx!.results[0]?.fx_rate_x100);
  return {
    lastFxRate: f ? f / 100 : null,
    suppliers: sup!.results.map((r) => ({ id: String(r.id), name: String(r.name), phone: strOrNull(r.phone) })),
    today: todayOf(app),
    backdateDays: cfg.backdateDays,
    canBackdate: caller.role === 'owner',
    nextNumber: num(n!.results[0]?.n),
  };
}

export async function listReceipts(app: AppContext, opts: { from?: string | null; to?: string | null; limit?: number; cursor?: string | null }): Promise<{ items: ReceiptListItemDTO[]; cursor: string | null }> {
  const db = app.repo.db;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 500);
  const from = opts.from ?? '0000-00-00';
  const to = opts.to ?? '9999-12-31';
  const [cAt, cId] = (opts.cursor ?? '').split('|');
  const { results } = await db
    .prepare(
      `SELECT d.id, d.number, d.doc_date, d.status, d.currency, d.fx_rate_x100, d.price_mode, d.total_value_mu, d.extra_cost_uzs, d.actor_id, d.created_at, s.name AS supplier,
              (SELECT COUNT(*) FROM stock_doc_lines l WHERE l.doc_id = d.id) AS lines,
              (SELECT COUNT(*) FROM stock_lots t WHERE t.receipt_doc_id = d.id AND t.qty_on_hand <> t.qty_received) AS touched
         FROM (SELECT * FROM stock_docs WHERE kind = 'receipt' AND status IN ('posted','cancelled') AND doc_date BETWEEN ? AND ?
                  AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC LIMIT ?) d
         LEFT JOIN stock_suppliers s ON s.id = d.supplier_id ORDER BY d.created_at DESC, d.id DESC`,
    )
    .bind(from, to, cAt ?? '', cAt ?? '', cAt ?? '', cId ?? '', limit + 1)
    .all<Row>();
  const page = results.slice(0, limit);
  const names = await app.repo.actorNames(page.map((r) => String(r.actor_id)));
  return {
    items: page.map((r) => receiptRow(r, names)),
    cursor: results.length > limit ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}` : null,
  };
}

export function receiptRow(r: Row, names: Map<string, string>): ReceiptListItemDTO {
  return {
    id: String(r.id), number: num(r.number), docDate: String(r.doc_date), status: r.status as 'posted' | 'cancelled', currency: r.currency as 'UZS' | 'USD',
    fxRate: numOrNull(r.fx_rate_x100) ? num(r.fx_rate_x100) / 100 : null, priceMode: (r.price_mode ?? 'lines') as 'lines' | 'total',
    totalUzs: muToUzs(num(r.total_value_mu)), extraUzs: num(r.extra_cost_uzs), lines: num(r.lines), supplier: strOrNull(r.supplier),
    actor: names.get(String(r.actor_id)) ?? String(r.actor_id), createdAt: String(r.created_at), cancellable: r.status === 'posted' && num(r.touched) === 0,
  };
}

/** Owner: cancel a receipt (storno) while its lots are untouched; otherwise 409 lot_used. */
export async function cancelReceipt(app: AppContext, caller: Caller, docId: string, cfg: StockConfig): Promise<{ cancelled: true; stornoId: string }> {
  requireStock(caller, 'receipt.cancel', cfg);
  const db = app.repo.db;
  const [doc, lots] = await db.batch<Row>([
    db.prepare(`SELECT id, kind, status FROM stock_docs WHERE id = ?`).bind(docId),
    db.prepare(`SELECT l.id, l.qty_received, l.qty_on_hand, i.name FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.receipt_doc_id = ?`).bind(docId),
  ]);
  const d = doc!.results[0];
  if (!d || d.kind !== 'receipt') throw new HttpError(404, 'not_found', 'Приход не найден');
  if (d.status === 'cancelled') throw new HttpError(409, 'already_cancelled', 'Приход уже отменён');
  const lotUsed = (lot: Row) =>
    new HttpError(409, 'lot_used', `Из партии «${String(lot.name)}» уже взяли ${num(lot.qty_received) - num(lot.qty_on_hand)} из ${num(lot.qty_received)} — отменить приход нельзя. Оформите списание остатка или исправьте инвентаризацией`);
  // Settled deficit stems are not "used": the storno mirrors the settle moves too. Exact check = CHECK in the batch.
  const settled = await db.prepare(`SELECT lot_id, -SUM(qty) AS q FROM stock_moves WHERE doc_id = ? AND reason = 'deficit_settle' AND qty < 0 GROUP BY lot_id`).bind(docId).all<Row>();
  const settledBy = new Map(settled.results.map((s) => [String(s.lot_id), num(s.q)]));
  for (const lot of lots!.results) if (num(lot.qty_on_hand) + (settledBy.get(String(lot.id)) ?? 0) !== num(lot.qty_received)) throw lotUsed(lot);
  const actor = actorOf(caller);
  const now = app.now().toISOString();
  const { stmts, stornoId } = await stornoStatements(app, { id: docId }, actor, `storno:${docId}`, now);
  try {
    await db.batch(stmts);
  } catch (e) {
    if (classifyDbError(e) === 'lot_bounds') {
      const fresh = await db.prepare(`SELECT l.id, l.qty_received, l.qty_on_hand, i.name FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.receipt_doc_id = ? AND l.qty_on_hand <> l.qty_received`).bind(docId).all<Row>();
      throw lotUsed(fresh.results[0] ?? { name: '?', qty_received: 0, qty_on_hand: 0 });
    }
    if (classifyDbError(e) === 'idempotency') throw new HttpError(409, 'already_cancelled', 'Приход уже отменён');
    mapPostingError(e);
  }
  return { cancelled: true, stornoId };
}

export type { Actor };
