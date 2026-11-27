/**
 * TEST_MODE demo data for «Склад»: the last 30 days of a small Tashkent shop — receipts (UZS and USD,
 * some «одной суммой»), bouquets consumed FIFO, sales (some linked to demo loyalty purchases of the same
 * day), showcase leftovers and disassemblies, write-offs (one waiting for the owner's approval).
 *
 * Simulated in memory with the same pure functions as production (packages/stock: computeReceipt,
 * pickLots, bouquetCost, suggestPrice, planDisassembly) and written in ONE batch per 5-day chunk with
 * multi-row `INSERT … SELECT FROM json_each` statements — the ledger triggers maintain every cache, so
 * all ledger invariants hold. ~6 chunks, each ≤ 4 D1 round trips. Write budget: the stock part stays
 * ≤ ~8 000 rows (measured in test/stockDemo.test.ts).
 * Deterministic (seeded by the demo anchor) and idempotent (finished chunks are recorded in settings).
 * Demo rows: stock_docs/bouquets/sales/items/templates/suppliers.demo = 1; lots via their receipt doc.
 */
import {
  addDays, bouquetCost, computeReceipt, muToUzs, pickLots, planDisassembly, suggestPrice, tashkentDay,
  type CostLine, type PickLot, type ReceiptItemInfo, type StockKind, type TakenLot,
} from '@honey/stock';
import type { AppContext } from '../context.js';
import { STOCK_TABLES } from '../db/d1Repository.js';
import { seedCatalog } from '../stock/catalog.js';
import { loadConfig, num, numOrNull, revStmt, strOrNull, type Row } from '../stock/core.js';
import { DEMO_STAFF, demoStaffId, mulberry32 } from './data.js';

export const STOCK_DEMO_DAYS = 30;
export const STOCK_DEMO_CHUNK_DAYS = 5;
export const STOCK_DEMO_CHUNKS = STOCK_DEMO_DAYS / STOCK_DEMO_CHUNK_DAYS;
const DONE_KEY = 'demo_stock_chunks';

interface Item { id: string; sku: string; name: string; kind: StockKind; pack: number | null; std: number; sell: number | null; vase: number | null; track: boolean; last: number | null }
interface Lot extends PickLot { sellBy: string | null; received: number }

/** Bouquet recipes (sku, qty) — what a Tashkent shop sells most. */
const RECIPES: Array<{ w: number; lines: Array<[string, number]>; showcase?: number }> = [
  { w: 22, lines: [['RN60', 15], ['EUC', 3], ['KRF', 2], ['RIB', 80]] },
  { w: 12, lines: [['RN60', 25], ['MAT', 3], ['RIB', 100]], showcase: 0.4 },
  { w: 14, lines: [['LR40', 11], ['PIS', 3], ['KRF', 2], ['RIB', 60]], showcase: 0.5 },
  { w: 10, lines: [['FR50', 9], ['GYP', 2], ['MAT', 2], ['RIB', 60]] },
  { w: 10, lines: [['EUW', 7], ['EUC', 4], ['GYP', 2], ['MAT', 2], ['RIB', 60]], showcase: 0.4 },
  { w: 8, lines: [['CHB', 5], ['ALS', 5], ['RUS', 3], ['KRF', 2], ['RIB', 60]] },
  { w: 8, lines: [['TLR', 15], ['MAT', 2], ['RIB', 50]], showcase: 0.5 },
  { w: 6, lines: [['PB50', 11], ['EUC', 3], ['BOX', 1]] },
  { w: 5, lines: [['LP40', 15], ['SAL', 3], ['MAT', 2], ['RIB', 60], ['CRD', 1]] },
  { w: 5, lines: [['EX70', 7], ['RUS', 2], ['KRF', 2], ['RIB', 60], ['TAP', 1]] },
];
/** What a receipt brings (sku, packs). */
const RECEIPT_LINES: Array<[string, number]> = [
  ['RN60', 4], ['LR40', 2], ['FR50', 1], ['EUW', 2], ['EUC', 2], ['PIS', 1], ['GYP', 1], ['TLR', 1], ['CHB', 1], ['ALS', 1], ['PB50', 1], ['LP40', 1], ['EX70', 1], ['RUS', 1], ['SAL', 1],
];
const SUPPLY_LINES: Array<[string, number]> = [['KRF', 1], ['MAT', 1], ['RIB', 1], ['BOX', 1], ['CRD', 1]];

function pickWeighted<T extends { w: number }>(rng: () => number, xs: T[]): T {
  const total = xs.reduce((a, x) => a + x.w, 0);
  let r = rng() * total;
  for (const x of xs) { r -= x.w; if (r <= 0) return x; }
  return xs[xs.length - 1]!;
}
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

