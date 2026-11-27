/**
 * «Склад» prototype: routes + SQL on the local D1 (workerd). Receipts (UZS / USD, total mode, extra
 * costs, deficit settle, cancel rules), FIFO assembly with frozen cost, concurrency on the last
 * stems, «в минус», sale ↔ loyalty, disassembly, write-off approval, idempotency, ledger guards.
 * After every scenario the ledger invariants are checked straight from SQL.
 */
import type { AssembleResultDTO, BouquetDTO, FreshnessDTO, ReceiptPreviewDTO, ReceiptResultDTO, StockOverviewDTO, StockSaleResultDTO, WriteoffResultDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockTelegram, register } from './helpers.js';
import { bouquet, call, catalog, CLIENT, FLORIST, FLORIST2, item, json, k, ledgerInvariants, OWNER, receive, stockSetup, testEnv } from './stockHelpers.js';

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  tg = mockTelegram();
  await stockSetup();
});
afterEach(() => tg.restore());

describe('catalog', () => {
  it('starter catalog, ETag 304, owner edits with version', async () => {
    const c = await catalog();
    expect(c.items.length).toBeGreaterThanOrEqual(30);
    expect(c.items.find((i) => i.sku === 'DLV')).toMatchObject({ kind: 'service', trackStock: false });
    expect(c.items.find((i) => i.sku === 'RN60')).toMatchObject({ unit: { pack: { size: 25 } }, vaseLifeDays: 7, sellDays: 4 });
    const r304 = await call('/api/stock/catalog', { user: FLORIST, headers: { 'if-none-match': c.rev } });
    expect(r304.status).toBe(304);
    const rn = c.items.find((i) => i.sku === 'RN60')!;
    const body = { sku: 'RN60', name: 'Роза Red Naomi 60 см', kind: 'flower', group: 'Розы', baseUnit: 'stem', displayUnit: 'шт', packSize: 25, version: rn.version };
    const ok = await call(`/api/owner/stock/items/${rn.id}`, { user: OWNER, method: 'PUT', body });
    expect(ok.status).toBe(200);
    const stale = await call(`/api/owner/stock/items/${rn.id}`, { user: OWNER, method: 'PUT', body });
    expect(stale.status).toBe(409);
    expect((await call('/api/stock/catalog', { user: FLORIST, headers: { 'if-none-match': c.rev } })).status).toBe(200);
    // seeding again changes nothing
    const again = await json(call('/api/owner/stock/catalog/seed', { user: OWNER, body: {} }));
    expect(again.items).toBe(0);
  });
});

