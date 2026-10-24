/**
 * Regression tests for the engine audit (findings E1–E15). Each test
 * describes the required behaviour; the original bug is noted in a comment.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  applyPurchase,
  balanceFromLedger,
  cardPosition,
  expiryInfo,
  LoyaltyError,
  manualAdjust,
  maxRedeemable,
  parseRules,
  percentOf,
  registerClient,
  runExpiry,
} from '../src/index.js';
import { validateLines } from '../src/commands/common.js';
import { at, flowers, makeRules, plusDays, Sim } from './helpers.js';

const d0 = at('2026-11-01 12:00');

/**
 * Item 8 (owner decision): a purchase may be reversed only within rules.reversalWindowHours and
 * only while its мёд and gift are unused. The E1/E2/E5 tests below check the reversal MECHANICS
 * (expiry interplay, card cascade) on histories that are older than the window: they run with the
 * window switched off (bypassing the schema's 720 h cap), as for a legacy state.
 */
const noWindow = (r = makeRules()) => ({ ...r, reversalWindowHours: Number.MAX_SAFE_INTEGER });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoyaltyError) return e.code;
    throw e;
  }
  return undefined;
}

describe('E1: reversal and expiry', () => {
  it('points refunded by a reversal after an expiry still expire (anchor moved back → overdue)', () => {
    const sim = new Sim(noWindow());
    sim.buy(1_000_000, d0); // p1: +10 000
    sim.buy(100_000, plusDays(d0, 10), { redeemPoints: 5_000 }); // p2: −5 000, +950
    sim.expiry(plusDays(d0, 100)); // burns 5 950
    expect(sim.balance).toBe(0);
    sim.reverse('p2', plusDays(d0, 101)); // refund 5 000 (the 950 cashback already expired: not clawed back)
    expect(sim.balance).toBe(5_000);
    const o = sim.expiry(plusDays(d0, 102)); // anchor is day 0: overdue → burns
    expect(o.ledger).toEqual([expect.objectContaining({ type: 'expire', amount: -5_000 })]);
    expect(sim.balance).toBe(0);
    expect(sim.expiry(plusDays(d0, 500)).ledger).toHaveLength(0);
  });

  it('a purchase after the refund settles the overdue refund first', () => {
    const sim = new Sim(noWindow());
    sim.buy(1_000_000, d0);
    sim.buy(100_000, plusDays(d0, 10), { redeemPoints: 5_000 });
    sim.expiry(plusDays(d0, 100));
    sim.reverse('p2', plusDays(d0, 101));
    const o = sim.buy(100_000, plusDays(d0, 102));
    expect(o.ledger.map((e) => e.type)).toEqual(['expire', 'accrual']);
    expect(sim.balance).toBe(1_000);
  });

  it('reversing a purchase whose cashback already expired does not debit it again', () => {
    const sim = new Sim(noWindow());
    sim.buy(1_000_000, d0); // +10 000
    sim.expiry(plusDays(d0, 90)); // −10 000
    const o = sim.reverse('p1', plusDays(d0, 91));
    expect(o.ledger).toHaveLength(0);
    expect(sim.balance).toBe(0);
    expect(o.warnings.join('\n')).toMatch(/already expired/);
    expect(o.warnings.join('\n')).not.toMatch(/negative/);
  });

  it('reversal after expiry still refunds redeemed points (they were paid with real value)', () => {
    const sim = new Sim(noWindow());
    sim.buy(1_000_000, d0); // +10 000
    sim.buy(200_000, plusDays(d0, 1), { redeemPoints: 10_000 }); // −10 000, +1 900
    sim.expiry(plusDays(d0, 91)); // −1 900
    const o = sim.reverse('p2', plusDays(d0, 92));
    expect(o.ledger).toEqual([expect.objectContaining({ type: 'reversal', amount: 10_000 })]);
    expect(sim.balance).toBe(10_000);
  });
});

