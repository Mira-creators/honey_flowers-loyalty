import { describe, expect, it } from 'vitest';
import { LoyaltyError, maxRedeemable } from '../src/index.js';
import { at, flowers, makeRules, plusDays, Sim } from './helpers.js';

const d0 = at('2026-11-01 10:00');
const d1 = at('2026-11-02 10:00');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoyaltyError) return e.code;
    throw e;
  }
  return undefined;
}

describe('redemption of мёд', () => {
  it('allows redeeming up to maxRedeemPct (50%) of the order', () => {
    const sim = new Sim();
    sim.seedPoints(200_000, d0);
    sim.buy(200_000, d1, { redeemPoints: 100_000 });
    expect(sim.state.ledger.at(-2)).toMatchObject({ type: 'redeem', amount: -100_000 });
  });

  it('rejects redeeming 1 сум over the cap', () => {
    const sim = new Sim();
    sim.seedPoints(200_000, d0);
    expect(code(() => sim.buy(200_000, d1, { redeemPoints: 100_001 }))).toBe('REDEEM_CAP_EXCEEDED');
  });

  it('cap floors odd amounts (50% of 99 999 = 49 999)', () => {
    const sim = new Sim();
    sim.seedPoints(100_000, d0);
    expect(maxRedeemable(sim.rules, sim.state, flowers(99_999))).toBe(49_999);
  });

  it('maxRedeemPct 100 lets the client pay the whole order with points', () => {
    const sim = new Sim(makeRules({ maxRedeemPct: 100 }));
    sim.seedPoints(200_000, d0);
    const o = sim.buy(150_000, d1, { redeemPoints: 150_000 });
    expect(o.purchase?.result?.paid).toBe(0);
    expect(o.purchase?.result?.cashback).toBe(0);
  });

  it('rejects redeeming more than the balance', () => {
    const sim = new Sim();
    sim.seedPoints(1_000, d0);
    expect(code(() => sim.buy(200_000, d1, { redeemPoints: 1_001 }))).toBe('INSUFFICIENT_BALANCE');
  });

  it('allowDiscountWithPoints=false forbids points together with the 10% gift', () => {
    const sim = new Sim();
    sim.seedPoints(100_000, d0);
    for (let i = 1; i <= 9; i++) sim.buy(150_000, plusDays(d0, i));
    const gift = sim.gifts('available').find((g) => g.type === 'discount_pct')!;
    expect(code(() => sim.buy(300_000, plusDays(d0, 10), { useRewardId: gift.id, redeemPoints: 1_000 }))).toBe(
      'DISCOUNT_WITH_POINTS_NOT_ALLOWED',
    );
    expect(maxRedeemable(sim.rules, sim.state, flowers(300_000), gift.id)).toBe(0);
  });

  it('allowDiscountWithPoints=true: discount first, points capped, cashback on what is left', () => {
    const sim = new Sim(makeRules({ allowDiscountWithPoints: true }));
    sim.seedPoints(100_000, d0); // 10M → Королева (5%)
    for (let i = 1; i <= 9; i++) sim.buy(150_000, plusDays(d0, i));
    const gift = sim.gifts('available').find((g) => g.type === 'discount_pct')!;
    const o = sim.buy(400_000, plusDays(d0, 10), { useRewardId: gift.id, redeemPoints: 100_000 });
    const r = o.purchase!.result!;
    expect(r.discountApplied).toBe(40_000);
    expect(r.pointsRedeemed).toBe(100_000);
    expect(r.paid).toBe(260_000);
    expect(r.cashback).toBe(13_000); // 5% of 260 000
  });

  it('standalone redeem spends points against an order amount and is idempotent', () => {
    const sim = new Sim();
    sim.seedPoints(50_000, d0);
    sim.redeem({ points: 20_000, orderAmount: 100_000, idempotencyKey: 'x1' }, d1);
    expect(sim.balance).toBe(30_000);
    const again = sim.redeem({ points: 20_000, orderAmount: 100_000, idempotencyKey: 'x1' }, d1);
    expect(again.replayed).toBe(true);
    expect(sim.balance).toBe(30_000);
    expect(code(() => sim.redeem({ points: 50_001, orderAmount: 100_000 }, d1))).toBe('INSUFFICIENT_BALANCE');
  });
});
