import type { StockCatalogDTO, StockItemDTO } from '@honey/contracts';
import { expect } from 'vitest';
import { call, json, makeStaff, repo, resetDb, setRole, T, testEnv } from './helpers.js';

export const OWNER = T + 501;
export const FLORIST = T + 502;
export const FLORIST2 = T + 503;
export const CLIENT = T + 504;

let seq = 0;
export const k = (p = 'stk') => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Fresh DB with an owner, two florists (testers with switched roles) and the starter catalog. */
export async function stockSetup(): Promise<StockCatalogDTO> {
  await resetDb();
  await makeStaff(OWNER, 'owner', 'Велимира');
  await makeStaff(FLORIST, 'florist', 'Дилноза');
  await makeStaff(FLORIST2, 'florist', 'Малика');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  await setRole(FLORIST2, 'florist');
  const seeded = await call('/api/owner/stock/catalog/seed', { user: OWNER, body: {} });
  expect(seeded.status).toBe(201);
  return catalog();
}

export async function catalog(user = FLORIST): Promise<StockCatalogDTO> {
  const r = await call('/api/stock/catalog', { user });
  expect(r.status).toBe(200);
  return json<StockCatalogDTO>(r);
}

export async function item(sku: string): Promise<StockItemDTO> {
  const c = await catalog();
  const it = c.items.find((i) => i.sku === sku);
  if (!it) throw new Error(`no item ${sku}`);
  return it;
}

export async function receive(lines: Array<{ sku: string; qty: number; price: number; unit?: 'base' | 'pack'; per?: 'unit' | 'pack' | 'line' }>, extra: Record<string, unknown> = {}, user = OWNER) {
  const c = await catalog();
  const id = (sku: string) => c.items.find((i) => i.sku === sku)!.id;
  const r = await call('/api/stock/receipts', {
    user,
    body: {
      idempotencyKey: k('rc'), currency: 'UZS', priceMode: 'lines', confirm: true,
      lines: lines.map((l) => ({ itemId: id(l.sku), qty: l.qty, unit: l.unit ?? 'base', price: l.price, per: l.per ?? 'unit' })), ...extra,
    },
  });
  if (r.status !== 201) throw new Error(`receipt failed ${r.status} ${await r.text()}`);
  return json(r);
}

export async function bouquet(lines: Array<{ sku: string; qty: number }>, extra: Record<string, unknown> = {}, user = FLORIST) {
  const c = await catalog();
  const id = (sku: string) => c.items.find((i) => i.sku === sku)!.id;
  return call('/api/stock/bouquets', { user, body: { idempotencyKey: k('bq'), kind: 'order', lines: lines.map((l) => ({ itemId: id(l.sku), qty: l.qty })), ...extra } });
}

/** Ledger invariants straight from SQL (architecture §10.3 items 1–4, 7). */
export async function ledgerInvariants(): Promise<string[]> {
  const db = testEnv.DB;
  const bad: string[] = [];
  const q = async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;
  for (const r of await q(`SELECT l.id, l.qty_on_hand, COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.lot_id = l.id), 0) AS s, l.kind, l.qty_received FROM stock_lots l`)) {
    if (Number(r.qty_on_hand) !== Number(r.s)) bad.push(`lot ${r.id}: cache ${r.qty_on_hand} ≠ Σ moves ${r.s}`);
    if (r.kind === 'normal' && (Number(r.qty_on_hand) < 0 || Number(r.qty_on_hand) > Number(r.qty_received))) bad.push(`lot ${r.id} out of bounds`);
  }
  for (const r of await q(`SELECT b.item_id, b.qty, b.value_mu, COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.item_id = b.item_id), 0) AS sq, COALESCE((SELECT SUM(value_mu) FROM stock_moves m WHERE m.item_id = b.item_id), 0) AS sv FROM stock_item_balances b`)) {
    if (Number(r.qty) !== Number(r.sq) || Number(r.value_mu) !== Number(r.sv)) bad.push(`balance ${r.item_id}: ${r.qty}/${r.value_mu} ≠ ${r.sq}/${r.sv}`);
  }
  // value conservation: Σ moves value = Σ lot qty × unit cost
  const [tot] = await q(`SELECT (SELECT COALESCE(SUM(value_mu),0) FROM stock_moves) AS mv, (SELECT COALESCE(SUM(qty_on_hand * unit_cost_mu),0) FROM stock_lots) AS lv`);
  if (Number(tot!.mv) !== Number(tot!.lv)) bad.push(`value: Σ moves ${tot!.mv} ≠ Σ lots ${tot!.lv}`);
  const daily = await q(`SELECT d.day, d.item_id, d.reason, d.qty, d.value_mu, COALESCE(m.q, 0) AS mq, COALESCE(m.v, 0) AS mvv FROM stock_daily d LEFT JOIN
      (SELECT doc_date, item_id, reason, SUM(qty) AS q, SUM(value_mu) AS v FROM stock_moves GROUP BY doc_date, item_id, reason) m ON m.doc_date = d.day AND m.item_id = d.item_id AND m.reason = d.reason`);
  for (const r of daily) if (Number(r.qty) !== Number(r.mq) || Number(r.value_mu) !== Number(r.mvv)) bad.push(`daily ${r.day} ${r.item_id} ${r.reason}`);
  const [cnt] = await q(`SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM stock_moves GROUP BY doc_date, item_id, reason)) AS g, (SELECT COUNT(*) FROM stock_daily) AS d`);
  if (Number(cnt!.g) !== Number(cnt!.d)) bad.push(`daily rows ${cnt!.d} ≠ groups ${cnt!.g}`);
  // bouquet cost = −Σ assembly moves (+ untracked at std cost, recorded in doc line values)
  for (const r of await q(`SELECT b.id, b.cost_mu, COALESCE((SELECT -SUM(value_mu) FROM stock_moves m WHERE m.doc_id = b.assembly_doc_id AND m.reverses_move_id IS NULL), 0) AS mv,
      (SELECT COALESCE(SUM(value_mu),0) FROM stock_doc_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.doc_id = b.assembly_doc_id AND i.track_stock = 0) AS untracked FROM stock_bouquets b`)) {
    if (Number(r.cost_mu) !== Number(r.mv) + Number(r.untracked)) bad.push(`bouquet ${r.id}: cost ${r.cost_mu} ≠ moves ${r.mv} + untracked ${r.untracked}`);
  }
  const [posting] = await q(`SELECT COUNT(*) AS n FROM stock_docs WHERE status = 'posting'`);
  if (Number(posting!.n)) bad.push(`${posting!.n} docs stuck in posting`);
  return bad;
}

export { call, json, repo, testEnv };