describe('E2: a gift cannot come back through a reversal', () => {
  it('item 8: the purchase whose gift was already used cannot be reversed (no "gift earned twice")', () => {
    const sim = new Sim(noWindow());
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i)); // p3 → cell 3 gift
    const g = sim.gifts('available')[0]!;
    sim.buy(50_000, plusDays(d0, 3), { useRewardId: g.id }); // p4 uses it
    expect(code(() => sim.reverse('p3', plusDays(d0, 3)))).toBe('REVERSAL_GIFT_USED');
    expect(sim.card.filled).toBe(3);
    expect(sim.state.rewards.find((r) => r.id === g.id)?.status).toBe('used');
    // reversing the purchase that USED the gift is fine and returns it
    sim.reverse('p4', plusDays(d0, 3));
    expect(sim.state.rewards.find((r) => r.id === g.id)?.status).toBe('available');
  });

  it('a gift used in a purchase does not come back after reset_all burned the card', () => {
    const sim = new Sim(noWindow(makeRules({ expiry: { onExpiry: 'reset_all' } })));
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i));
    const g = sim.gifts('available')[0]!;
    sim.buy(50_000, plusDays(d0, 3), { useRewardId: g.id }); // p4
    sim.expiry(plusDays(d0, 3 + 90)); // reset_all
    sim.reverse('p4', plusDays(d0, 3 + 91));
    expect(sim.state.rewards.find((r) => r.id === g.id)?.status).toBe('revoked');
  });

  it('the normal case still returns the gift', () => {
    const sim = new Sim();
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i));
    const g = sim.gifts('available')[0]!;
    sim.buy(50_000, plusDays(d0, 3), { useRewardId: g.id });
    sim.reverse('p4', plusDays(d0, 3));
    expect(sim.state.rewards.find((r) => r.id === g.id)?.status).toBe('available');
  });
});

describe('E3: welcome bonus timing', () => {
  it('a welcome bonus credited long after registration expires 90 days after the credit, not at once', () => {
    const reg = at('2026-07-01 10:00');
    const rules = makeRules({ welcomeBonus: 20_000 });
    const sim = new Sim(rules, reg);
    const now = plusDays(reg, 120);
    sim.register(now);
    expect(expiryInfo(rules, sim.state, now).daysLeft).toBe(90);
    sim.expiry(now);
    expect(sim.balance).toBe(20_000);
    sim.expiry(plusDays(now, 90));
    expect(sim.balance).toBe(0);
  });

  it('a welcome bonus credited after an earlier expiry still expires', () => {
    const reg = at('2026-07-01 10:00');
    const sim = new Sim(makeRules(), reg);
    sim.buy(100_000, reg);
    sim.expiry(plusDays(reg, 90));
    sim.rules = makeRules({ welcomeBonus: 20_000 });
    sim.register(plusDays(reg, 100));
    sim.expiry(plusDays(reg, 300));
    expect(sim.balance).toBe(0);
  });
});

describe('E4: maxRedeemable agrees with applyPurchase', () => {
  it('settles overdue expiry before computing the limit', () => {
    const sim = new Sim();
    sim.buy(1_000_000, d0);
    const now = at('2027-01-30 08:00'); // expiry day, before the cron
    expect(maxRedeemable(sim.rules, sim.state, flowers(200_000), null, now)).toBe(0);
    expect(maxRedeemable(sim.rules, sim.state, flowers(200_000), null, at('2027-01-29 23:59'))).toBe(10_000);
  });

  it('returns 0 for a gift that is not available', () => {
    const sim = new Sim();
    sim.seedPoints(50_000, d0);
    for (let i = 1; i <= 2; i++) sim.buy(150_000, plusDays(d0, i));
    const g = sim.gifts('available')[0]!;
    sim.buy(50_000, plusDays(d0, 3), { useRewardId: g.id });
    expect(maxRedeemable(sim.rules, sim.state, flowers(200_000), g.id, plusDays(d0, 4))).toBe(0);
  });
});

