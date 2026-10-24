import type { ConsoleOverviewDTO, OwnerStatsDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerStats } from '../src/bot/bot.js';
import { createContext } from '../src/context.js';
import { runDailyJob } from '../src/cron.js';
import { buy, call, json, makeStaff, mockTelegram, moveClock, register, repo, resetDb, T, testEnv } from './helpers.js';

/**
 * Item 4: daily aggregates (stats_daily, migration 0007). The incremental maintenance in every write
 * path must equal a rebuild from the raw rows, whatever happened; readers use only day rows.
 */

const OWNER = T + 1;
const FLORIST = T + 2;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

async function table() {
  const { results } = await testEnv.DB.prepare('SELECT * FROM stats_daily ORDER BY day').all<Record<string, number | string>>();
  // Rows that sum to zero carry no information (a −before / +after pair leaves them behind).
  return results.filter((r) => Object.entries(r).some(([k, v]) => k !== 'day' && Number(v) !== 0));
}

/** Incremental table == rebuilt-from-raw table. */
async function expectConsistent(label: string) {
  const incremental = await table();
  await repo().rebuildDailyStats();
  expect(incremental, label).toEqual(await table());
}

describe('stats_daily is maintained incrementally and exactly', () => {
  it('purchases, redemption, gifts, reversals, adjustments, grants, expiry, reset-me', async () => {
    const a = (await register(T + 10)).client!;
    const b = (await register(T + 11)).client!;
    await expectConsistent('registration');
    // three purchases of a → gift on cell 3; b buys twice on one day (first + repeat on the same day)
    const p1 = await buy(FLORIST, a.id, 150_000);
    await moveClock(1);
    await buy(FLORIST, a.id, 200_000);
    await moveClock(1);
    const p3 = await buy(FLORIST, a.id, 300_000);
    const b1 = await buy(FLORIST, b.id, 120_000);
    await buy(FLORIST, b.id, 130_000);
    await expectConsistent('purchases');
    // pay with мёд + hand out the gift
    await buy(FLORIST, a.id, 400_000, { redeem: true });
    const gift = p3.giftsUnlocked[0]!;
    expect((await call(`/api/staff/gift/${gift.id}/use`, { user: FLORIST, body: {} })).status).toBe(200);
    await expectConsistent('redeem + gift used');
    // reversal of b's first purchase (its successor stops being a "first" purchase); a's first one is
    // older than the 24 h reversal window (item 8): refused, nothing changes
    expect((await call(`/api/staff/purchase/${b1.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка' } })).status).toBe(200);
    expect((await call(`/api/staff/purchase/${p1.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка' } })).status).toBe(409);
    await expectConsistent('reverse first purchase');
    // owner adjustments and grants
    expect((await call(`/api/owner/clients/${b.id}/adjust`, { user: OWNER, body: { points: -500, reason: 'исправление' } })).status).toBe(200);
    expect((await call(`/api/owner/clients/${b.id}/grant`, { user: OWNER, body: { kind: 'honey', points: 5000, reason: 'день рождения', idempotencyKey: 'grant-0001' } })).status).toBe(201);
    expect((await call(`/api/owner/clients/${b.id}/grant`, { user: OWNER, body: { kind: 'gift', giftId: 'card', reason: 'извинение', idempotencyKey: 'grant-0002' } })).status).toBe(201);
    await expectConsistent('adjust + grants');
    // expiry by the nightly job
    await moveClock(95);
    const ctx = await createContext(testEnv);
    await runDailyJob(ctx, 50);
    await expectConsistent('expiry');
    // reset-me deletes a client with everything
    expect((await call('/api/test/reset-me', { user: T + 11, body: {} })).status).toBe(200);
    await expectConsistent('reset-me');
  });

  it('import (starting мёд is not "issued", imported clients are not "new") and its undo', async () => {
    await register(T + 20);
    const body = {
      batchId: 'batch-stats-1', dryRun: false, options: { creditBalance: true, levelFromTotal: false, cellsFromCount: true },
      rows: [{ line: 2, phone: '+998905550001', name: 'Нигора', balance: 30_000, count: 4 }, { line: 3, phone: '+998905550002', name: 'Азиз', balance: 0 }],
    };
    expect((await call('/api/owner/import', { user: OWNER, body })).status).toBe(201);
    await expectConsistent('import');
    const stats = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(stats.clients).toBe(3);
    expect(stats.clientsNew7d).toBe(1);
    expect(stats.points.accrued).toBe(0);
    expect(stats.points.outstanding).toBe(30_000);
    expect((await call('/api/owner/import/batch-stats-1/undo', { user: OWNER, body: {} })).status).toBe(200);
    await expectConsistent('import undo');
    expect((await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }))).clients).toBe(1);
  });

  it('demo seed and clear keep the aggregates exact (demo counts as real)', async () => {
    await register(T + 30);
    for (const chunk of [0, 1]) expect((await call('/api/test/demo-seed', { user: OWNER, body: { chunk } })).status).toBe(200);
    await expectConsistent('demo seed');
    const stats = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(stats.clients).toBe(11);
    expect(stats.purchases).toBeGreaterThan(10);
    expect((await call('/api/test/demo-clear', { user: OWNER, body: {} })).status).toBe(200);
    await expectConsistent('demo clear');
    expect((await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }))).purchases).toBe(0);
  });
});

describe('readers use the day rows', () => {
  it('/api/owner/stats, bot /stats and the console overview agree with the raw rows', async () => {
    const a = (await register(T + 40)).client!;
    const b = (await register(T + 41)).client!;
    await buy(FLORIST, a.id, 200_000);
    await buy(FLORIST, a.id, 300_000);
    const rev = await buy(FLORIST, b.id, 500_000);
    expect((await call(`/api/staff/purchase/${rev.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка' } })).status).toBe(200);
    await buy(FLORIST, b.id, 100_000);

    const res = await call('/api/owner/stats', { user: OWNER });
    const stats = await json<OwnerStatsDTO>(res);
    expect(stats).toMatchObject({ clients: 2, clientsNew7d: 2, purchases: 3, purchases7d: 3, revenueWithCard: 600_000, giftsUnlocked: 0 });
    expect(stats.repeatRate90d).toBe(0.5); // a bought twice, b once (the reversed purchase does not count)
    expect(stats.points.accrued).toBe(6000); // 1 % of 600 000; the reversed cashback nets out
    expect(stats.perWeek.reduce((s, w) => s + w.purchases, 0)).toBe(3);

    const text = await ownerStats(await createContext(testEnv));
    expect(text).toMatch(/3/);

    const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
    const ov = await json<ConsoleOverviewDTO>(call(`/api/owner/console/overview?from=${today}&to=${today}`, { user: OWNER }));
    expect(ov.current).toMatchObject({ purchases: 3, revenue: 600_000, activeClients: 2, newClients: 2, repeatPurchases: 1, honeyAccrued: 6000 });
    expect(ov.series).toEqual([{ bucket: today, purchases: 3, revenue: 600_000, buyers: 2 }]);
  });
});