export interface StockDemoChunkDTO { chunk: number; chunks: number; finished: boolean; nextChunk: number | null; receipts: number; bouquets: number; sales: number; writeoffs: number; skipped: boolean }

export async function seedStockDemoChunk(app: AppContext, chunk: number, anchorMs: number): Promise<StockDemoChunkDTO> {
  const db = app.repo.db;
  const out: StockDemoChunkDTO = { chunk, chunks: STOCK_DEMO_CHUNKS, finished: chunk >= STOCK_DEMO_CHUNKS - 1, nextChunk: chunk >= STOCK_DEMO_CHUNKS - 1 ? null : chunk + 1, receipts: 0, bouquets: 0, sales: 0, writeoffs: 0, skipped: false };
  const cfg = await loadConfig(db);
  const anchorDay = tashkentDay(anchorMs);
  const firstDay = addDays(anchorDay, -(STOCK_DEMO_DAYS - 1));
  const done = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(DONE_KEY).all<Row>();
  const doneSet = new Set<number>(done.results[0] ? (JSON.parse(String(done.results[0].value)) as number[]) : []);
  if (doneSet.has(chunk)) return { ...out, skipped: true };
  if (chunk > 0 && !doneSet.has(chunk - 1)) throw new Error('demo stock: chunks must run in order');
  if (chunk === 0) await seedCatalog(app, null, cfg, true);

  const days = Array.from({ length: STOCK_DEMO_CHUNK_DAYS }, (_, k) => addDays(firstDay, chunk * STOCK_DEMO_CHUNK_DAYS + k));
  const fromIso = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 5 * 3_600_000).toISOString();
  const toIso = new Date(Date.parse(`${addDays(days.at(-1)!, 1)}T00:00:00Z`) - 5 * 3_600_000).toISOString();
  const [items, lots, nums, purchases, openB, sup] = await db.batch<Row>([
    db.prepare(`SELECT i.id, i.sku, i.name, i.kind, i.pack_size, i.std_cost_mu, i.sell_days, i.vase_life_days, i.track_stock, b.last_cost_mu FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id WHERE i.active = 1`),
    db.prepare(`SELECT id, item_id, qty_on_hand, unit_cost_mu, priority, expires_on, received_at, sell_by, qty_received FROM stock_lots WHERE qty_on_hand > 0`),
    db.prepare(`SELECT kind, MAX(number) AS n FROM stock_docs GROUP BY kind`),
    // demo loyalty purchases of these days (store, flowers) — sales get linked to them
    db.prepare(
      `SELECT p.id, p.client_id, p.amount, p.points_redeemed, p.discount_applied, p.staff_id, p.created_at FROM purchases p JOIN clients c ON c.id = p.client_id
        WHERE c.demo = 1 AND p.status = 'active' AND p.created_at >= ? AND p.created_at < ? AND p.amount >= 150000
          AND NOT EXISTS (SELECT 1 FROM stock_sales s WHERE s.loyalty_purchase_id = p.id) ORDER BY p.created_at`,
    ).bind(fromIso, toIso),
    db.prepare(`SELECT b.id, b.created_at, b.price_current_uzs, b.cost_uzs, b.assembly_doc_id FROM stock_bouquets b WHERE b.status IN ('assembled','on_showcase') AND b.demo = 1`),
    db.prepare(`SELECT id FROM stock_suppliers WHERE demo = 1 ORDER BY name`),
  ]);
  const bySku = new Map<string, Item>();
  for (const r of items!.results) {
    bySku.set(String(r.sku), {
      id: String(r.id), sku: String(r.sku), name: String(r.name), kind: r.kind as StockKind, pack: numOrNull(r.pack_size), std: num(r.std_cost_mu),
      sell: numOrNull(r.sell_days), vase: numOrNull(r.vase_life_days), track: num(r.track_stock) === 1, last: numOrNull(r.last_cost_mu),
    });
  }
  const byId = new Map([...bySku.values()].map((i) => [i.id, i]));
  const open: Lot[] = lots!.results.map((l) => ({
    id: String(l.id), itemId: String(l.item_id), qty: num(l.qty_on_hand), unitCostMu: num(l.unit_cost_mu), priority: num(l.priority), expiresOn: strOrNull(l.expires_on),
    receivedAt: String(l.received_at), sellBy: strOrNull(l.sell_by), received: num(l.qty_received),
  }));
  const number = new Map(nums!.results.map((r) => [String(r.kind), num(r.n)]));
  const nextNo = (kind: string) => { const n = (number.get(kind) ?? 0) + 1; number.set(kind, n); return n; };
  const freePurchases = purchases!.results.slice();
  const rng = mulberry32((Date.parse(`${anchorDay}T00:00:00Z`) / 86_400_000) * 31 + chunk * 7919);
  const staff = DEMO_STAFF.filter((s) => s.role === 'florist');
  const owner = 'demo-owner';

  // rows to write
  const docs: Row[] = [];
  const newLots: Row[] = [];
  const moves: Row[] = [];
  const lines: Row[] = [];
  const bouquets: Row[] = [];
  const sales: Row[] = [];
  const saleLines: Row[] = [];
  const lastCost = new Map<string, { c: number; on: string }>();
  const suppliers: Row[] = [];
  let supplierIds = sup!.results.map((r) => String(r.id));
  if (chunk === 0 && !supplierIds.length) {
    supplierIds = ['Гулшан (опт, Ташкент)', 'Ecuador Flowers Direct', 'Фирма «Зелёный двор»'].map((name) => {
      const id = crypto.randomUUID();
      suppliers.push({ id, name });
      return id;
    });
  }

  const key = (kind: string, day: string, n: number) => `demo:${anchorDay}:${kind}:${day}:${n}`;
  const doc = (d: Partial<Row> & { kind: string; day: string; at: string; actor: string; role: string; n: number }): string => {
    const id = crypto.randomUUID();
    docs.push({
      id, kind: d.kind, number: nextNo(d.kind), status: d.status ?? 'posted', doc_date: d.day, key: key(d.kind, d.day, d.n), actor: d.actor, role: d.role,
      supplier: d.supplier ?? null, currency: d.currency ?? 'UZS', fx: d.fx ?? null, mode: d.mode ?? null, total: d.total ?? null, approval: d.approval ?? 'none',
      approved_by: d.approved_by ?? null, approved_at: d.approved_at ?? null, note: d.note ?? null, at: d.at, value: 0,
    });
    return id;
  };
  const addMoves = (docId: string, day: string, actor: string, at: string, ms: Array<{ l: number; i: string; o: string; q: number; v: number; r: string; b?: string | null }>) => {
    let v = 0;
    for (const m of ms) { moves.push({ d: docId, dd: day, a: actor, t: at, ...m, b: m.b ?? null }); v += Math.abs(m.v); }
    docs.find((x) => x.id === docId)!.value = v;
  };
  const take = (itemId: string, qty: number) => {
    const { picks, short } = pickLots(open, [{ itemId, qty }], { policy: 'block', confirmedShort: false, deficitCostMu: () => 0 });
    if (short.length) return null;
    for (const p of picks) open.find((l) => l.id === p.lotId)!.qty -= p.qty;
    return picks;
  };

  // bouquets created in an earlier chunk and closed in this one (UPDATE through the status guard)
  const soldEarlier: Array<{ id: string; sale: string; at: string }> = [];
  const disassembledEarlier: Array<{ id: string; doc: string; at: string }> = [];
  let seq = 0;
  let rcpt = chunk * 3;
  let dayIdx = chunk * STOCK_DEMO_CHUNK_DAYS;
  const showcase: Array<{ id: string; at: string; price: number; cost: number; docId: string; taken: TakenLot[] }> = openB!.results.map((b) => ({ id: String(b.id), at: String(b.created_at), price: num(b.price_current_uzs), cost: num(b.cost_uzs), docId: String(b.assembly_doc_id), taken: [] }));
  for (const day of days) {
    const atOf = (h: number, m = 0) => new Date(Date.parse(`${day}T00:00:00Z`) - 5 * 3_600_000 + (h * 60 + m) * 60_000).toISOString();
    if (atOf(9) > new Date(anchorMs).toISOString()) break;
    // ---- receipt every second day (and on the first day), at 08:30
    if (dayIdx % 2 === 0) {
      const usd = rcpt % 3 === 1;
      const total = rcpt % 3 === 2;
      const fxX100 = usd ? 1_280_000 + Math.floor(rng() * 15_000) : null;
      const fl = RECEIPT_LINES.filter((_x, k) => k < 5 || rng() < 0.4).concat(dayIdx % 6 === 0 ? SUPPLY_LINES : []);
      const infos = new Map<string, ReceiptItemInfo>();
      const reqLines = fl.map(([sku, packs]) => bySku.get(sku)).filter((it): it is Item => !!it && it.track).map((it) => {
        const pk = fl.find(([s]) => s === it.sku)![1];
        infos.set(it.id, { id: it.id, name: it.name, kind: it.kind, packSize: it.pack, trackStock: true, lastCostMu: lastCost.get(it.id)?.c ?? it.last, stdCostMu: it.std });
        const unitUzs = (it.std / 1000) * (0.85 + rng() * 0.3);
        const packPrice = (it.pack ?? 1) * unitUzs;
        const price = usd ? Math.max(1, Math.round((packPrice / (fxX100! / 100)) * 100)) : roundTo(packPrice, 500);
        return { itemId: it.id, qty: pk, unit: (it.pack ? 'pack' : 'base') as 'pack' | 'base', price: total ? null : price, per: (it.pack ? 'pack' : 'unit') as 'pack' | 'unit', _p: price, _pk: pk };
      });
      if (reqLines.length) {
        const sumMinor = reqLines.reduce((a, l) => a + l._p * l._pk, 0);
        const res = computeReceipt({ currency: usd ? 'USD' : 'UZS', fxRateX100: fxX100, priceMode: total ? 'total' : 'lines', total: total ? roundTo(sumMinor, 1000) : null, extraCostUzs: dayIdx % 4 === 0 ? 40_000 : 0, lines: reqLines }, infos);
        const at = atOf(8, 30);
        const docId = doc({ kind: 'receipt', day, at, actor: owner, role: 'owner', n: rcpt, supplier: supplierIds[rcpt % Math.max(1, supplierIds.length)] ?? null, currency: usd ? 'USD' : 'UZS', fx: fxX100, mode: total ? 'total' : 'lines', total: total ? roundTo(sumMinor, 1000) : null });
        docs.at(-1)!.extra = dayIdx % 4 === 0 ? 40_000 : 0;
        const ms: Parameters<typeof addMoves>[4] = [];
        for (const l of res.lines) {
          const it = byId.get(l.itemId)!;
          const lotId = crypto.randomUUID();
          const lot: Lot = { id: lotId, itemId: it.id, qty: l.qtyBase, unitCostMu: l.unitCostMu, priority: 0, expiresOn: it.vase ? addDays(day, it.vase) : null, receivedAt: at, sellBy: it.sell ? addDays(day, it.sell) : null, received: l.qtyBase };
          open.push(lot);
          newLots.push({ id: lotId, item: it.id, doc: docId, sup: docs.at(-1)!.supplier, recv: at, sell: lot.sellBy, exp: lot.expiresOn, qty: l.qtyBase, cost: l.unitCostMu, cur: l.priceCurX100, currency: usd ? 'USD' : 'UZS' });
          ms.push({ l: l.lineNo, i: it.id, o: lotId, q: l.qtyBase, v: l.qtyBase * l.unitCostMu, r: 'receipt' });
          lines.push({ d: docId, n: l.lineNo, i: it.id, q: l.qtyBase, iq: l.inputQty, iu: l.inputUnit, ip: l.inputPrice, per: l.per, ref: l.refCostMu, man: l.manual ? 1 : 0, val: Number(l.valueMu), uc: l.unitCostMu, lm: Number(l.landedMu), rm: l.roundingMu, lot: lotId, qp: null, reason: null });
          lastCost.set(it.id, { c: l.unitCostMu, on: day });
        }
        addMoves(docId, day, owner, at, ms);
        out.receipts++;
        rcpt++;
      }
    }
    // ---- showcase leftovers from earlier days: sell (60 %) or disassemble when 2+ days old
    for (const b of showcase.splice(0)) {
      const age = Math.round((Date.parse(atOf(10)) - Date.parse(b.at)) / 86_400_000);
      if (rng() < 0.6) { sellBouquet(b.id, b.price, b.cost, atOf(11 + Math.floor(rng() * 6), Math.floor(rng() * 60)), day); continue; }
      if (age >= 2 && b.taken.length) {
        const at = atOf(10, 15);
        const actor = demoStaffId(staff[Math.floor(rng() * staff.length)]!.j);
        const good = new Map(b.taken.map((t) => [t.itemId, Math.floor(t.taken * (0.5 + rng() * 0.4))]));
        const plan = planDisassembly(b.taken, good);
        const docId = doc({ kind: 'disassembly', day, at, actor, role: 'florist', n: ++seq });
        addMoves(docId, day, actor, at, plan.moves.map((m, k) => ({ l: k + 1, i: m.itemId, o: m.lotId, q: m.qty, v: m.qty * m.unitCostMu, r: m.reason, b: b.id })));
        for (const m of plan.moves) open.find((l) => l.id === m.lotId)!.qty += m.qty;
        const mine = bouquets.find((x) => x.id === b.id);
        if (mine) Object.assign(mine, { status: 'disassembled', closed: docId, closed_at: at });
        else disassembledEarlier.push({ id: b.id, doc: docId, at });
      } else showcase.push(b);
    }
    // ---- bouquets of the day: 2–5 through the system, 10:00–20:00 (keeps the demo inside the write budget)
    const n = 2 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const recipe = pickWeighted(rng, RECIPES);
      const at = atOf(10 + Math.floor((k * 10) / n), Math.floor(rng() * 50));
      const fl = staff[Math.floor(rng() * staff.length)]!;
      const actor = demoStaffId(fl.j);
      const docId = crypto.randomUUID();
      const bId = crypto.randomUUID();
      const ms: Parameters<typeof addMoves>[4] = [];
      const costLines: CostLine[] = [];
      const lineRows: Row[] = [];
      const taken: TakenLot[] = [];
      let ok = true;
      recipe.lines.forEach(([sku, q], li) => {
        const it = bySku.get(sku);
        if (!it || !ok) return;
        if (!it.track) {
          costLines.push({ kind: it.kind, valueMu: BigInt(q) * BigInt(it.std) });
          lineRows.push({ d: docId, n: li + 1, i: it.id, q, val: q * it.std });
          return;
        }
        const picks = take(it.id, q);
        if (!picks) { ok = false; return; }
        let v = 0n;
        for (const p of picks) {
          ms.push({ l: li + 1, i: it.id, o: p.lotId, q: -p.qty, v: -Number(p.valueMu), r: 'assembly', b: bId });
          v += p.valueMu;
          const lot = open.find((l) => l.id === p.lotId)!;
          taken.push({ ...lot, qty: 0, taken: p.qty, deficit: false });
        }
        costLines.push({ kind: it.kind, valueMu: v });
        lineRows.push({ d: docId, n: li + 1, i: it.id, q, val: Number(v) });
      });
      if (!ok) {
        // not enough stems: give the taken ones back (in-memory only, nothing was written yet)
        for (const m of ms) open.find((l) => l.id === m.o)!.qty -= m.q;
        continue;
      }
      const cost = bouquetCost(costLines);
      const suggested = suggestPrice(costLines, cfg.pricing);
      const price = Math.max(suggested - (rng() < 0.3 ? 20_000 : 0), 5_000);
      // the last demo day always leaves something on the showcase
      const isShow = rng() < (recipe.showcase ?? 0.15) || (dayIdx === STOCK_DEMO_DAYS - 1 && k < 2);
      docs.push({ id: docId, kind: 'assembly', number: nextNo('assembly'), status: 'posted', doc_date: day, key: key('assembly', day, out.bouquets), actor, role: 'florist', supplier: null, currency: 'UZS', fx: null, mode: null, total: null, approval: 'none', approved_by: null, approved_at: null, note: null, at, value: 0 });
      addMoves(docId, day, actor, at, ms);
      lines.push(...lineRows.map((r) => ({ ...r, iq: null, iu: null, ip: null, per: null, ref: null, man: 0, uc: null, lm: null, rm: 0, lot: null, qp: null, reason: null })));
      bouquets.push({ id: bId, doc: docId, kind: isShow ? 'showcase' : 'order', status: isShow ? 'on_showcase' : 'assembled', fl: actor, fn: fl.name, cmu: Number(cost.costMu), cost: cost.costUzs, fc: cost.flowersCostUzs, sc: cost.suppliesCostUzs, sug: suggested, price, at, sale: null, closed: null, closed_at: null });
      out.bouquets++;
      if (isShow) showcase.push({ id: bId, at, price, cost: cost.costUzs, docId, taken });
      else sellBouquet(bId, price, cost.costUzs, new Date(Date.parse(at) + 6 * 60_000).toISOString(), day);
    }
    // ---- write-offs: wilted stems from overdue lots every third day; one big pending at the end
    if (dayIdx % 3 === 2 || dayIdx === STOCK_DEMO_DAYS - 1) {
      const at = atOf(19, 30);
      const actor = demoStaffId(staff[0]!.j);
      const overdue = open.filter((l) => l.qty > 0 && l.sellBy && l.sellBy < day).slice(0, 3);
      const big = dayIdx === STOCK_DEMO_DAYS - 1;
      const ms: Parameters<typeof addMoves>[4] = [];
      overdue.forEach((l, k) => {
        const q = big ? l.qty : Math.min(l.qty, 2 + Math.floor(rng() * 5));
        l.qty -= q;
        ms.push({ l: k + 1, i: l.itemId, o: l.id, q: -q, v: -q * l.unitCostMu, r: k === 1 && !big ? 'writeoff_damage' : 'writeoff_wilt' });
      });
      if (ms.length) {
        const value = ms.reduce((a, m) => a + Math.abs(m.v), 0);
        const pending = muToUzs(value) >= cfg.writeoffApprovalUzs;
        const docId = doc({ kind: 'writeoff', day, at, actor, role: 'florist', n: dayIdx, approval: pending ? (big ? 'pending' : 'approved') : 'none', approved_by: pending && !big ? owner : null, approved_at: pending && !big ? at : null });
        addMoves(docId, day, actor, at, ms);
        ms.forEach((m, k) => lines.push({ d: docId, n: k + 1, i: m.i, q: -m.q, iq: null, iu: null, ip: null, per: null, ref: null, man: 0, val: null, uc: null, lm: null, rm: 0, lot: m.o, qp: null, reason: m.r }));
        out.writeoffs++;
      }
    }
    dayIdx++;
  }

  function sellBouquet(bouquetId: string, price: number, cost: number, at: string, day: string) {
    const actor = demoStaffId(staff[Math.floor(rng() * staff.length)]!.j);
    // a demo loyalty purchase of the same day → link the sale to it (that client paid for it)
    const pIdx = freePurchases.findIndex((p) => tashkentDay(String(p.created_at)) === day);
    const p = pIdx >= 0 && rng() < 0.7 ? freePurchases.splice(pIdx, 1)[0]! : null;
    const total = p ? num(p.amount) : price;
    const saleId = doc({ kind: 'sale', day, at, actor: p ? String(p.staff_id ?? actor) : actor, role: 'florist', n: ++seq });
    sales.push({ id: saleId, client: p ? String(p.client_id) : null, pid: p ? String(p.id) : null, ls: p ? 'done' : 'none', total, honey: p ? num(p.points_redeemed) : 0, disc: p ? num(p.discount_applied) : 0, pay: rng() < 0.55 ? 'card' : 'cash', cost, actor, at });
    saleLines.push({ s: saleId, n: 1, b: bouquetId, p: total, c: cost });
    const b = bouquets.find((x) => x.id === bouquetId);
    if (b) Object.assign(b, { status: 'sold', sale: saleId, closed_at: at });
    else soldEarlier.push({ id: bouquetId, sale: saleId, at });
    out.sales++;
  }

  const now = app.now().toISOString();
  const J = (x: unknown) => JSON.stringify(x);
  const stmts: D1PreparedStatement[] = [];
  if (suppliers.length) stmts.push(db.prepare(`INSERT INTO stock_suppliers (id, name, demo, created_at) SELECT json_extract(value,'$.id'), json_extract(value,'$.name'), 1, ?1 FROM json_each(?2)`).bind(now, J(suppliers)));
  stmts.push(
    db.prepare(
      `INSERT INTO stock_docs (id, kind, number, status, doc_date, idempotency_key, payload_hash, actor_id, actor_role, supplier_id, extra_cost_uzs, currency, fx_rate_x100, price_mode, input_total,
         approval, approved_by, approved_at, note, demo, created_at, posted_at, total_value_mu)
       SELECT json_extract(value,'$.id'), json_extract(value,'$.kind'), json_extract(value,'$.number'), 'posted', json_extract(value,'$.doc_date'), json_extract(value,'$.key'), 'demo',
              json_extract(value,'$.actor'), json_extract(value,'$.role'), json_extract(value,'$.supplier'), COALESCE(json_extract(value,'$.extra'), 0), json_extract(value,'$.currency'),
              json_extract(value,'$.fx'), json_extract(value,'$.mode'), json_extract(value,'$.total'), json_extract(value,'$.approval'), json_extract(value,'$.approved_by'),
              json_extract(value,'$.approved_at'), json_extract(value,'$.note'), 1, json_extract(value,'$.at'), json_extract(value,'$.at'), json_extract(value,'$.value') FROM json_each(?1)`,
    ).bind(J(docs)),
  );
  if (newLots.length) {
    stmts.push(
      db.prepare(
        `INSERT INTO stock_lots (id, item_id, kind, receipt_doc_id, supplier_id, received_at, sell_by, expires_on, qty_received, unit_cost_mu, price_cur_x100, currency, created_at)
         SELECT json_extract(value,'$.id'), json_extract(value,'$.item'), 'normal', json_extract(value,'$.doc'), json_extract(value,'$.sup'), json_extract(value,'$.recv'), json_extract(value,'$.sell'),
                json_extract(value,'$.exp'), json_extract(value,'$.qty'), json_extract(value,'$.cost'), json_extract(value,'$.cur'), json_extract(value,'$.currency'), json_extract(value,'$.recv') FROM json_each(?1)`,
      ).bind(J(newLots)),
    );
  }
  stmts.push(
    db.prepare(
      `INSERT INTO stock_moves (doc_id, line_no, item_id, lot_id, qty, value_mu, reason, doc_date, bouquet_id, actor_id, created_at)
       SELECT json_extract(value,'$.d'), json_extract(value,'$.l'), json_extract(value,'$.i'), json_extract(value,'$.o'), json_extract(value,'$.q'), json_extract(value,'$.v'),
              json_extract(value,'$.r'), json_extract(value,'$.dd'), json_extract(value,'$.b'), json_extract(value,'$.a'), json_extract(value,'$.t') FROM json_each(?1) ORDER BY key`,
    ).bind(J(moves)),
    db.prepare(
      `INSERT INTO stock_doc_lines (doc_id, line_no, item_id, qty, qty_planned, input_qty, input_unit, input_price, input_price_per, ref_cost_mu, manual_price, value_mu, unit_cost_mu, landed_mu, rounding_mu, reason, lot_id)
       SELECT json_extract(value,'$.d'), json_extract(value,'$.n'), json_extract(value,'$.i'), json_extract(value,'$.q'), json_extract(value,'$.qp'), json_extract(value,'$.iq'), json_extract(value,'$.iu'),
              json_extract(value,'$.ip'), json_extract(value,'$.per'), json_extract(value,'$.ref'), json_extract(value,'$.man'), json_extract(value,'$.val'), json_extract(value,'$.uc'),
              json_extract(value,'$.lm'), json_extract(value,'$.rm'), json_extract(value,'$.reason'), json_extract(value,'$.lot') FROM json_each(?1)`,
    ).bind(J(lines)),
  );
  if (bouquets.length) {
    stmts.push(
      db.prepare(
        `INSERT INTO stock_bouquets (id, assembly_doc_id, kind, status, florist_id, florist_name, cost_mu, cost_uzs, flowers_cost_uzs, supplies_cost_uzs, suggested_price_uzs, price_uzs, price_current_uzs,
           sale_id, closed_doc_id, closed_at, demo, created_at)
         SELECT json_extract(value,'$.id'), json_extract(value,'$.doc'), json_extract(value,'$.kind'), json_extract(value,'$.status'), json_extract(value,'$.fl'), json_extract(value,'$.fn'),
                json_extract(value,'$.cmu'), json_extract(value,'$.cost'), json_extract(value,'$.fc'), json_extract(value,'$.sc'), json_extract(value,'$.sug'), json_extract(value,'$.price'),
                json_extract(value,'$.price'), json_extract(value,'$.sale'), json_extract(value,'$.closed'), json_extract(value,'$.closed_at'), 1, json_extract(value,'$.at') FROM json_each(?1)`,
      ).bind(J(bouquets)),
    );
  }
  for (const s of soldEarlier) stmts.push(db.prepare(`UPDATE stock_bouquets SET status = 'sold', sale_id = ?, closed_at = ? WHERE id = ?`).bind(s.sale, s.at, s.id));
  for (const d of disassembledEarlier) stmts.push(db.prepare(`UPDATE stock_bouquets SET status = 'disassembled', closed_doc_id = ?, closed_at = ? WHERE id = ?`).bind(d.doc, d.at, d.id));
  if (sales.length) {
    stmts.push(
      db.prepare(
        `INSERT INTO stock_sales (id, client_id, loyalty_purchase_id, loyalty_status, total_uzs, honey_redeemed, discount_uzs, paid_uzs, payment_method, channel, cost_uzs, actor_id, demo, created_at)
         SELECT json_extract(value,'$.id'), json_extract(value,'$.client'), json_extract(value,'$.pid'), json_extract(value,'$.ls'), json_extract(value,'$.total'), json_extract(value,'$.honey'),
                json_extract(value,'$.disc'), json_extract(value,'$.total') - json_extract(value,'$.honey') - json_extract(value,'$.disc'), json_extract(value,'$.pay'), 'store',
                json_extract(value,'$.cost'), json_extract(value,'$.actor'), 1, json_extract(value,'$.at') FROM json_each(?1)`,
      ).bind(J(sales)),
      db.prepare(
        `INSERT INTO stock_sale_lines (sale_id, line_no, kind, bouquet_id, qty, price_uzs, cost_uzs, category)
         SELECT json_extract(value,'$.s'), json_extract(value,'$.n'), 'bouquet', json_extract(value,'$.b'), 1, json_extract(value,'$.p'), json_extract(value,'$.c'), 'flowers' FROM json_each(?1)`,
      ).bind(J(saleLines)),
    );
  }
  if (lastCost.size) {
    stmts.push(
      db.prepare(
        `INSERT INTO stock_item_balances (item_id, qty, value_mu, last_cost_mu, last_receipt_on, updated_at)
         SELECT json_extract(value,'$.i'), 0, 0, json_extract(value,'$.c'), json_extract(value,'$.on'), ?1 FROM json_each(?2) WHERE true
         ON CONFLICT(item_id) DO UPDATE SET last_cost_mu = excluded.last_cost_mu, last_receipt_on = excluded.last_receipt_on`,
      ).bind(now, J([...lastCost.entries()].map(([i, v]) => ({ i, c: v.c, on: v.on })))),
    );
  }
  doneSet.add(chunk);
  stmts.push(db.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(DONE_KEY, J([...doneSet].sort((a, b) => a - b))), revStmt(db));
  await db.batch(stmts);
  return out;
}