describe('E5: rolling back the latest step cascades over steps of already reversed purchases', () => {
  it('reversing every purchase empties the card regardless of order', () => {
    for (const order of [
      ['p2', 'p1'],
      ['p1', 'p2'],
    ]) {
      const sim = new Sim(noWindow());
      sim.buy(150_000, d0);
      sim.buy(150_000, plusDays(d0, 1));
      for (const id of order) sim.reverse(id, plusDays(d0, 2));
      expect(sim.card).toEqual({ cycle: 1, filled: 0 });
    }
  });

  it('at the card boundary: reverse the 10th purchase then the 11th → 9 filled on card 1, next purchase unlocks the cell-10 gift', () => {
    const sim = new Sim(noWindow());
    for (let i = 0; i < 10; i++) sim.buy(150_000, plusDays(d0, i));
    sim.buy(150_000, plusDays(d0, 10)); // p11: card 2
    sim.reverse('p10', plusDays(d0, 10));
    sim.reverse('p11', plusDays(d0, 10));
    expect(sim.card).toEqual({ cycle: 1, filled: 9 });
    sim.buy(150_000, plusDays(d0, 11)); // p12 is the 10th active purchase
    expect(sim.gifts('available').filter((g) => g.type === 'discount_pct')).toHaveLength(1);
    expect(sim.card).toEqual({ cycle: 2, filled: 0 });
  });

  it('a reversed non-latest purchase does not consume a daily card slot', () => {
    const sim = new Sim(noWindow(makeRules({ honeycomb: { maxCellsPerDay: 2 } })));
    sim.buy(150_000, at('2026-11-01 10:00'));
    sim.buy(150_000, at('2026-11-01 11:00'));
    sim.reverse('p1', at('2026-11-01 11:30')); // step kept (not latest), but no longer a daily slot
    const o = sim.buy(150_000, at('2026-11-01 12:00'));
    expect(o.purchase?.result?.cellAdvanced).toBe(true);
    expect(sim.card.filled).toBe(3);
  });

  it('three purchases, reverse the middle one then the last: card ends at 1 (cascade stops at an active purchase)', () => {
    const sim = new Sim(noWindow());
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i));
    sim.reverse('p2', plusDays(d0, 3));
    expect(sim.card.filled).toBe(3);
    sim.reverse('p3', plusDays(d0, 3));
    expect(sim.card.filled).toBe(1);
  });

  it('reversing a purchase made before a reset_all warns about the reset, not about later purchases', () => {
    const sim = new Sim(noWindow(makeRules({ expiry: { onExpiry: 'reset_all' } })));
    sim.buy(150_000, d0);
    sim.expiry(plusDays(d0, 90));
    const o = sim.reverse('p1', plusDays(d0, 91));
    expect(o.warnings.find((w) => w.startsWith('card step'))).toMatch(/card was reset since/);
    expect(sim.card).toEqual({ cycle: 2, filled: 0 });
  });
});

describe('E7 / E11: reward values are validated by the schema', () => {
  const r = makeRules();
  it('discount_pct above 100 is rejected', () => {
    expect(() => parseRules({ ...r, honeycomb: { ...r.honeycomb, rewards: [{ cell: 1, type: 'discount_pct', value: 150, title: 'x' }] } })).toThrow();
  });
  it('fractional cap on free_card is rejected', () => {
    expect(() => parseRules({ ...r, honeycomb: { ...r.honeycomb, rewards: [{ cell: 1, type: 'free_card', value: 1500.5, title: 'x' }] } })).toThrow();
    expect(() => parseRules({ ...r, honeycomb: { ...r.honeycomb, rewards: [{ cell: 1, type: 'free_card', value: 1500, title: 'x' }] } })).not.toThrow();
  });
  it('a discount never exceeds the order amount (paid >= 0)', () => {
    const sim = new Sim(makeRules({ honeycomb: { rewards: [{ cell: 1, type: 'discount_pct', value: 100, title: 'free' }] } }));
    sim.buy(150_000, d0);
    const g = sim.gifts('available')[0]!;
    const o = sim.buy(100_000, plusDays(d0, 1), { useRewardId: g.id });
    expect(o.purchase?.result).toMatchObject({ discountApplied: 100_000, paid: 0, cashback: 0 });
  });
});

