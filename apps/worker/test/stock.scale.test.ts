/**
 * «Склад» scale check (architecture §10.6): 300 items and one year of history of a ~12-sales/day shop
 * (owner's numbers: ~350 sales a month, average check 440 000 сум), bulk-loaded through the real
 * triggers. Then every key endpoint is called once through the app and the D1 round trips and
 * rows read / written are recorded against the budget table. The table is printed (copied into docs).
 *
 * Note: countingEnv counts rows of .all()/.run()/batch(); `.first()` calls (auth) are counted as
 * round trips only, so the read figures exclude ~10 rows of auth per request.
 */
import { addDays, pickLots, tashkentDay, type PickLot } from '@honey/stock';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import type { Env } from '../src/env.js';
import { countingEnv } from './d1Counter.js';
import { execCtx, makeStaff, mockTelegram, register, resetDb, setRole, testEnv } from './helpers.js';
import { CLIENT, FLORIST, k, OWNER } from './stockHelpers.js';

interface Measure { calls: number; read: number; written: number; status: number }
const table: Array<[string, Measure, { calls: number; read: number; written: number }]> = [];

async function measure(label: string, path: string, opts: { user: number; method?: string; body?: unknown; headers?: Record<string, string> }, budget: { calls: number; read: number; written: number }) {
  const { env, c } = countingEnv();
  const { ctx, flush } = execCtx();
  const headers: Record<string, string> = { 'x-test-user': String(opts.user), 'x-test-key': testEnv.TEST_KEY!, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }, env as Env, ctx);
  await flush();
  const m = { calls: c.calls, read: c.rowsRead, written: c.rowsWritten, status: res.status };
  table.push([label, m, budget]);
  return { res, m };
}

const DAYS = 365;
const ITEMS = 300;
let ids: { flowers: string[]; supplies: string[]; service: string } = { flowers: [], supplies: [], service: '' };