/** Remove the demo stock rows (TEST_MODE). Moves of real documents on demo lots go too; caches are rebuilt from the journal. */
export async function clearStockDemo(app: AppContext): Promise<void> {
  const db = app.repo.db;
  const demoDocs = `SELECT id FROM stock_docs WHERE demo = 1`;
  const demoLots = `SELECT id FROM stock_lots WHERE receipt_doc_id IN (${demoDocs})`;
  const exists = await db.prepare(`SELECT (SELECT COUNT(*) FROM stock_docs WHERE demo = 1) + (SELECT COUNT(*) FROM stock_items WHERE demo = 1) AS n`).all<Row>();
  if (!num(exists.results[0]?.n)) {
    await db.prepare('DELETE FROM settings WHERE key = ?').bind(DONE_KEY).run();
    return;
  }
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_stock_delete')`),
    db.prepare(`DELETE FROM stock_sale_lines WHERE sale_id IN (SELECT id FROM stock_sales WHERE demo = 1)`),
    db.prepare(`DELETE FROM stock_sales WHERE demo = 1`),
    db.prepare(`DELETE FROM stock_moves WHERE reverses_move_id IN (SELECT id FROM stock_moves WHERE doc_id IN (${demoDocs}) OR lot_id IN (${demoLots}))`),
    db.prepare(`DELETE FROM stock_moves WHERE doc_id IN (${demoDocs}) OR lot_id IN (${demoLots})`),
    db.prepare(`DELETE FROM stock_bouquets WHERE demo = 1`),
    db.prepare(`DELETE FROM stock_doc_lines WHERE doc_id IN (${demoDocs})`),
    db.prepare(`DELETE FROM stock_lots WHERE receipt_doc_id IN (${demoDocs})`),
    db.prepare(`DELETE FROM stock_docs WHERE cancels_doc_id IN (${demoDocs})`),
    db.prepare(`DELETE FROM stock_docs WHERE demo = 1`),
    db.prepare(`DELETE FROM stock_templates WHERE demo = 1`),
    // demo catalog items without anything left on them
    db.prepare(`DELETE FROM stock_item_balances WHERE item_id IN (SELECT id FROM stock_items WHERE demo = 1) AND item_id NOT IN (SELECT item_id FROM stock_moves) AND item_id NOT IN (SELECT item_id FROM stock_lots)`),
    db.prepare(`DELETE FROM stock_items WHERE demo = 1 AND id NOT IN (SELECT item_id FROM stock_moves) AND id NOT IN (SELECT item_id FROM stock_lots) AND id NOT IN (SELECT item_id FROM stock_doc_lines) AND id NOT IN (SELECT item_id FROM stock_item_balances)`),
    db.prepare(`DELETE FROM stock_suppliers WHERE demo = 1 AND id NOT IN (SELECT supplier_id FROM stock_lots WHERE supplier_id IS NOT NULL) AND id NOT IN (SELECT supplier_id FROM stock_docs WHERE supplier_id IS NOT NULL)`),
    // caches from the journal (architecture §4.8)
    db.prepare(`UPDATE stock_lots SET qty_on_hand = (SELECT COALESCE(SUM(qty), 0) FROM stock_moves m WHERE m.lot_id = stock_lots.id) WHERE qty_on_hand IS NOT (SELECT COALESCE(SUM(qty), 0) FROM stock_moves m WHERE m.lot_id = stock_lots.id)`),
    db.prepare(`UPDATE stock_item_balances SET qty = (SELECT COALESCE(SUM(qty), 0) FROM stock_moves m WHERE m.item_id = stock_item_balances.item_id), value_mu = (SELECT COALESCE(SUM(value_mu), 0) FROM stock_moves m WHERE m.item_id = stock_item_balances.item_id)`),
    db.prepare(`DELETE FROM stock_daily`),
    db.prepare(`INSERT INTO stock_daily (day, item_id, reason, qty, value_mu, n) SELECT doc_date, item_id, reason, SUM(qty), SUM(value_mu), SUM(CASE WHEN reverses_move_id IS NULL THEN 1 ELSE -1 END) FROM stock_moves GROUP BY doc_date, item_id, reason`),
    db.prepare('DELETE FROM settings WHERE key = ?').bind(DONE_KEY),
    revStmt(db),
    revStmt(db, 'stock_catalog_rev'),
    db.prepare(`DELETE FROM maintenance WHERE flag = 'allow_stock_delete'`),
  ]);
}

export const STOCK_DEMO_TABLES = STOCK_TABLES;
