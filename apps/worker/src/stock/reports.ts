/**
 * Owner views: the Mini App «Склад» overview and the console tables (balances, receipts, bouquets,
 * write-offs) with period filters. Aggregates come from caches (stock_item_balances, stock_daily,
 * partial indexes) — never a scan of the journal. The console builds CSV in the browser from these
 * pages (existing pattern: apps/miniapp/src/console/files.ts, formula-injection safe).
 */
import type { StockBalanceRowDTO, StockBouquetRowDTO, StockOverviewDTO, StockPageDTO, StockWriteoffRowDTO } from '@honey/contracts';
import { addDays, freshnessOf, muToUzs, type StockConfig } from '@honey/stock';
import type { AppContext } from '../context.js';
import { num, numOrNull, strOrNull, todayOf, type Row } from './core.js';
import { receiptRow } from './receipts.js';
import { pendingWriteoffs } from './writeoffs.js';

/** Start of a Tashkent calendar day as an ISO instant. */
export const dayStartIso = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 5 * 3_600_000).toISOString();

const WASTE = `('writeoff_wilt','writeoff_damage','disassembly_waste')`;

export async function overview(app: AppContext, cfg: StockConfig): Promise<StockOverviewDTO> {
  const db = app.repo.db;
  const today = todayOf(app);
  const start = dayStartIso(today);
  const weekFrom = addDays(today, -6);
  const weekStart = dayStartIso(weekFrom);
  const [bal, low, fresh, bq, sales, waste, cogs, rec, loyal, def, show] = await db.batch<Row>([
    db.prepare(`SELECT COALESCE(SUM(b.value_mu), 0) AS v, COUNT(*) AS n FROM stock_item_balances b JOIN stock_items i ON i.id = b.item_id WHERE i.track_stock = 1`),
    db.prepare(
      `SELECT i.id, i.name, COALESCE(b.qty, 0) AS qty FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id
        WHERE i.active = 1 AND i.track_stock = 1 AND COALESCE(b.qty, 0) < COALESCE(i.pack_size, 5) ORDER BY COALESCE(b.qty, 0), i.name LIMIT 12`,
    ),
    db.prepare(`SELECT l.sell_by, l.qty_on_hand, l.unit_cost_mu, i.warn_days FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.qty_on_hand > 0 AND l.sell_by <= ?`).bind(addDays(today, 30)),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_uzs), 0) AS cost FROM stock_bouquets WHERE created_at >= ? AND status <> 'cancelled'`).bind(start),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_uzs), 0) AS rev, COALESCE(SUM(cost_uzs), 0) AS cost FROM stock_sales WHERE created_at >= ? AND status = 'paid'`).bind(start),
    db.prepare(`SELECT COALESCE(-SUM(value_mu), 0) AS v FROM stock_daily WHERE day >= ? AND reason IN ${WASTE}`).bind(weekFrom),
    db.prepare(`SELECT COALESCE(SUM(cost_uzs), 0) AS v FROM stock_sales WHERE created_at >= ? AND status = 'paid'`).bind(weekStart),
    // last 5 receipts: pick them by the (kind, number) index first, compute the per-row counts only for those 5
    db.prepare(
      `SELECT d.id, d.number, d.doc_date, d.status, d.currency, d.fx_rate_x100, d.price_mode, d.total_value_mu, d.extra_cost_uzs, d.actor_id, d.created_at, s.name AS supplier,
              (SELECT COUNT(*) FROM stock_doc_lines l WHERE l.doc_id = d.id) AS lines,
              (SELECT COUNT(*) FROM stock_lots t WHERE t.receipt_doc_id = d.id AND t.qty_on_hand <> t.qty_received) AS touched
         FROM (SELECT * FROM stock_docs WHERE kind = 'receipt' AND status IN ('posted','cancelled') ORDER BY number DESC LIMIT 5) d
         LEFT JOIN stock_suppliers s ON s.id = d.supplier_id ORDER BY d.number DESC`,
    ),
    db.prepare(`SELECT COUNT(*) AS n FROM stock_sales WHERE loyalty_status IN ('pending','failed')`),
    db.prepare(`SELECT l.item_id, i.name, SUM(l.qty_on_hand) AS qty FROM stock_lots l JOIN stock_items i ON i.id = l.item_id WHERE l.kind = 'deficit' AND l.qty_on_hand < 0 GROUP BY l.item_id`),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price_current_uzs), 0) AS v FROM stock_bouquets WHERE status IN ('assembled','on_showcase')`),
  ]);
  const exp = { overdue: 0, today: 0, soon: 0, atRiskUzs: 0 };
  let riskMu = 0n;
  for (const l of fresh!.results) {
    const f = freshnessOf(strOrNull(l.sell_by), num(l.warn_days), today);
    if (f === 'fresh') continue;
    exp[f]++;
    riskMu += BigInt(num(l.qty_on_hand)) * BigInt(num(l.unit_cost_mu));
  }
  exp.atRiskUzs = muToUzs(riskMu);
  const s = sales!.results[0]!;
  const wasteUzs = muToUzs(num(waste!.results[0]?.v));
  const cogsUzs = num(cogs!.results[0]?.v);
  const names = await app.repo.actorNames(rec!.results.map((r) => String(r.actor_id)));
  return {
    today,
    stockValueUzs: muToUzs(num(bal!.results[0]?.v)),
    items: num(bal!.results[0]?.n),
    lowItems: low!.results.map((r) => ({ itemId: String(r.id), name: String(r.name), qty: num(r.qty) })),
    expiring: exp,
    todayBouquets: {
      count: num(bq!.results[0]?.n),
      sold: num(s.n),
      revenueUzs: num(s.rev),
      costUzs: num(s.cost),
      avgMarginPct: num(s.rev) > 0 ? Math.round(((num(s.rev) - num(s.cost)) / num(s.rev)) * 1000) / 10 : null,
    },
    wasteWeek: { wasteUzs, cogsUzs, pct: wasteUzs + cogsUzs > 0 ? Math.round((wasteUzs / (wasteUzs + cogsUzs)) * 1000) / 10 : null, normPct: cfg.wasteTargets.normPct, alarmPct: cfg.wasteTargets.alarmPct },
    lastReceipts: rec!.results.map((r) => receiptRow(r, names)),
    pendingApprovals: await pendingWriteoffs(app, 10),
    loyaltyPending: num(loyal!.results[0]?.n),
    deficits: def!.results.map((r) => ({ itemId: String(r.item_id), name: String(r.name), qty: num(r.qty) })),
    showcase: { count: num(show!.results[0]?.n), valueUzs: num(show!.results[0]?.v) },
  };
}

export async function balances(app: AppContext): Promise<StockBalanceRowDTO[]> {
  const db = app.repo.db;
  const [items, lots] = await db.batch<Row>([
    db.prepare(
      `SELECT i.id, i.sku, i.name, i.grp, i.kind, i.display_unit, COALESCE(b.qty, 0) AS qty, COALESCE(b.value_mu, 0) AS value_mu, b.last_cost_mu
         FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id WHERE i.track_stock = 1 ORDER BY i.grp, i.sort_order, i.name`,
    ),
    db.prepare(`SELECT item_id, COUNT(*) AS n, MIN(received_at) AS oldest FROM stock_lots WHERE qty_on_hand > 0 GROUP BY item_id`),
  ]);
  const by = new Map(lots!.results.map((l) => [String(l.item_id), l]));
  return items!.results.map((r) => ({
    itemId: String(r.id), sku: String(r.sku), name: String(r.name), group: String(r.grp ?? ''), kind: r.kind as StockBalanceRowDTO['kind'], unit: String(r.display_unit),
    qty: num(r.qty), valueUzs: muToUzs(num(r.value_mu)), lots: num(by.get(String(r.id))?.n), oldestOn: by.get(String(r.id))?.oldest ? String(by.get(String(r.id))!.oldest).slice(0, 10) : null,
    lastCostUzs: numOrNull(r.last_cost_mu) !== null ? Math.round(num(r.last_cost_mu) / 10) / 100 : null,
  }));
}

const PAGE = 500;

function cursorParts(cursor: string | null | undefined): [string, string] {
  const [a, b] = (cursor ?? '').split('|');
  return [a ?? '', b ?? ''];
}

export async function bouquetsPage(app: AppContext, from: string, to: string, cursor: string | null, limit = PAGE): Promise<StockPageDTO<StockBouquetRowDTO>> {
  const db = app.repo.db;
  const [cAt, cId] = cursorParts(cursor);
  const lim = Math.min(Math.max(limit, 1), PAGE);
  const { results } = await db
    .prepare(
      `SELECT b.id, d.number, b.created_at, b.kind, b.status, b.florist_name, b.cost_uzs, b.suggested_price_uzs, b.price_current_uzs, b.used_deficit,
              (SELECT sl.price_uzs FROM stock_sale_lines sl JOIN stock_sales s ON s.id = sl.sale_id WHERE sl.sale_id = b.sale_id AND sl.bouquet_id = b.id AND s.status = 'paid') AS sold_for,
              (SELECT group_concat(i.name || ' × ' || l.qty, '; ') FROM stock_doc_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.doc_id = b.assembly_doc_id) AS composition
         FROM stock_bouquets b JOIN stock_docs d ON d.id = b.assembly_doc_id
        WHERE b.created_at >= ? AND b.created_at < ? AND (? = '' OR b.created_at < ? OR (b.created_at = ? AND b.id < ?))
        ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(dayStartIso(from), dayStartIso(addDays(to, 1)), cAt, cAt, cAt, cId, lim + 1)
    .all<Row>();
  const page = results.slice(0, lim);
  return {
    items: page.map((r) => {
      const sold = numOrNull(r.sold_for);
      return {
        id: String(r.id), number: num(r.number), createdAt: String(r.created_at), kind: r.kind as StockBouquetRowDTO['kind'], status: r.status as StockBouquetRowDTO['status'],
        florist: String(r.florist_name ?? ''), cost: num(r.cost_uzs), suggestedPrice: num(r.suggested_price_uzs), price: num(r.price_current_uzs), soldFor: sold,
        marginPct: sold && sold > 0 ? Math.round(((sold - num(r.cost_uzs)) / sold) * 1000) / 10 : null, usedDeficit: num(r.used_deficit) === 1, composition: String(r.composition ?? ''),
      };
    }),
    cursor: results.length > lim ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}` : null,
  };
}

export async function writeoffsPage(app: AppContext, from: string, to: string, cursor: string | null, limit = PAGE): Promise<StockPageDTO<StockWriteoffRowDTO>> {
  const db = app.repo.db;
  const [cAt, cId] = cursorParts(cursor);
  const lim = Math.min(Math.max(limit, 1), PAGE);
  const { results } = await db
    .prepare(
      `SELECT d.id, d.number, d.doc_date, d.created_at, d.actor_id, d.approval, d.status, m.id AS move_id, i.name, -m.qty AS qty, m.reason, -m.value_mu AS v
         FROM stock_docs d JOIN stock_moves m ON m.doc_id = d.id JOIN stock_items i ON i.id = m.item_id
        WHERE d.kind IN ('writeoff','disassembly') AND d.doc_date BETWEEN ? AND ? AND m.qty < 0 AND m.reverses_move_id IS NULL
          AND (? = '' OR d.created_at < ? OR (d.created_at = ? AND m.id < CAST(? AS INTEGER)))
        ORDER BY d.created_at DESC, m.id DESC LIMIT ?`,
    )
    .bind(from, to, cAt, cAt, cAt, cId || '0', lim + 1)
    .all<Row>();
  const page = results.slice(0, lim);
  const names = await app.repo.actorNames(page.map((r) => String(r.actor_id)));
  return {
    items: page.map((r) => ({
      docId: String(r.id), number: num(r.number), docDate: String(r.doc_date), createdAt: String(r.created_at), actor: names.get(String(r.actor_id)) ?? String(r.actor_id),
      item: String(r.name), qty: num(r.qty), reason: (String(r.reason) === 'disassembly_waste' ? 'disassembly_waste' : String(r.reason).replace('writeoff_', '')) as StockWriteoffRowDTO['reason'],
      valueUzs: muToUzs(num(r.v)), approval: r.approval as StockWriteoffRowDTO['approval'], status: r.status as StockWriteoffRowDTO['status'],
    })),
    cursor: results.length > lim ? `${page.at(-1)!.created_at}|${page.at(-1)!.move_id}` : null,
  };
}
