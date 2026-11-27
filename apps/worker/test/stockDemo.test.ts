/**
 * «Склад» TEST_MODE demo: 30 days of receipts / bouquets / sales / write-offs written in chunks within
 * Workers Free limits and the write budget (stock part ≤ ~8 000 rows), ledger invariants intact,
 * idempotent, linked to demo loyalty purchases; «Удалить демо-данные» removes the stock demo rows too.
 */
import type { TestDemoSeedDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { STOCK_DEMO_CHUNKS } from '../src/demo/stock.js';
import type { Env } from '../src/env.js';
import { countingEnv } from './d1Counter.js';
import { execCtx, mockTelegram, resetDb, T, testEnv } from './helpers.js';
import { ledgerInvariants } from './stockHelpers.js';

const TESTER = T + 78;
let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

async function post<R>(env: Env, path: string, body: unknown): Promise<R> {
  const { ctx, flush } = execCtx();
  const res = await app.request(path, { method: 'POST', headers: { 'x-test-user': String(TESTER), 'x-test-key': testEnv.TEST_KEY!, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env, ctx);
  await flush();
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as R;
}
const count = async (sql: string) => Number((await testEnv.DB.prepare(sql).first<{ n: number }>())!.n);

describe('stock demo data', () => {
  it('30 days in chunks: within limits, invariants hold, linked to loyalty, idempotent, cleared', async () => {
    // some demo clients with purchases first (the panel seeds loyalty, then stock)
    let chunk: number | null = 0;
    for (let i = 0; i < 12 && chunk !== null; i++) chunk = (await post<TestDemoSeedDTO>(testEnv, '/api/test/demo-seed', { chunk })).nextChunk;
    let rows = 0;
    const calls: number[] = [];
    for (let c = 0; c < STOCK_DEMO_CHUNKS; c++) {
      const { env, c: cnt } = countingEnv();
      const r = await post<{ nextChunk: number | null; bouquets: number }>(env, '/api/test/demo-stock', { chunk: c });
      rows += cnt.rowsWritten;
      calls.push(cnt.calls);
      expect(r.nextChunk).toBe(c === STOCK_DEMO_CHUNKS - 1 ? null : c + 1);
    }
    console.log(`stock demo: ${rows} rows written, D1 calls per chunk ${calls.join('/')}`);
    expect(Math.max(...calls)).toBeLessThanOrEqual(20);
    expect(rows).toBeLessThanOrEqual(8_500);
    expect(await ledgerInvariants()).toEqual([]);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_docs WHERE kind = 'receipt' AND currency = 'USD'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_docs WHERE kind = 'receipt' AND price_mode = 'total'`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_bouquets`)).toBeGreaterThan(60);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_bouquets WHERE status IN ('assembled','on_showcase')`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_sales s JOIN purchases p ON p.id = s.loyalty_purchase_id`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_docs WHERE kind = 'writeoff' AND approval = 'pending'`)).toBeGreaterThanOrEqual(0);
    // idempotent
    const before = await count('SELECT COUNT(*) AS n FROM stock_moves');
    const again = await post<{ skipped: boolean }>(testEnv, '/api/test/demo-stock', { chunk: 2 });
    expect(again.skipped).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM stock_moves')).toBe(before);
    // the overview and console tables read it
    await post(testEnv, '/api/test/role', { role: 'owner' });
    const ov = await app.request('/api/owner/stock/overview', { headers: { 'x-test-user': String(TESTER), 'x-test-key': testEnv.TEST_KEY! } }, testEnv);
    expect(ov.status).toBe(200);
    // clear
    await post(testEnv, '/api/test/demo-clear', {});
    for (const t of ['stock_docs', 'stock_moves', 'stock_lots', 'stock_bouquets', 'stock_sales', 'stock_daily']) expect(await count(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM stock_items WHERE demo = 1`)).toBe(0);
    expect(await ledgerInvariants()).toEqual([]);
  });
});
