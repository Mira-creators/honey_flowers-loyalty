import type { PurchaseResultDTO } from '@honey/contracts';
import { applyPurchase, balanceFromLedger, emptyOutcome, registerClient } from '@honey/core';
import { ConcurrencyError, LoyaltyService, NullNotifier } from '@honey/service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1Repository } from '../src/db/d1Repository.js';
import { buy, call, json, key, makeStaff, mockTelegram, register, repo, resetDb, T, testEnv } from './helpers.js';

const FLORIST = T + 1001;
const CLIENT = T + 5001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

async function ledgerConsistency(clientId: string) {
  const r = repo();
  const { state, version } = await r.loadClientState(clientId);
  const sum = await testEnv.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM points_ledger WHERE client_id = ?').bind(clientId).first<{ s: number }>();
  const versions = await testEnv.DB.prepare('SELECT version FROM client_versions WHERE client_id = ? ORDER BY version').bind(clientId).all<{ version: number }>();
  return { state, version, sum: sum!.s, versions: versions.results.map((v) => v.version) };
}

describe('optimistic concurrency (client_versions)', () => {
  it('saveOutcome with a stale version fails and writes nothing (whole batch rolled back)', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const r = new D1Repository(testEnv.DB);
    const { rules } = await r.getActiveRules();
    const loaded = await r.loadClientState(clientId);
    const now = new Date();
    const mk = (k: string) =>
      applyPurchase(rules, loaded.state, { purchaseId: crypto.randomUUID(), idempotencyKey: k, staffId: null, lines: [{ category: 'flowers', amount: 300_000 }], channel: 'store' }, now);

    await r.saveOutcome(clientId, mk('writer-a-0001'), loaded.version);
    await expect(r.saveOutcome(clientId, mk('writer-b-0001'), loaded.version)).rejects.toBeInstanceOf(ConcurrencyError);

    const after = await ledgerConsistency(clientId);
    expect(after.state.purchases.map((p) => p.idempotencyKey)).toEqual(['writer-a-0001']);
    expect(after.sum).toBe(3_000);
    expect(after.state.cardMoves).toHaveLength(1);
    expect(after.version).toBe(loaded.version + 1);
  });

  it('a stale writer is retried by the service on fresh state: no double spend', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    await buy(FLORIST, clientId, 2_000_000); // balance 20 000
    const r = new D1Repository(testEnv.DB);

    // Simulate a concurrent writer: between this command's load and save, another
    // request spends the whole balance.
    let interfered = false;
    const realLoad = r.loadClientState.bind(r);
    r.loadClientState = async (id: string) => {
      const res = await realLoad(id);
      if (!interfered) {
        interfered = true;
        const svc = new LoyaltyService(new D1Repository(testEnv.DB), new NullNotifier(), () => new Date());
        await svc.execute(id, ({ rules, state, now }) =>
          applyPurchase(rules, state, { purchaseId: crypto.randomUUID(), idempotencyKey: 'other-req-1', staffId: null, lines: [{ category: 'flowers', amount: 40_000 }], channel: 'store', redeemPoints: 20_000 }, now),
        );
      }
      return res;
    };
    const attempts: number[] = [];
    const svc = new LoyaltyService(r, new NullNotifier(), () => new Date());
    await expect(
      svc.execute(clientId, ({ rules, state, now }) => {
        attempts.push(balanceFromLedger(state.ledger));
        return applyPurchase(rules, state, { purchaseId: crypto.randomUUID(), idempotencyKey: 'this-req-1', staffId: null, lines: [{ category: 'flowers', amount: 40_000 }], channel: 'store', redeemPoints: 20_000 }, now);
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    // First attempt saw 20 000 (stale); the retry saw the real balance: 20 000 spent,
    // + 3% (level "honey" after 2 000 000) of the 20 000 paid in money = 600.
    expect(attempts).toEqual([20_000, 600]);
    const after = await ledgerConsistency(clientId);
    expect(after.sum).toBe(balanceFromLedger(after.state.ledger));
    expect(after.sum).toBeGreaterThanOrEqual(0);
    expect(after.state.purchases.map((p) => p.idempotencyKey)).toEqual([expect.any(String), 'other-req-1']);
  });

  it('gives up after 3 retries with ConcurrencyError (→ 409 for HTTP)', async () => {
    const me = await register(CLIENT);
    const r = new D1Repository(testEnv.DB);
    r.saveOutcome = async () => {
      throw new ConcurrencyError();
    };
    const svc = new LoyaltyService(r, new NullNotifier(), () => new Date(), { maxRetries: 3, retryDelayMs: 0 });
    let runs = 0;
    await expect(
      svc.execute(me.client!.id, ({ rules, state, now }) => {
        runs++;
        return registerClient({ ...rules, welcomeBonus: 1 }, { ...state, ledger: [] }, now);
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    expect(runs).toBe(4);
    // An outcome without effects never touches the DB.
    expect((await svc.execute(me.client!.id, () => emptyOutcome())).outcome.replayed).toBe(false);
  });

  it('parallel purchases with full redeem on one client: ledger consistent, never negative, no double spend', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    await buy(FLORIST, clientId, 1_000_000); // balance 10 000

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('/api/staff/purchase', { user: FLORIST, body: { clientId, amount: 100_000, redeem: true, idempotencyKey: key() } }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok.length + conflicts.length).toBe(5);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const bodies = await Promise.all(ok.map((r) => json<PurchaseResultDTO>(r)));
    const totalRedeemed = bodies.reduce((s, b) => s + b.preview.redeemed, 0);
    // Only 10 000 existed (+ tiny cashback from the parallel purchases themselves).
    const after = await ledgerConsistency(clientId);
    const accrued = after.state.ledger.filter((e) => e.type === 'accrual').reduce((s, e) => s + e.amount, 0);
    expect(totalRedeemed).toBeLessThanOrEqual(accrued);
    expect(after.sum).toBe(accrued - totalRedeemed);
    expect(after.sum).toBeGreaterThanOrEqual(0);
    expect(after.state.purchases).toHaveLength(1 + ok.length);
    // Versions are a gapless sequence 1..N.
    expect(after.versions).toEqual(Array.from({ length: after.version }, (_, i) => i + 1));
  });

  it('two different purchases sent in parallel both succeed (one retries)', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const [a, b] = await Promise.all([
      call('/api/staff/purchase', { user: FLORIST, body: { clientId, amount: 300_000, redeem: false, idempotencyKey: key() } }),
      call('/api/staff/purchase', { user: FLORIST, body: { clientId, amount: 500_000, redeem: false, idempotencyKey: key() } }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const after = await ledgerConsistency(clientId);
    expect(after.state.purchases).toHaveLength(2);
    expect(after.sum).toBe(8_000);
    // Only one card move per day.
    expect(after.state.cardMoves).toHaveLength(1);
  });
});