describe('E8: standalone redeem idempotency checks the payload', () => {
  it('same key with a different amount is a conflict, same payload is a replay', () => {
    const sim = new Sim();
    sim.seedPoints(50_000, d0);
    sim.redeem({ points: 1_000, orderAmount: 100_000, idempotencyKey: 'k' }, plusDays(d0, 1));
    expect(code(() => sim.redeem({ points: 40_000, orderAmount: 100_000, idempotencyKey: 'k' }, plusDays(d0, 1)))).toBe('IDEMPOTENCY_CONFLICT');
    expect(sim.redeem({ points: 1_000, orderAmount: 100_000, idempotencyKey: 'k' }, plusDays(d0, 1)).replayed).toBe(true);
    expect(sim.balance).toBe(49_000);
  });

  it('gift hand-out: same key with another gift is a conflict', () => {
    const sim = new Sim();
    for (let i = 0; i < 6; i++) sim.buy(150_000, plusDays(d0, i));
    const [g1, g2] = sim.gifts('available');
    sim.redeem({ rewardId: g1!.id, idempotencyKey: 'g' }, plusDays(d0, 6));
    expect(code(() => sim.redeem({ rewardId: g2!.id, idempotencyKey: 'g' }, plusDays(d0, 6)))).toBe('IDEMPOTENCY_CONFLICT');
    expect(sim.redeem({ rewardId: g1!.id, idempotencyKey: 'g' }, plusDays(d0, 6)).replayed).toBe(true);
  });
});

describe('E9: level override survives a tier rename', () => {
  it('a demoted client keeps the demoted level after the tier id changes', () => {
    const r1 = makeRules({ expiry: { onExpiry: 'balance_and_level_down' } });
    const sim = new Sim(r1);
    sim.buy(7_000_000, d0);
    sim.expiry(plusDays(d0, 90));
    expect(sim.state.levelOverride).toMatchObject({ levelId: 'honey', levelIndex: 1 });
    sim.rules = parseRules({
      ...r1,
      version: 2,
      levels: { ...r1.levels, tiers: r1.levels.tiers.map((t) => (t.id === 'honey' ? { ...t, id: 'gold' } : t)) },
    });
    expect(sim.level(plusDays(d0, 92))).toBe('gold');
  });
});

describe('E10: percentages have at most 2 decimals and are never rounded up', () => {
  it('percentOf is exact for 2-decimal percents', () => {
    expect(percentOf(1_000_000, 0.12)).toBe(1_200);
    expect(percentOf(333_333, 1.5)).toBe(4_999);
    expect(percentOf(1_000_000, 0.125)).toBe(1_250);
  });
  it('the schema rejects 3 decimals', () => {
    expect(() => makeRules({ maxRedeemPct: 12.345 })).toThrow();
    expect(() => makeRules({ maxRedeemPct: 12.34 })).not.toThrow();
  });
});

describe('E12: purchase amount bounds', () => {
  it('a total above Number.MAX_SAFE_INTEGER or above maxPurchaseAmount is rejected', () => {
    const rules = makeRules();
    const big = Number.MAX_SAFE_INTEGER;
    expect(code(() => validateLines(rules, [{ category: 'flowers', amount: big }, { category: 'cards', amount: big }]))).toBe('INVALID_INPUT');
    expect(code(() => validateLines(rules, flowers(100_000_001)))).toBe('INVALID_INPUT');
    expect(validateLines(rules, flowers(100_000_000))).toBe(100_000_000);
    expect(code(() => new Sim().buy(150_000_000, d0))).toBe('INVALID_INPUT');
  });
});

describe('E13: manual adjustment settles overdue expiry first', () => {
  it('a +1 adjustment after the due date cannot save the old balance', () => {
    const sim = new Sim();
    sim.buy(1_000_000, d0);
    const o = manualAdjust(sim.rules, sim.state, { idempotencyKey: 'm1', staffId: 's', amount: 1, reason: 'test' }, plusDays(d0, 95));
    expect(o.ledger.map((e) => e.type)).toEqual(['expire', 'manual_adjust']);
    expect(balanceFromLedger(applyOutcome(sim.state, o).ledger)).toBe(1);
  });
});

