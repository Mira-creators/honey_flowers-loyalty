// «Склад» invariants (architecture §10.3), re-derived from the raw journal with read-only SQL:
//  1 lot cache = Σ moves; 2 item balance = Σ moves; 3 value conservation; 4 lot bounds;
//  5 bouquet cost = −Σ assembly moves + untracked lines, disassembly returns = assembly value;
//  6 storno mirrors exactly one move, cancelled ⇔ storno; 7 stock_daily = GROUP BY of the journal;
//  10 sale with a client and loyalty 'done' ⇔ purchase with key sale:<id>; 11 no doc left in 'posting'.
import { sql } from './api.mjs';

export async function checkStockInvariants() {
  const v = [];
  const bad = (what, detail) => v.push({ what, detail });
  const q = (s) => sql(s);
  for (const r of await q(`SELECT l.id, l.kind, l.qty_on_hand, l.qty_received, COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.lot_id = l.id), 0) AS s FROM stock_lots l`)) {
    if (Number(r.qty_on_hand) !== Number(r.s)) bad('lot cache', `${r.id}: ${r.qty_on_hand} ≠ Σ ${r.s}`);
    if (r.kind === 'normal' && (r.qty_on_hand < 0 || r.qty_on_hand > r.qty_received)) bad('lot bounds', `${r.id}: ${r.qty_on_hand} of ${r.qty_received}`);
    if (r.kind === 'deficit' && r.qty_on_hand > 0) bad('deficit lot > 0', r.id);
  }
  for (const r of await q(`SELECT b.item_id, b.qty, b.value_mu, COALESCE(m.q, 0) AS q, COALESCE(m.v, 0) AS v FROM stock_item_balances b LEFT JOIN (SELECT item_id, SUM(qty) AS q, SUM(value_mu) AS v FROM stock_moves GROUP BY item_id) m ON m.item_id = b.item_id`)) {
    if (Number(r.qty) !== Number(r.q) || Number(r.value_mu) !== Number(r.v)) bad('item balance', `${r.item_id}: ${r.qty}/${r.value_mu} ≠ ${r.q}/${r.v}`);
  }
  const [missing] = await q(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT item_id FROM stock_moves) m WHERE m.item_id NOT IN (SELECT item_id FROM stock_item_balances)`);
  if (Number(missing.n)) bad('item balance missing', `${missing.n} items with moves but no balance row`);
  const [val] = await q(`SELECT (SELECT COALESCE(SUM(value_mu), 0) FROM stock_moves) AS mv, (SELECT COALESCE(SUM(qty_on_hand * unit_cost_mu), 0) FROM stock_lots) AS lv`);
  if (Number(val.mv) !== Number(val.lv)) bad('value conservation', `Σ moves ${val.mv} ≠ Σ lots ${val.lv}`);
  for (const r of await q(`SELECT id FROM stock_moves m WHERE value_mu <> qty * (SELECT unit_cost_mu FROM stock_lots WHERE id = m.lot_id) LIMIT 5`)) bad('move value', r.id);
  for (const r of await q(`SELECT b.id, b.cost_mu, b.status,
        COALESCE((SELECT -SUM(value_mu) FROM stock_moves m WHERE m.doc_id = b.assembly_doc_id AND m.reverses_move_id IS NULL), 0) AS mv,
        (SELECT COALESCE(SUM(l.value_mu), 0) FROM stock_doc_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.doc_id = b.assembly_doc_id AND i.track_stock = 0) AS untracked,
        (SELECT COALESCE(SUM(value_mu), 0) FROM stock_moves m WHERE m.doc_id = b.closed_doc_id AND m.reason = 'disassembly_return') AS ret,
        (SELECT COALESCE(SUM(m.value_mu), 0) FROM stock_moves m JOIN stock_lots t ON t.id = m.lot_id WHERE m.doc_id = b.assembly_doc_id AND t.kind = 'deficit' AND m.reverses_move_id IS NULL) AS defv
      FROM stock_bouquets b`)) {
    if (Number(r.cost_mu) !== Number(r.mv) + Number(r.untracked)) bad('bouquet cost', `${r.id}: ${r.cost_mu} ≠ ${r.mv} + ${r.untracked}`);
    if (r.status === 'disassembled' && Number(r.ret) !== Number(r.mv) + Number(r.defv)) bad('disassembly return', `${r.id}: returned ${r.ret} ≠ assembly ${r.mv} − deficit ${-r.defv}`);
  }
  for (const r of await q(`SELECT s.id, s.reverses_move_id, o.qty AS oq, s.qty AS sq, o.lot_id = s.lot_id AS same, o.reason = s.reason AS sr FROM stock_moves s JOIN stock_moves o ON o.id = s.reverses_move_id`)) {
    if (Number(r.oq) !== -Number(r.sq) || !r.same || !r.sr) bad('storno mirror', `move ${r.id}`);
  }
  const [cx] = await q(`SELECT (SELECT COUNT(*) FROM stock_docs WHERE status = 'cancelled') AS c, (SELECT COUNT(*) FROM stock_docs WHERE kind = 'storno' AND status = 'posted') AS s`);
  if (Number(cx.c) !== Number(cx.s)) bad('cancelled ⇔ storno', `${cx.c} cancelled vs ${cx.s} storno docs`);
  const daily = await q(`SELECT COUNT(*) AS n FROM stock_daily d LEFT JOIN (SELECT doc_date, item_id, reason, SUM(qty) AS q, SUM(value_mu) AS v, SUM(CASE WHEN reverses_move_id IS NULL THEN 1 ELSE -1 END) AS n FROM stock_moves GROUP BY doc_date, item_id, reason) m
      ON m.doc_date = d.day AND m.item_id = d.item_id AND m.reason = d.reason WHERE m.q IS NULL OR m.q <> d.qty OR m.v <> d.value_mu OR m.n <> d.n`);
  if (Number(daily[0].n)) bad('stock_daily', `${daily[0].n} rows differ from the journal`);
  const [dg] = await q(`SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM stock_moves GROUP BY doc_date, item_id, reason)) AS g, (SELECT COUNT(*) FROM stock_daily) AS d`);
  if (Number(dg.g) !== Number(dg.d)) bad('stock_daily rows', `${dg.d} ≠ ${dg.g}`);
  for (const r of await q(`SELECT s.id, s.loyalty_status, p.idempotency_key, p.client_id = s.client_id AS same FROM stock_sales s LEFT JOIN purchases p ON p.id = s.loyalty_purchase_id WHERE s.client_id IS NOT NULL`)) {
    if (r.loyalty_status === 'done' && (r.idempotency_key !== `sale:${r.id}` || !r.same)) bad('sale ↔ loyalty', `${r.id}: ${r.idempotency_key}`);
  }
  const [posting] = await q(`SELECT COUNT(*) AS n FROM stock_docs WHERE status = 'posting'`);
  if (Number(posting.n)) bad('posting', `${posting.n} docs stuck in posting`);
  const [paid] = await q(`SELECT COUNT(*) AS n FROM stock_sales WHERE paid_uzs <> total_uzs - honey_redeemed - discount_uzs`);
  if (Number(paid.n)) bad('sale paid', `${paid.n}`);
  return v;
}

/** Totals for the report (sanity stats). */
export async function stockStats() {
  const [s] = await sql(`SELECT (SELECT COUNT(*) FROM stock_moves) AS moves, (SELECT COUNT(*) FROM stock_lots) AS lots, (SELECT COUNT(*) FROM stock_bouquets) AS bouquets,
      (SELECT COUNT(*) FROM stock_sales) AS sales, (SELECT COUNT(*) FROM stock_docs WHERE kind = 'receipt') AS receipts, (SELECT COUNT(*) FROM stock_docs WHERE kind = 'writeoff') AS writeoffs,
      (SELECT COUNT(*) FROM stock_docs WHERE kind = 'storno') AS stornos, (SELECT COALESCE(SUM(value_mu), 0) FROM stock_item_balances) AS value_mu`);
  return s;
}