beforeAll(async () => {
  const tg = mockTelegram();
  await resetDb();
  await makeStaff(OWNER, 'owner', 'Владелец');
  await makeStaff(FLORIST, 'florist', 'Флорист');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  await register(CLIENT);
  const db = testEnv.DB;
  const now = new Date();
  const today = tashkentDay(now);
  const iso = now.toISOString();
  // 300 items: 120 flowers, 40 greenery, 120 supplies, 20 services
  const items = Array.from({ length: ITEMS }, (_, i) => {
    const kind = i < 120 ? 'flower' : i < 160 ? 'greenery' : i < 280 ? 'supply' : 'service';
    return { id: `it-${i}`, sku: `S${i}`, name: `Позиция ${i}`, kind, grp: kind, unit: kind === 'flower' || kind === 'greenery' ? 'stem' : 'pcs', track: kind === 'service' ? 0 : 1, std: 5_000_000 + (i % 17) * 1_000_000, sell: kind === 'supply' || kind === 'service' ? null : 4 };
  });
  await db.prepare(
    `INSERT INTO stock_items (id, sku, name, kind, grp, base_unit, display_unit, pack_size, sell_days, vase_life_days, track_stock, std_cost_mu, sort_order, created_at, updated_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.sku'), json_extract(value,'$.name'), json_extract(value,'$.kind'), json_extract(value,'$.grp'), json_extract(value,'$.unit'), 'шт', 25,
            json_extract(value,'$.sell'), json_extract(value,'$.sell'), json_extract(value,'$.track'), json_extract(value,'$.std'), key, ?1, ?1 FROM json_each(?2)`,
  ).bind(iso, JSON.stringify(items)).run();
  ids = { flowers: items.filter((i) => i.kind === 'flower' || i.kind === 'greenery').map((i) => i.id), supplies: items.filter((i) => i.kind === 'supply').map((i) => i.id), service: items.find((i) => i.kind === 'service')!.id };
  const popular = ids.flowers.slice(0, 40);
  // simulate the year in memory, FIFO with the production pickLots
  const open: Array<PickLot & { sellBy: string }> = [];
  const docs: unknown[] = [];
  const lots: unknown[] = [];
  const moves: unknown[] = [];
  const bouquets: unknown[] = [];
  const sales: unknown[] = [];
  let n = { receipt: 0, assembly: 0, writeoff: 0, sale: 0 };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let d = DAYS; d >= 1; d--) {
    const day = addDays(today, -d);
    const at = (h: number) => new Date(Date.parse(`${day}T00:00:00Z`) - 5 * 3_600_000 + h * 3_600_000).toISOString();
    // morning receipt: 12 popular flowers × 40 + 2 supplies × 50
    const rid = `r-${d}`;
    docs.push({ id: rid, kind: 'receipt', number: ++n.receipt, day, at: at(8) });
    const lineItems = [...Array.from({ length: 12 }, (_, j) => popular[(d * 7 + j * 3) % popular.length]!), ids.supplies[d % 120]!, ids.supplies[(d * 13) % 120]!];
    [...new Set(lineItems)].forEach((item, j) => {
      const qty = j < 12 ? 40 : 50;
      const cost = 6_000_000 + ((d + j) % 11) * 900_000;
      const id = `l-${d}-${j}`;
      lots.push({ id, item, doc: rid, recv: at(8), sell: addDays(day, 4), qty, cost });
      open.push({ id, itemId: item, qty, unitCostMu: cost, priority: 0, expiresOn: addDays(day, 7), receivedAt: at(8), sellBy: addDays(day, 4) });
      moves.push({ d: rid, l: j + 1, i: item, o: id, q: qty, v: qty * cost, r: 'receipt', dd: day, t: at(8) });
    });
    // 12 bouquets: 3–4 flower lines + 1 supply
    for (let b = 0; b < 12; b++) {
      const aid = `a-${d}-${b}`;
      const bid = `b-${d}-${b}`;
      const demand = [popular[Math.floor(rnd() * 40)]!, popular[Math.floor(rnd() * 40)]!, popular[Math.floor(rnd() * 40)]!].filter((x, i, a) => a.indexOf(x) === i).map((itemId) => ({ itemId, qty: 3 + Math.floor(rnd() * 9) }));
      const { picks, short } = pickLots(open, demand, { policy: 'block', confirmedShort: false, deficitCostMu: () => 0 });
      if (short.length) continue;
      let cost = 0;
      docs.push({ id: aid, kind: 'assembly', number: ++n.assembly, day, at: at(10 + b * 0.8) });
      picks.forEach((p, j) => {
        open.find((l) => l.id === p.lotId)!.qty -= p.qty;
        moves.push({ d: aid, l: j + 1, i: p.itemId, o: p.lotId, q: -p.qty, v: -Number(p.valueMu), r: 'assembly', dd: day, t: at(10 + b * 0.8), b: bid });
        cost += Number(p.valueMu);
      });
      const price = Math.max(150_000, Math.round((cost / 1000) * 3.6 / 10_000) * 10_000 + 5_000);
      const sid = `s-${d}-${b}`;
      bouquets.push({ id: bid, doc: aid, cost, cuzs: Math.round(cost / 1000), price, at: at(10 + b * 0.8), status: 'sold', sale: sid });
      docs.push({ id: sid, kind: 'sale', number: ++n.sale, day, at: at(10.1 + b * 0.8) });
      sales.push({ id: sid, bouquet: bid, total: price, cost: Math.round(cost / 1000), at: at(10.1 + b * 0.8) });
    }
    // evening: write off what passed its sell-by (keeps open lots realistic, as a florist would)
    const stale = open.filter((l) => l.qty > 0 && l.sellBy < day);
    if (stale.length) {
      const wid = `w-${d}`;
      docs.push({ id: wid, kind: 'writeoff', number: ++n.writeoff, day, at: at(20) });
      stale.forEach((l, j) => { moves.push({ d: wid, l: j + 1, i: l.itemId, o: l.id, q: -l.qty, v: -l.qty * l.unitCostMu, r: 'writeoff_wilt', dd: day, t: at(20) }); l.qty = 0; });
    }
  }
  const put = async (sql: string, rows: unknown[], size = 800) => {
    for (let i = 0; i < rows.length; i += size) await db.prepare(sql).bind(JSON.stringify(rows.slice(i, i + size))).run();
  };
  await put(
    `INSERT INTO stock_docs (id, kind, number, status, doc_date, idempotency_key, payload_hash, actor_id, actor_role, created_at, posted_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.kind'), json_extract(value,'$.number'), 'posted', json_extract(value,'$.day'), 'scale:' || json_extract(value,'$.id'), 'h', 'scale', 'florist', json_extract(value,'$.at'), json_extract(value,'$.at') FROM json_each(?1)`,
    docs,
  );
  await put(
    `INSERT INTO stock_lots (id, item_id, receipt_doc_id, received_at, sell_by, expires_on, qty_received, unit_cost_mu, created_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.item'), json_extract(value,'$.doc'), json_extract(value,'$.recv'), json_extract(value,'$.sell'), json_extract(value,'$.sell'), json_extract(value,'$.qty'), json_extract(value,'$.cost'), json_extract(value,'$.recv') FROM json_each(?1)`,
    lots,
  );
  // moves must go in chronological order (lots never negative): one statement per chunk, in order
  await put(
    `INSERT INTO stock_moves (doc_id, line_no, item_id, lot_id, qty, value_mu, reason, doc_date, bouquet_id, actor_id, created_at)
     SELECT json_extract(value,'$.d'), json_extract(value,'$.l'), json_extract(value,'$.i'), json_extract(value,'$.o'), json_extract(value,'$.q'), json_extract(value,'$.v'), json_extract(value,'$.r'), json_extract(value,'$.dd'), json_extract(value,'$.b'), 'scale', json_extract(value,'$.t') FROM json_each(?1) ORDER BY key`,
    moves,
    1500,
  );
  await put(
    `INSERT INTO stock_bouquets (id, assembly_doc_id, kind, status, florist_id, cost_mu, cost_uzs, flowers_cost_uzs, supplies_cost_uzs, suggested_price_uzs, price_uzs, price_current_uzs, sale_id, created_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.doc'), 'order', json_extract(value,'$.status'), 'scale', json_extract(value,'$.cost'), json_extract(value,'$.cuzs'), json_extract(value,'$.cuzs'), 0, json_extract(value,'$.price'), json_extract(value,'$.price'), json_extract(value,'$.price'), json_extract(value,'$.sale'), json_extract(value,'$.at') FROM json_each(?1)`,
    bouquets,
  );
  await put(
    `INSERT INTO stock_sales (id, total_uzs, paid_uzs, payment_method, cost_uzs, actor_id, created_at)
     SELECT json_extract(value,'$.id'), json_extract(value,'$.total'), json_extract(value,'$.total'), 'cash', json_extract(value,'$.cost'), 'scale', json_extract(value,'$.at') FROM json_each(?1)`,
    sales,
  );
  await put(`INSERT INTO stock_sale_lines (sale_id, line_no, kind, bouquet_id, qty, price_uzs, cost_uzs, category) SELECT json_extract(value,'$.id'), 1, 'bouquet', json_extract(value,'$.bouquet'), 1, json_extract(value,'$.total'), json_extract(value,'$.cost'), 'flowers' FROM json_each(?1)`, sales);
  tg.restore();
}, 300_000);