describe('manual adjustment notifies the client', () => {
  it('emits points_adjusted with the signed amount, the new balance and the reason', () => {
    const sim = new Sim();
    sim.buy(1_000_000, d0);
    const o = manualAdjust(sim.rules, sim.state, { idempotencyKey: 'm2', staffId: 's', amount: -4000, reason: '  Ошибка кассы ' }, plusDays(d0, 1));
    expect(o.events).toEqual([{ type: 'points_adjusted', clientId: sim.state.clientId, amount: -4000, balance: 6000, reason: 'Ошибка кассы' }]);
  });
});

describe('item 8: a reversal never creates a contradictory state', () => {
  it('refused when the purchase\'s мёд was already spent (balance would go negative); state unchanged', () => {
    const sim = new Sim();
    sim.seedPoints(10_000, d0); // p1: +10 000
    sim.buy(100_000, at('2026-11-01 15:00'), { redeemPoints: 10_000 }); // p2 spends it
    const before = JSON.stringify(sim.state);
    expect(code(() => sim.reverse('p1', at('2026-11-01 16:00')))).toBe('REVERSAL_POINTS_SPENT');
    expect(JSON.stringify(sim.state)).toBe(before);
    // reversing the redemption itself (it returns мёд) is allowed
    sim.reverse('p2', at('2026-11-01 16:00'));
    expect(sim.balance).toBe(10_000);
  });

  it('refused after reversalWindowHours (default 24 h), allowed within; the window is a rule', () => {
    const sim = new Sim();
    sim.buy(150_000, d0);
    expect(code(() => sim.reverse('p1', new Date(d0.getTime() + 24 * 3_600_000 + 60_000)))).toBe('REVERSAL_WINDOW_EXPIRED');
    sim.reverse('p1', new Date(d0.getTime() + 24 * 3_600_000));
    expect(sim.balance).toBe(0);
    const s2 = new Sim(makeRules({ reversalWindowHours: 2 }));
    s2.buy(150_000, d0);
    expect(code(() => s2.reverse('p1', new Date(d0.getTime() + 3 * 3_600_000)))).toBe('REVERSAL_WINDOW_EXPIRED');
    expect(() => makeRules({ reversalWindowHours: 0 })).toThrow();
    expect(() => makeRules({ reversalWindowHours: 721 })).toThrow();
  });
});

describe('product decision: in-kind gifts', () => {
  it('a free_delivery gift applied to an order without a delivery line is used with 0 money discount (given in kind)', () => {
    const sim = new Sim();
    for (let i = 0; i < 6; i++) sim.buy(150_000, plusDays(d0, i));
    const g = sim.gifts('available').find((x) => x.type === 'free_delivery')!;
    const o = sim.buy(300_000, plusDays(d0, 6), { useRewardId: g.id });
    expect(o.purchase?.result?.discountApplied).toBe(0);
    expect(sim.state.rewards.find((r) => r.id === g.id)?.status).toBe('used');
  });
});

describe('sanity', () => {
  it('registerClient is idempotent and the bonus expires 90 days after the credit', () => {
    const rules = makeRules({ welcomeBonus: 1_000 });
    const s0 = new Sim(rules).state;
    const s1 = applyOutcome(s0, registerClient(rules, s0, d0));
    expect(registerClient(rules, s1, d0).replayed).toBe(true);
    expect(runExpiry(rules, s1, plusDays(d0, 89)).ledger).toHaveLength(0);
    expect(runExpiry(rules, s1, plusDays(d0, 90)).ledger).toHaveLength(1);
    expect(cardPosition(rules, s1)).toEqual({ cycle: 1, filled: 0 });
  });

  it('applyPurchase on a replayed key reports the stored purchase status', () => {
    const sim = new Sim();
    const o1 = sim.buy(150_000, d0, { idempotencyKey: 'same' });
    sim.reverse(o1.purchase!.id, plusDays(d0, 1));
    const o2 = applyPurchase(sim.rules, sim.state, { purchaseId: 'x', idempotencyKey: 'same', staffId: 's', lines: flowers(150_000), channel: 'store' }, plusDays(d0, 2));
    expect(o2.replayed).toBe(true);
    expect(o2.purchase?.status).toBe('reversed');
  });
});
