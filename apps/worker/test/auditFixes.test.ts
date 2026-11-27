/**
 * Regressions of the 27.11 code audit (docs/qa/Ошибки.md, CODE-*): each test failed before the fix.
 */
import type { AssembleResultDTO, StockSaleResultDTO, WriteoffResultDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockTelegram, register } from './helpers.js';
import { bouquet, call, catalog, CLIENT, FLORIST, FLORIST2, item, json, k, ledgerInvariants, OWNER, receive, stockSetup, testEnv } from './stockHelpers.js';

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => { tg = mockTelegram(); await stockSetup(); });
afterEach(() => tg.restore());

const sell = (id: string, extra: Record<string, unknown> = {}, user = FLORIST) =>
  call('/api/stock/sales', { user, body: { idempotencyKey: k('sale'), bouquets: [{ id }], paymentMethod: 'cash', ...extra } });

describe('audit 27.11', () => {
  it('CODE-1: a sold bouquet never goes back to the showcase (no second sale, no stems back)', async () => {
    await receive([{ sku: 'TLR', qty: 30, price: 7_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 25 }]))).bouquet;
    expect((await sell(b.id)).status).toBe(201);
    const sc = await call(`/api/stock/bouquets/${b.id}/showcase`, { user: FLORIST2, body: {} });
    expect(sc.status).toBe(409);
    expect((await sc.json() as { error: { code: string } }).error.code).toBe('bouquet_state');
    expect((await sell(b.id)).status).toBe(409);
    expect((await call(`/api/stock/bouquets/${b.id}/disassemble`, { user: FLORIST, body: { idempotencyKey: k('dis'), good: [] } })).status).toBe(409);
    expect((await item('TLR')).qty).toBe(5);
    const paid = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM stock_sales WHERE status = 'paid'`).first<{ n: number }>();
    expect(paid!.n).toBe(1);
    // even a direct UPDATE is refused by the transition trigger (migration 0015)
    await expect(testEnv.DB.prepare(`UPDATE stock_bouquets SET status = 'on_showcase' WHERE id = ?`).bind(b.id).run()).rejects.toThrow(/букет уже продан/);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('CODE-1: an assembled bouquet still goes to the showcase, twice is a no-op', async () => {
    await receive([{ sku: 'TLR', qty: 30, price: 7_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 5 }]))).bouquet;
    for (let i = 0; i < 2; i++) {
      const r = await call(`/api/stock/bouquets/${b.id}/showcase`, { user: FLORIST, body: {} });
      expect(r.status).toBe(200);
      expect((await r.json() as { status: string }).status).toBe('on_showcase');
    }
  });

  it('CODE-2: an owner-granted gift (long id) can be used in a stock sale', async () => {
    const me = await register(CLIENT);
    const g = await call(`/api/owner/clients/${me.client!.id}/grant`, { user: OWNER, body: { kind: 'gift', giftId: 'card', reason: 'проверка' }, headers: { 'idempotency-key': crypto.randomUUID() } });
    expect(g.status).toBeLessThan(300);
    const giftId = (await json<{ client: { gifts: Array<{ id: string; status: string }> } }>(call('/api/me', { user: CLIENT }))).client.gifts.find((x) => x.status === 'available')!.id;
    expect(giftId.length).toBeGreaterThan(64);
    await receive([{ sku: 'TLR', qty: 30, price: 7_000 }]);
    const b = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 10 }]))).bouquet;
    const pv = await call('/api/stock/sales/preview', { user: FLORIST, body: { clientId: me.client!.id, giftId, bouquets: [{ id: b.id }] } });
    expect(pv.status).toBe(200);
    const r = await sell(b.id, { clientId: me.client!.id, giftId });
    expect(r.status).toBe(201);
    expect((await json<StockSaleResultDTO>(r)).loyaltyStatus).toBe('done');
  });

  it('CODE-3: a retry with a refreshed expectedCost replays the same assembly, not 409', async () => {
    await receive([{ sku: 'TLR', qty: 30, price: 7_000 }]);
    const id = (await catalog()).items.find((i) => i.sku === 'TLR')!.id;
    const body = { idempotencyKey: k('bq'), kind: 'order', lines: [{ itemId: id, qty: 5 }], expectedCost: 35_000 };
    const r1 = await call('/api/stock/bouquets', { user: FLORIST, body });
    const r2 = await call('/api/stock/bouquets', { user: FLORIST, body: { ...body, expectedCost: 36_000 } });
    expect(r1.status).toBe(201);
    expect([200, 201]).toContain(r2.status);
    expect((await json<AssembleResultDTO>(r2)).bouquet.id).toBe((await json<AssembleResultDTO>(r1)).bouquet.id);
    expect((await item('TLR')).qty).toBe(25);
  });

  it('CODE-4: cancelling a settled «в минус» assembly explains to disassemble instead (no false «повторите»)', async () => {
    await receive([{ sku: 'LR40', qty: 2, price: 6_000 }]);
    const r = await bouquet([{ sku: 'LR40', qty: 5 }], { allowShort: true, shortComment: 'приход позже' });
    expect(r.status).toBe(201);
    const b = (await json<AssembleResultDTO>(r)).bouquet;
    await receive([{ sku: 'LR40', qty: 10, price: 6_000 }]);
    const c = await call(`/api/stock/bouquets/${b.id}/cancel`, { user: FLORIST, body: {} });
    expect(c.status).toBe(409);
    expect((await c.json() as { error: { message: string } }).error.message).toMatch(/Разберите букет/);
    const d = await call(`/api/stock/bouquets/${b.id}/disassemble`, { user: FLORIST, body: { idempotencyKey: k('dis'), good: [] } });
    expect(d.status).toBe(201);
    expect(await ledgerInvariants()).toEqual([]);
  });

  it('CODE-7: the honey amount shown in the preview is what the sale takes; less available → failed with a reason', async () => {
    const me = await register(CLIENT);
    const adj = await call(`/api/owner/clients/${me.client!.id}/adjust`, { user: OWNER, body: { points: 20_000, reason: 'Компенсация', idempotencyKey: k('adj') } });
    expect(adj.status).toBeLessThan(300);
    await receive([{ sku: 'TLR', qty: 30, price: 7_000 }]);
    const b1 = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 5 }]))).bouquet;
    const s1 = await json<StockSaleResultDTO>(sell(b1.id, { clientId: me.client!.id, redeem: true, redeemPoints: 1_000, bouquets: [{ id: b1.id, price: 100_000 }] }));
    expect(s1.loyaltyError).toBeNull();
    expect(s1.loyaltyStatus).toBe('done');
    expect(s1.honeyRedeemed).toBe(1_000);
    const b2 = (await json<AssembleResultDTO>(await bouquet([{ sku: 'TLR', qty: 5 }]))).bouquet;
    const s2 = await json<StockSaleResultDTO>(sell(b2.id, { clientId: me.client!.id, redeem: true, redeemPoints: 10_000_000, bouquets: [{ id: b2.id, price: 100_000 }] }));
    expect(s2.loyaltyStatus).toBe('failed');
    expect(s2.loyaltyError).toMatch(/Мёда сейчас меньше/);
    // «без оплаты мёдом» finishes it
    const s3 = await json<StockSaleResultDTO>(call(`/api/stock/sales/${s2.saleId}/loyalty`, { user: FLORIST, body: { withoutRedeem: true } }));
    expect(s3.loyaltyStatus).toBe('done');
    expect(s3.honeyRedeemed).toBe(0);
  });

  it('CODE-10: splitting a big write-off into small documents still needs the owner (daily total per florist)', async () => {
    await receive([{ sku: 'TLR', qty: 100, price: 7_000 }]);
    const id = (await catalog()).items.find((i) => i.sku === 'TLR')!.id;
    const wo = async (qty: number, user = FLORIST) =>
      json<WriteoffResultDTO>(call('/api/stock/writeoffs', { user, body: { idempotencyKey: k('wo'), lines: [{ itemId: id, qty, reason: 'wilt' }] } }));
    const a = await wo(20); // 140 000
    const b = await wo(20); // 280 000 in total today → needs approval
    const c = await wo(1, FLORIST2); // another florist's day starts from zero
    const st = async (docId: string) => (await testEnv.DB.prepare('SELECT approval FROM stock_docs WHERE id = ?').bind(docId).first<{ approval: string }>())!.approval;
    expect(await st(a.docId)).toBe('none');
    expect(await st(b.docId)).toBe('pending');
    expect(await st(c.docId)).toBe('none');
  });

  it('CODE-11: the catalog reports what can be picked without going «в минус»', async () => {
    await receive([{ sku: 'LR40', qty: 2, price: 6_000 }]);
    expect((await bouquet([{ sku: 'LR40', qty: 5 }], { allowShort: true, shortComment: 'приход позже' })).status).toBe(201);
    const it1 = (await catalog()).items.find((i) => i.sku === 'LR40')!;
    expect(it1.qty).toBe(-3);
    expect(it1.available).toBe(0);
    await receive([{ sku: 'LR40', qty: 10, price: 6_000 }]);
    const it2 = (await catalog()).items.find((i) => i.sku === 'LR40')!;
    expect(it2.available).toBe(it2.qty);
  });
});