describe('stock at the scale of one year', () => {
  it('rows read / written per endpoint stay within the architecture budget', async () => {
    const tg = mockTelegram();
    const counts = await testEnv.DB.prepare(`SELECT (SELECT COUNT(*) FROM stock_moves) AS moves, (SELECT COUNT(*) FROM stock_lots WHERE qty_on_hand > 0) AS open, (SELECT COUNT(*) FROM stock_bouquets) AS b`).first<Record<string, number>>();
    expect(counts!.moves).toBeGreaterThan(20_000);
    // first catalog of the day also computes the 30-day «most used» order (cached in settings for the day)
    await measure('GET /api/stock/catalog (first of the day: + 30-day usage)', '/api/stock/catalog', { user: FLORIST }, { calls: 7, read: 3_500, written: 2 });
    await testEnv.DB.prepare(`UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'stock_rev'`).run(); // stock changed → ETag changes
    const cold = await measure('GET /api/stock/catalog (cold)', '/api/stock/catalog', { user: FLORIST }, { calls: 6, read: 1_000, written: 0 });
    expect(cold.res.status).toBe(200);
    const etag = cold.res.headers.get('etag')!;
    await measure('GET /api/stock/catalog (304)', '/api/stock/catalog', { user: FLORIST, headers: { 'if-none-match': etag } }, { calls: 6, read: 20, written: 0 });
    const popular = ids.flowers.slice(0, 40);
    // receipt of 15 lines (restocks what the assembly below needs)
    const rec = await measure('POST /api/stock/receipts (15 lines)', '/api/stock/receipts', {
      user: OWNER,
      body: { idempotencyKey: k('sr'), currency: 'UZS', priceMode: 'lines', confirm: true, lines: Array.from({ length: 15 }, (_, j) => ({ itemId: popular[j]!, qty: 50, unit: 'base', price: 9_000, per: 'unit' })) },
    }, { calls: 8, read: 150, written: 250 });
    expect(rec.res.status).toBe(201);
    const asm = await measure('POST /api/stock/bouquets (6 lines)', '/api/stock/bouquets', {
      user: FLORIST,
      body: { idempotencyKey: k('sb'), kind: 'order', lines: [...popular.slice(0, 5).map((itemId) => ({ itemId, qty: 7 })), { itemId: ids.supplies[0]!, qty: 1 }], allowShort: true, shortComment: 'масштаб' },
    }, { calls: 8, read: 150, written: 100 });
    expect(asm.res.status).toBe(201);
    const bouquetId = (await asm.res.json() as { bouquet: { id: string } }).bouquet.id;
    const me = await (await app.request('/api/me', { headers: { 'x-test-user': String(CLIENT), 'x-test-key': testEnv.TEST_KEY! } }, testEnv)).json() as { client: { id: string } };
    const sale = await measure('POST /api/stock/sales (with client)', '/api/stock/sales', {
      user: FLORIST, body: { idempotencyKey: k('ss'), clientId: me.client.id, bouquets: [{ id: bouquetId }], services: [{ itemId: ids.service, price: 30_000 }], channel: 'delivery', paymentMethod: 'card' },
    }, { calls: 22, read: 500, written: 80 });
    expect(sale.res.status).toBe(201);
    await measure('GET /api/stock/freshness', '/api/stock/freshness', { user: FLORIST }, { calls: 6, read: 400, written: 0 });
    await measure('GET /api/owner/stock/overview', '/api/owner/stock/overview', { user: OWNER }, { calls: 6, read: 5_000, written: 0 });
    await measure('GET /api/owner/stock/bouquets (30 days, page)', '/api/owner/stock/bouquets', { user: OWNER }, { calls: 6, read: 5_000, written: 0 });
    await measure('GET /api/owner/stock/writeoffs (30 days, page)', '/api/owner/stock/writeoffs', { user: OWNER }, { calls: 6, read: 5_000, written: 0 });
    await measure('GET /api/owner/stock/receipts (30 days)', '/api/owner/stock/receipts', { user: OWNER }, { calls: 6, read: 5_000, written: 0 });
    await measure('GET /api/owner/stock/balances', '/api/owner/stock/balances', { user: OWNER }, { calls: 6, read: 5_000, written: 0 });
    tg.restore();

    const lines = table.map(([l, m, b]) => `| ${l} | ${m.status} | ${m.calls} (≤ ${b.calls}) | ${m.read} (≤ ${b.read}) | ${m.written} (≤ ${b.written}) |${m.calls > b.calls || m.read > b.read || m.written > b.written ? ' ⚠' : ''}`);
    console.log(`\nstock scale: ${counts!.moves} moves, ${counts!.open} open lots, ${counts!.b} bouquets\n| endpoint | status | D1 calls | rows read | rows written |\n|---|---|---|---|---|\n${lines.join('\n')}\n`);
    // Hard limits: Workers Free (50 calls) and 2× the architecture budget (a missing index blows these up).
    for (const [l, m, b] of table) {
      expect(m.calls, l).toBeLessThanOrEqual(Math.max(b.calls * 2, 12));
      expect(m.read, l).toBeLessThanOrEqual(b.read * 2 + 50);
      expect(m.written, l).toBeLessThanOrEqual(b.written * 2 + 20);
    }
  }, 120_000);
});
