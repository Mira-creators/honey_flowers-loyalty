import type { MeDTO, OwnerClientDTO, OwnerHistoryPageDTO, PurchaseResultDTO } from '@honey/contracts';
import { applyOutcome, applyPurchase, emptyClientState, registerClient, type ClientState } from '@honey/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { clientSummary } from '../src/lib/dto.js';
import { computeClientStats } from '../src/lib/clientStats.js';
import { refreshStats } from './consoleHelpers.js';
import { countingEnv } from './d1Counter.js';
import { execCtx, json, key, makeStaff, mockTelegram, register, repo, resetDb, T, TEST_KEY, testEnv } from './helpers.js';

/**
 * Item 5: a client with ~1 000 purchases must cost the same as a client with 10 on /me, a purchase,
 * a reversal and the owner's client card (bounded load, db/stateLoader.ts; history from SQL).
 * Before: ~3 800 rows read and 140–250 ms for the heavy client.
 */

const OWNER = T + 1;
const FLORIST = T + 2;
const HEAVY = T + 100;
const LIGHT = T + 101;
const MID = T + 102;
const DAY = 86_400_000;

/** Write `n` purchases (one per day, ending yesterday) through the real engine, as rows. */
async function history(clientId: string, n: number) {
  const r = repo();
  const { rules } = await r.getActiveRules();
  const client = (await r.findClientById(clientId))!;
  let s: ClientState = emptyClientState(clientId, new Date(Date.now() - (n + 2) * DAY));
  s = applyOutcome(s, registerClient(rules, s, s.registeredAt));
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - (n - i) * DAY);
    s = applyOutcome(s, applyPurchase(rules, s, { purchaseId: `${clientId}-p${i}`, idempotencyKey: `${clientId}-k${i}`, staffId: null, lines: [{ category: 'flowers', amount: 120_000 + (i % 7) * 10_000 }], channel: 'store', redeemPoints: 0, useRewardId: null }, at));
  }
  const stmts: D1PreparedStatement[] = [];
  for (const p of s.purchases) stmts.push(r.purchaseUpsertStmt(clientId, p));
  for (const e of s.ledger) stmts.push(r.ledgerInsertStmt(clientId, e));
  for (const m of s.cardMoves) stmts.push(r.cardMoveInsertStmt(clientId, m));
  for (const g of s.rewards) stmts.push(r.rewardInsertStmt(clientId, g));
  for (let k = 0; k < stmts.length; k += 400) await testEnv.DB.batch(stmts.slice(k, k + 400));
  await testEnv.DB.prepare('UPDATE clients SET created_at = ? WHERE id = ?').bind(s.registeredAt.toISOString(), client.id).run();
  await refreshStats();
  return s;
}

async function measured(path: string, user: number, init: { method?: string; body?: unknown } = {}) {
  const { env, c } = countingEnv();
  const { ctx, flush } = execCtx();
  const headers: Record<string, string> = { 'x-test-user': String(user), 'x-test-key': TEST_KEY };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const t0 = Date.now();
  const res = await app.request(path, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env, ctx);
  await flush();
  const ms = Date.now() - t0;
  expect(res.status, `${path} ${res.status}`).toBeLessThan(300);
  return { body: await res.json(), rowsRead: c.rowsRead, calls: c.calls, ms };
}

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

describe('heavy client: cost independent of the history length', () => {
  it('1 000 purchases cost ≈ the same rows as 10 on /me, purchase, reversal and the owner card; results are exact', async () => {
    const heavy = (await register(HEAVY)).client!;
    const light = (await register(LIGHT)).client!;
    const mid = (await register(MID)).client!;
    const full = await history(heavy.id, 1000);
    await history(light.id, 10);
    await history(mid.id, 100);

    const rows: Record<string, [number, number, number]> = {};
    const both = async (label: string, f: (who: { user: number; id: string }) => Promise<{ rowsRead: number; ms: number }>) => {
      const h = await f({ user: HEAVY, id: heavy.id });
      const m = await f({ user: MID, id: mid.id });
      const l = await f({ user: LIGHT, id: light.id });
      rows[label] = [l.rowsRead, m.rowsRead, h.rowsRead];
      // Independent of the history length: 1 000 purchases read what 100 read (every source is capped).
      expect(h.rowsRead, `${label}: 1000 → ${h.rowsRead}, 100 → ${m.rowsRead}`).toBeLessThanOrEqual(Math.ceil(m.rowsRead * 1.1) + 10);
      // vs 10 purchases the difference is the fuller pages (50 history items, 20 gifts, the card tail): a constant
      expect(h.rowsRead, `${label}: 1000 → ${h.rowsRead}, 10 → ${l.rowsRead}`).toBeLessThan(l.rowsRead + 300);
      expect(h.rowsRead, label).toBeLessThan(600);
    };

    // /me: exact values (balance, level, card) as computed from the FULL history
    const me = await measured('/api/me', HEAVY);
    const { rules } = await repo().getActiveRules();
    const want = clientSummary(rules, (await repo().findClientById(heavy.id))!, full, new Date((me.body as MeDTO).now), []);
    const got = (me.body as MeDTO).client!;
    expect({ ...got, history: [], gifts: [] }).toEqual({ ...want, history: [], gifts: [], name: got.name, phoneMasked: got.phoneMasked, code: got.code });
    expect(got.history).toHaveLength(50);
    expect(got.history[0]!.purchaseId).toBe(`${heavy.id}-p999`);
    await both('/api/me', ({ user }) => measured('/api/me', user));

    // owner card + the next history page
    await both('/api/owner/clients/:id', ({ id }) => measured(`/api/owner/clients/${id}`, OWNER));
    const card = (await measured(`/api/owner/clients/${heavy.id}`, OWNER)).body as OwnerClientDTO;
    expect(card.history).toHaveLength(50);
    expect(card.historyNext).toBeTruthy();
    const page2 = await measured(`/api/owner/clients/${heavy.id}/history?cursor=${card.historyNext}`, OWNER);
    const p2 = page2.body as OwnerHistoryPageDTO;
    expect(p2.items).toHaveLength(50);
    expect(p2.items[0]!.purchaseId).toBe(`${heavy.id}-p949`);
    expect(page2.rowsRead).toBeLessThan(600);

    // a purchase (with мёд) and its reversal
    const made = new Map<string, PurchaseResultDTO>();
    await both('POST /api/staff/purchase', async ({ id }) => {
      const r = await measured('/api/staff/purchase', FLORIST, { body: { clientId: id, amount: 300_000, redeem: true, idempotencyKey: key() } });
      made.set(id, r.body as PurchaseResultDTO);
      return r;
    });
    const last = made.get(heavy.id)!;
    await both('POST /api/staff/purchase/:id/reverse', ({ id }) => measured(`/api/staff/purchase/${made.get(id)!.purchaseId}/reverse`, FLORIST, { body: { reason: 'ошибка кассы' } }));
    const stats = await repo().loadClientState(heavy.id); // full
    expect(last.client.balance).toBeGreaterThanOrEqual(0);
    const stored = await testEnv.DB.prepare('SELECT * FROM client_stats WHERE client_id = ?').bind(heavy.id).first<Record<string, unknown>>();
    const exact = computeClientStats(rules, stats.state, new Date());
    expect([Number(stored!.balance), Number(stored!.purchases_count), Number(stored!.level_sum), Number(stored!.level_count)]).toEqual([exact.balance, exact.purchasesCount, exact.levelSum, exact.levelCount]);
    console.log(`heavy client rows read [light, heavy]: ${JSON.stringify(rows)}; /me ${me.ms} ms`);
  }, 120_000);
});