describe('receipts', () => {
  it('UZS per pack + extra cost → lots, balances, last cost; preview = posted', async () => {
    const c = await catalog();
    const rn = c.items.find((i) => i.sku === 'RN60')!;
    const eu = c.items.find((i) => i.sku === 'EUC')!;
    const req = {
      idempotencyKey: k(), currency: 'UZS', priceMode: 'lines', extraCost: 50_000,
      lines: [{ itemId: rn.id, qty: 2, unit: 'pack', price: 300_000, per: 'pack' }, { itemId: eu.id, qty: 30, unit: 'base', price: 6_000, per: 'unit' }],
    };
    const pv = await json<ReceiptPreviewDTO>(call('/api/stock/receipts/preview', { user: OWNER, body: req }));
    expect(pv.goodsUzs).toBe(780_000);
    expect(pv.totalUzs).toBe(830_000);
    expect(pv.lines[0]!.qtyBase).toBe(50);
    const posted = await call('/api/stock/receipts', { user: OWNER, body: req });
    expect(posted.status).toBe(201);
    const res = await json<ReceiptResultDTO>(posted);
    expect(res.preview.lines.map((l) => l.unitCostMu)).toEqual(pv.lines.map((l) => l.unitCostMu));
    const rn2 = await item('RN60');
    expect(rn2.qty).toBe(50);
    expect(rn2.lastCostMu).toBe(pv.lines[0]!.unitCostMu);
    expect(rn2.ladder[0]).toMatchObject({ qty: 50, freshness: 'fresh' });
    // same key, same payload → replay; same key, other payload → 409
    const replay = await call('/api/stock/receipts', { user: OWNER, body: req });
    expect(replay.status).toBe(200);
    expect((await json<ReceiptResultDTO>(replay)).replayed).toBe(true);
    const other = await call('/api/stock/receipts', { user: OWNER, body: { ...req, extraCost: 1 } });
    expect(other.status).toBe(409);
    expect((await item('RN60')).qty).toBe(50);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('USD «одной суммой» with a manual line; warnings need confirm; backdating only for the owner', async () => {
    await receive([{ sku: 'RN60', qty: 25, price: 12_000 }, { sku: 'EUC', qty: 10, price: 6_000 }]);
    const c = await catalog();
    const rn = c.items.find((i) => i.sku === 'RN60')!;
    const eu = c.items.find((i) => i.sku === 'EUC')!;
    const req = {
      idempotencyKey: k(), currency: 'USD', fxRate: 12_850, priceMode: 'total', total: 62.5,
      lines: [{ itemId: rn.id, qty: 2, unit: 'pack' }, { itemId: eu.id, qty: 30, unit: 'base', price: 0.45, per: 'unit' }],
    };
    const pv = await json<ReceiptPreviewDTO>(call('/api/stock/receipts/preview', { user: OWNER, body: req }));
    expect(pv.goodsCur).toBeCloseTo(62.5, 2);
    expect(pv.goodsUzs).toBe(Math.round(62.5 * 12_850));
    expect(pv.lines[1]!.manual).toBe(true);
    // 0,45 $ × 12 850 = 5 782,5 сум per stem
    expect(pv.lines[1]!.unitCostMu).toBe(5_782_500);
    const post = await call('/api/stock/receipts', { user: OWNER, body: req });
    if (pv.warnings.length) {
      expect(post.status).toBe(409);
      expect((await json(post)).error.code).toBe('confirm_required');
    } else expect(post.status).toBe(201);
    // `confirm` is not part of the payload hash: the same receipt confirmed is the same document
    const ok = await call('/api/stock/receipts', { user: OWNER, body: { ...req, confirm: true } });
    expect(ok.status).toBe(pv.warnings.length ? 201 : 200);
    const form = await json(call('/api/stock/receipts/form', { user: FLORIST }));
    expect(form.lastFxRate).toBe(12_850);
    expect(form.canBackdate).toBe(false);
    const back = await call('/api/stock/receipts', { user: FLORIST, body: { ...req, idempotencyKey: k(), docDate: '2026-01-01', confirm: true } });
    expect(back.status).toBe(403);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('cancel: untouched → storno; touched → lot_used; twice → already_cancelled', async () => {
    const a = await receive([{ sku: 'TLR', qty: 50, price: 7_000 }]);
    const b = await receive([{ sku: 'TLY', qty: 50, price: 7_000 }]);
    expect((await bouquet([{ sku: 'TLY', qty: 5 }])).status).toBe(201);
    const ok = await call(`/api/owner/stock/receipts/${a.receiptId}/cancel`, { user: OWNER, body: {} });
    expect(ok.status).toBe(200);
    expect((await item('TLR')).qty).toBe(0);
    const twice = await call(`/api/owner/stock/receipts/${a.receiptId}/cancel`, { user: OWNER, body: {} });
    expect((await json(twice)).error.code).toBe('already_cancelled');
    const used = await call(`/api/owner/stock/receipts/${b.receiptId}/cancel`, { user: OWNER, body: {} });
    expect(used.status).toBe(409);
    expect((await json(used)).error.code).toBe('lot_used');
    expect((await call(`/api/owner/stock/receipts/${b.receiptId}/cancel`, { user: FLORIST, body: {} })).status).toBe(403);
    expect(await ledgerInvariants()).toEqual([]);
  });
});

describe('assembly', () => {
  it('FIFO across lots, frozen cost, suggested price …5 000, shares', async () => {
    await receive([{ sku: 'RN60', qty: 10, price: 9_000 }]);
    await receive([{ sku: 'RN60', qty: 10, price: 12_000 }, { sku: 'EUC', qty: 10, price: 6_000 }, { sku: 'KRF', qty: 10, price: 4_000 }]);
    const r = await bouquet([{ sku: 'RN60', qty: 15 }, { sku: 'EUC', qty: 3 }, { sku: 'KRF', qty: 2 }, { sku: 'TAP', qty: 1 }]);
    expect(r.status).toBe(201);
    const { bouquet: b } = await json<AssembleResultDTO>(r);
    // 10 × 9 000 + 5 × 12 000 + 3 × 6 000 = 168 000 flowers; 2 × 4 000 + 300 (tape, untracked) = 8 300
    expect(b.flowersCost).toBe(168_000);
    expect(b.suppliesCost).toBe(8_300);
    expect(b.cost).toBe(176_300);
    expect(b.suggestedPrice % 10_000).toBe(5_000);
    expect(b.lines[0]!.lots.map((l) => l.qty)).toEqual([10, 5]);
    expect(b.price).toBe(b.suggestedPrice);
    expect((await item('RN60')).qty).toBe(5);
    // frozen: the DB refuses to change the cost
    await expect(testEnv.DB.prepare('UPDATE stock_bouquets SET cost_uzs = 1 WHERE id = ?').bind(b.id).run()).rejects.toThrow(/заморожена/);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('two florists, the last stems: exactly one bouquet, the other gets stock_short', async () => {
    await receive([{ sku: 'EUW', qty: 10, price: 15_000 }]);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => bouquet([{ sku: 'EUW', qty: 3 }], {}, i % 2 ? FLORIST : FLORIST2)));
    const codes = res.map((r) => r.status);
    expect(codes.filter((s) => s === 201)).toHaveLength(3);
    expect(codes.filter((s) => s === 409)).toHaveLength(5);
    for (const r of res.filter((x) => x.status === 409)) {
      const e = await json(r);
      expect(e.error.code).toBe('stock_short');
      expect(e.error.details.short[0]).toMatchObject({ need: 3, have: 1 });
      expect(e.error.details.canForce).toBe(true);
    }
    expect((await item('EUW')).qty).toBe(1);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('«собрать в минус» with a comment → deficit lot; the next receipt settles it', async () => {
    await receive([{ sku: 'ALS', qty: 4, price: 8_000 }]);
    const short = await bouquet([{ sku: 'ALS', qty: 7 }]);
    expect(short.status).toBe(409);
    expect((await bouquet([{ sku: 'ALS', qty: 7 }], { allowShort: true })).status).toBe(400); // comment required
    const ok = await bouquet([{ sku: 'ALS', qty: 7 }], { allowShort: true, shortComment: 'клиент ждёт' });
    expect(ok.status).toBe(201);
    const b = (await json<AssembleResultDTO>(ok)).bouquet;
    expect(b.usedDeficit).toBe(true);
    expect(b.cost).toBe(7 * 8_000); // deficit at the last receipt cost
    expect((await item('ALS')).qty).toBe(-3);
    const rec = await receive([{ sku: 'ALS', qty: 10, price: 9_000 }]);
    expect(rec.settledDeficit).toBe(3);
    expect((await item('ALS')).qty).toBe(7);
    const ov = await json<StockOverviewDTO>(call('/api/owner/stock/overview', { user: OWNER }));
    expect(ov.deficits).toEqual([]);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('idempotent: double tap = one bouquet; services cannot be in a bouquet', async () => {
    await receive([{ sku: 'CAR', qty: 25, price: 5_000 }]);
    const c = await catalog();
    const body = { idempotencyKey: k(), kind: 'showcase', lines: [{ itemId: c.items.find((i) => i.sku === 'CAR')!.id, qty: 9 }], price: 145_000 };
    const [a, b2] = await Promise.all([call('/api/stock/bouquets', { user: FLORIST, body }), call('/api/stock/bouquets', { user: FLORIST, body })]);
    expect([a.status, b2.status].sort()).toEqual([200, 201]);
    expect((await item('CAR')).qty).toBe(16);
    const svc = await call('/api/stock/bouquets', { user: FLORIST, body: { idempotencyKey: k(), kind: 'order', lines: [{ itemId: c.items.find((i) => i.sku === 'DLV')!.id, qty: 1 }] } });
    expect(svc.status).toBe(400);
  });
});

describe('sale ↔ loyalty, showcase, disassembly', () => {
  it('sell to a client: purchase sale:<id>, honey only on flowers, second sale of the bouquet is refused', async () => {
    const me = await register(CLIENT);
    await receive([{ sku: 'RN60', qty: 25, price: 12_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'RN60', qty: 15 }], { price: 495_000 }))).bouquet;
    const c = await catalog();
    const dlv = c.items.find((i) => i.sku === 'DLV')!;
    const body = { idempotencyKey: k('sale'), clientId: me.client!.id, bouquets: [{ id: b.id }], services: [{ itemId: dlv.id, price: 30_000 }], channel: 'delivery', paymentMethod: 'card' };
    const pv = await json(call('/api/stock/sales/preview', { user: FLORIST, body }));
    expect(pv.total).toBe(525_000);
    const r = await call('/api/stock/sales', { user: FLORIST, body });
    expect(r.status).toBe(201);
    const s = await json<StockSaleResultDTO>(r);
    expect(s.loyaltyStatus).toBe('done');
    expect(s.cashback).toBe(pv.loyalty.cashback);
    const p = await testEnv.DB.prepare('SELECT idempotency_key, amount, lines FROM purchases WHERE id = ?').bind(s.purchaseId).first<Record<string, unknown>>();
    expect(p!.idempotency_key).toBe(`sale:${s.saleId}`);
    expect(JSON.parse(String(p!.lines))).toEqual(expect.arrayContaining([{ category: 'flowers', amount: 495_000 }, { category: 'delivery', amount: 30_000 }]));
    const meAfter = await json(call('/api/me', { user: CLIENT }));
    expect(meAfter.client.balance).toBeGreaterThan(me.client!.balance);
    // replay: same answer, no second purchase
    const again = await json<StockSaleResultDTO>(call('/api/stock/sales', { user: FLORIST, body }));
    expect(again.replayed).toBe(true);
    expect(again.purchaseId).toBe(s.purchaseId);
    const second = await call('/api/stock/sales', { user: FLORIST2, body: { ...body, idempotencyKey: k('sale') } });
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe('bouquet_state');
    const n = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE idempotency_key LIKE 'sale:%'`).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('sale without a client; parallel sales of one showcase bouquet → exactly one', async () => {
    await receive([{ sku: 'TLR', qty: 50, price: 7_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 25 }], { kind: 'showcase' }))).bouquet;
    expect(b.status).toBe('on_showcase');
    const res = await Promise.all(Array.from({ length: 5 }, () => call('/api/stock/sales', { user: FLORIST, body: { idempotencyKey: k('sale'), bouquets: [{ id: b.id }], paymentMethod: 'cash' } })));
    expect(res.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    const ok = await json<StockSaleResultDTO>(res.find((r) => r.status === 201)!);
    expect(ok.loyaltyStatus).toBe('none');
  });

  it('showcase disassembly: usable stems back into the original lots, the rest is waste', async () => {
    await receive([{ sku: 'EUL', qty: 10, price: 15_000 }]);
    await receive([{ sku: 'EUL', qty: 10, price: 16_000 }, { sku: 'GYP', qty: 10, price: 10_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'EUL', qty: 12 }, { sku: 'GYP', qty: 2 }], { kind: 'showcase' }))).bouquet;
    const before = await item('EUL');
    expect(before.qty).toBe(8);
    const gyp = await item('GYP');
    const r = await call(`/api/stock/bouquets/${b.id}/disassemble`, { user: FLORIST, body: { idempotencyKey: k('dis'), good: [{ itemId: before.id, qty: 9 }, { itemId: gyp.id, qty: 2 }] } });
    expect(r.status).toBe(201);
    const d = await json(r);
    expect(d.wasted).toBe(3);
    expect(d.wasteUzs).toBe(3 * 15_000); // waste from the oldest lot
    expect(d.bouquet.status).toBe('disassembled');
    expect((await item('EUL')).qty).toBe(17);
    expect((await item('GYP')).qty).toBe(10);
    // cannot sell a disassembled bouquet
    const sell = await call('/api/stock/sales', { user: FLORIST, body: { idempotencyKey: k('sale'), bouquets: [{ id: b.id }], paymentMethod: 'cash' } });
    expect((await json(sell)).error.code).toBe('bouquet_state');
    const fr = await json<FreshnessDTO>(call('/api/stock/freshness', { user: FLORIST }));
    expect(fr.groups.fresh.count).toBeGreaterThan(0);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('cancel own assembly → stems back; another florist cannot', async () => {
    await receive([{ sku: 'LR40', qty: 30, price: 6_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'LR40', qty: 11 }]))).bouquet;
    expect((await call(`/api/stock/bouquets/${b.id}/cancel`, { user: FLORIST2, body: {} })).status).toBe(403);
    const ok = await call(`/api/stock/bouquets/${b.id}/cancel`, { user: FLORIST, body: {} });
    expect(ok.status).toBe(200);
    expect((await json<BouquetDTO>(ok)).status).toBe('cancelled');
    expect((await item('LR40')).qty).toBe(30);
    expect(await ledgerInvariants()).toEqual([]);
  });
});

describe('write-offs', () => {
  it('above 200 000 → pending; owner approves / rejects (storno); second decision 409', async () => {
    await receive([{ sku: 'POH', qty: 20, price: 25_000 }]);
    const it = await item('POH');
    const small = await json<WriteoffResultDTO>(call('/api/stock/writeoffs', { user: FLORIST, body: { idempotencyKey: k('wo'), lines: [{ itemId: it.id, qty: 2, reason: 'damage' }] } }));
    expect(small.approval).toBe('none');
    const big = await json<WriteoffResultDTO>(call('/api/stock/writeoffs', { user: FLORIST, body: { idempotencyKey: k('wo'), lines: [{ itemId: it.id, qty: 9, reason: 'wilt' }] } }));
    expect(big).toMatchObject({ approval: 'pending', valueUzs: 225_000 });
    const big2 = await json<WriteoffResultDTO>(call('/api/stock/writeoffs', { user: FLORIST, body: { idempotencyKey: k('wo'), lines: [{ itemId: it.id, qty: 8, reason: 'supplier' }] } }));
    expect((await item('POH')).qty).toBe(1);
    const list = await json(call('/api/owner/stock/approvals', { user: OWNER }));
    expect(list).toHaveLength(2);
    expect((await call(`/api/owner/stock/approvals/${big.docId}`, { user: FLORIST, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(`/api/owner/stock/approvals/${big.docId}`, { user: OWNER, body: { decision: 'approve' } })).status).toBe(200);
    expect((await json(call(`/api/owner/stock/approvals/${big.docId}`, { user: OWNER, body: { decision: 'reject', reason: 'передумали' } }))).error.code).toBe('already_decided');
    const rej = await call(`/api/owner/stock/approvals/${big2.docId}`, { user: OWNER, body: { decision: 'reject', reason: 'цветы на месте' } });
    expect(rej.status).toBe(200);
    expect((await item('POH')).qty).toBe(9);
    const too = await call('/api/stock/writeoffs', { user: FLORIST, body: { idempotencyKey: k('wo'), lines: [{ itemId: it.id, qty: 10, reason: 'wilt' }] } });
    expect((await json(too)).error.code).toBe('stock_short');
    const owner = await json<WriteoffResultDTO>(call('/api/stock/writeoffs', { user: OWNER, body: { idempotencyKey: k('wo'), lines: [{ itemId: it.id, qty: 9, reason: 'wilt' }] } }));
    expect(owner.approval).toBe('approved');
    const ov = await json<StockOverviewDTO>(call('/api/owner/stock/overview', { user: OWNER }));
    expect(ov.wasteWeek.wasteUzs).toBe(2 * 25_000 + 9 * 25_000 + 9 * 25_000);
    expect(await ledgerInvariants()).toEqual([]);
  });
});

describe('guards and access', () => {
  it('journal is append-only; lots immutable; deleting needs the maintenance flag', async () => {
    await receive([{ sku: 'RUS', qty: 10, price: 3_500 }]);
    const db = testEnv.DB;
    await expect(db.prepare('UPDATE stock_moves SET qty = 1').run()).rejects.toThrow(/только дополняется/);
    await expect(db.prepare('DELETE FROM stock_moves').run()).rejects.toThrow(/только дополняется/);
    await expect(db.prepare('UPDATE stock_lots SET unit_cost_mu = 1').run()).rejects.toThrow(/неизменяема/);
    await expect(db.prepare('UPDATE stock_lots SET qty_on_hand = -1').run()).rejects.toThrow(/stock_lots_bounds/);
    await expect(db.prepare('DELETE FROM stock_docs').run()).rejects.toThrow(/не удаляются/);
    await expect(db.prepare(`UPDATE stock_docs SET doc_date = '2020-01-01'`).run()).rejects.toThrow(/недопустимое/);
  });

  it('client: 403 on every stock route; florist: 403 on owner-only; flag off: 404', async () => {
    await register(CLIENT);
    const routes: Array<[string, string]> = [
      ['GET', '/api/stock/status'], ['GET', '/api/stock/catalog'], ['GET', '/api/stock/templates'], ['GET', '/api/stock/suppliers'], ['GET', '/api/stock/receipts/form'],
      ['POST', '/api/stock/receipts/preview'], ['POST', '/api/stock/receipts'], ['GET', '/api/stock/receipts'], ['POST', '/api/stock/bouquets'], ['GET', '/api/stock/bouquets'],
      ['POST', '/api/stock/bouquets/x/showcase'], ['POST', '/api/stock/bouquets/x/disassemble'], ['POST', '/api/stock/bouquets/x/cancel'], ['POST', '/api/stock/sales/preview'],
      ['POST', '/api/stock/sales'], ['POST', '/api/stock/sales/x/loyalty'], ['POST', '/api/stock/writeoffs'], ['GET', '/api/stock/freshness'], ['POST', '/api/stock/lots/x/priority'],
      ['POST', '/api/stock/templates'], ['GET', '/api/stock/items/x'], ['GET', '/api/stock/bouquets/x'],
    ];
    const owner: Array<[string, string]> = [
      ['GET', '/api/owner/stock/overview'], ['GET', '/api/owner/stock/config'], ['PUT', '/api/owner/stock/config'], ['POST', '/api/owner/stock/items'], ['PUT', '/api/owner/stock/items/x'],
      ['POST', '/api/owner/stock/catalog/seed'], ['POST', '/api/owner/stock/suppliers'], ['POST', '/api/owner/stock/receipts/x/cancel'], ['GET', '/api/owner/stock/approvals'],
      ['POST', '/api/owner/stock/approvals/x'], ['GET', '/api/owner/stock/balances'], ['GET', '/api/owner/stock/receipts'], ['GET', '/api/owner/stock/bouquets'], ['GET', '/api/owner/stock/writeoffs'],
    ];
    for (const [method, path] of [...routes, ...owner]) {
      const r = await call(path, { user: CLIENT, method, ...(method === 'GET' ? {} : { body: {} }) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    for (const [method, path] of owner) {
      const r = await call(path, { user: FLORIST, method, ...(method === 'GET' ? {} : { body: {} }) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    const app = (await import('../src/app.js')).default;
    for (const [method, path] of [...routes, ...owner]) {
      const r = await app.request(path, { method, headers: { 'x-test-user': String(OWNER), 'x-test-key': testEnv.TEST_KEY!, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }, { ...testEnv, STOCK_ENABLED: '0' });
      expect(r.status, `${method} ${path} with STOCK_ENABLED=0`).toBe(404);
    }
    // without auth the flag still answers 404 first (the module does not exist)
    expect((await app.request('/api/stock/catalog', {}, { ...testEnv, STOCK_ENABLED: '0' })).status).toBe(404);
    expect((await app.request('/api/stock/catalog', {}, testEnv)).status).toBe(401);
  });

  it('fuzz-ish bad input → 400/404/409 only, Russian message', async () => {
    const c = await catalog();
    const rn = c.items.find((i) => i.sku === 'RN60')!;
    const bad: Array<[string, unknown]> = [
      ['/api/stock/bouquets', { idempotencyKey: 'short', lines: [] }],
      ['/api/stock/bouquets', { idempotencyKey: k(), lines: [{ itemId: rn.id, qty: 1.5 }] }],
      ['/api/stock/bouquets', { idempotencyKey: k(), lines: [{ itemId: rn.id, qty: 1e20 }] }],
      ['/api/stock/bouquets', { idempotencyKey: k(), lines: [{ itemId: rn.id, qty: 1 }, { itemId: rn.id, qty: 1 }] }],
      ['/api/stock/bouquets', { idempotencyKey: k(), lines: [{ itemId: "'; DROP TABLE stock_moves; --", qty: 1 }] }],
      ['/api/stock/receipts', { idempotencyKey: k(), currency: 'UZS', priceMode: 'lines', lines: [{ itemId: rn.id, qty: -1, price: 1 }] }],
      ['/api/stock/receipts', { idempotencyKey: k(), currency: 'USD', priceMode: 'lines', lines: [{ itemId: rn.id, qty: 1, price: 1 }] }],
      ['/api/stock/receipts', { idempotencyKey: k(), currency: 'UZS', priceMode: 'lines', lines: [{ itemId: rn.id, qty: 1, price: 1.5 }] }],
      ['/api/stock/receipts', { idempotencyKey: k(), currency: 'UZS', priceMode: 'total', total: 1, lines: [{ itemId: rn.id, qty: 1, price: 5, per: 'unit' }] }],
      ['/api/stock/receipts', { idempotencyKey: k(), currency: 'UZS', priceMode: 'lines', docDate: '2026-02-30', lines: [{ itemId: rn.id, qty: 1, price: 1 }] }],
      ['/api/stock/writeoffs', { idempotencyKey: k(), lines: [{ itemId: rn.id, qty: 1, reason: 'stolen' }] }],
      ['/api/stock/writeoffs', { idempotencyKey: k(), lines: [{ itemId: rn.id, qty: 1, reason: 'wilt', lotId: 'nope' }] }],
      ['/api/stock/sales', { idempotencyKey: k(), bouquets: [{ id: 'nope' }] }],
      ['/api/stock/sales', { idempotencyKey: k(), bouquets: [] }],
    ];
    for (const [path, body] of bad) {
      const r = await call(path, { user: OWNER, body });
      expect([400, 404, 409, 422], `${path} ${JSON.stringify(body).slice(0, 80)} → ${r.status}`).toContain(r.status);
      const e = await json(r);
      expect(e.error.message).toMatch(/[А-Яа-яЁё]/);
    }
    expect(await ledgerInvariants()).toEqual([]);
  });
});
