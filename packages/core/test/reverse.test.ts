import { describe, expect, it } from 'vitest';
import { applyOutcome, applyPurchase, LoyaltyError, reversePurchase } from '../src/index.js';
import { at, eventTypes, flowers, plusDays, Sim } from './helpers.js';

const d0 = at('2026-11-01 12:00');

describe('reversal of a purchase', () => {
  it('requires a reason', () => {
    const sim = new Sim();
    sim.buy(150_000, d0);
    expect(() => reversePurchase(sim.rules, sim.state, { purchaseId: 'p1', reason: '  ', staffId: 's1' }, d0)).toThrow(
      LoyaltyError,
    );
  });

  it('reverses the accrual and rolls back the latest cell move', () => {
    const sim = new Sim();
    sim.buy(150_000, d0);
    const o = sim.reverse('p1', plusDays(d0, 0));
    expect(o.ledger).toEqual([expect.objectContaining({ type: 'reversal', amount: -1_500, purchaseId: 'p1' })]);
    expect(sim.balance).toBe(0);
    expect(sim.card).toEqual({ cycle: 1, filled: 0 });
    expect(sim.state.purchases[0]).toMatchObject({ status: 'reversed', reversedReason: 'ошибка флориста', reversedBy: 's1' });
    expect(eventTypes(o)).toContain('purchase_reversed');
  });

  it('a reversed same-day purchase frees the daily cell slot', () => {
    const sim = new Sim();
    sim.buy(150_000, at('2026-11-01 10:00'));
    sim.reverse('p1', at('2026-11-01 10:05'));
    const o = sim.buy(150_000, at('2026-11-01 10:10'));
    expect(o.purchase?.result?.cellAdvanced).toBe(true);
  });

  it('returns redeemed points and the gift used in the purchase', () => {
    const sim = new Sim();
    sim.seedPoints(50_000, d0);
    for (let i = 1; i <= 2; i++) sim.buy(150_000, plusDays(d0, i)); // cell 3 → free card
    const gift = sim.gifts('available')[0]!;
    const before = sim.balance;
    sim.buy(200_000, plusDays(d0, 3), { redeemPoints: 40_000, useRewardId: gift.id }); // p4
    sim.reverse('p4', plusDays(d0, 3));
    expect(sim.balance).toBe(before);
    expect(sim.state.rewards.find((r) => r.id === gift.id)?.status).toBe('available');
  });

  it('does not roll back the card if a later purchase moved it, and warns', () => {
    const sim = new Sim();
    sim.buy(150_000, d0);
    sim.buy(150_000, plusDays(d0, 1));
    const o = sim.reverse('p1', plusDays(d0, 1));
    expect(sim.card.filled).toBe(2);
    expect(o.warnings.some((w) => w.includes('not rolled back'))).toBe(true);
  });

  it('revokes an unlocked gift that is still available', () => {
    const sim = new Sim();
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i));
    sim.reverse('p3', plusDays(d0, 2));
    expect(sim.gifts('revoked')).toHaveLength(1);
    expect(sim.gifts('available')).toHaveLength(0);
    expect(sim.card.filled).toBe(2);
    // The next purchase reaches cell 3 again and unlocks a fresh gift.
    sim.buy(150_000, plusDays(d0, 3));
    expect(sim.gifts('available')).toHaveLength(1);
  });

  it('keeps an unlocked gift that was already used and flags it in warnings', () => {
    const sim = new Sim();
    for (let i = 0; i < 3; i++) sim.buy(150_000, plusDays(d0, i));
    const gift = sim.gifts('available')[0]!;
    sim.buy(150_000, plusDays(d0, 3), { useRewardId: gift.id }); // p4 uses the card gift
    const o = sim.reverse('p3', plusDays(d0, 4));
    expect(sim.state.rewards.find((r) => r.id === gift.id)?.status).toBe('used');
    expect(o.warnings.join('\n')).toMatch(/already used in purchase p4/);
  });

  it('goes negative and warns when accrued points were already spent', () => {
    const sim = new Sim();
    sim.seedPoints(10_000, d0); // p1: 1M → 10 000
    sim.buy(100_000, plusDays(d0, 1), { redeemPoints: 10_000 }); // p2 spends them, earns 900
    const o = sim.reverse('p1', plusDays(d0, 2));
    expect(sim.balance).toBe(900 - 10_000);
    expect(o.warnings.join('\n')).toMatch(/negative/);
  });

  it('emits level_down when the reversal drops the level', () => {
    const sim = new Sim();
    sim.buy(2_100_000, d0);
    const o = sim.reverse('p1', d0);
    expect(o.events.find((e) => e.type === 'level_down')).toMatchObject({ from: 'honey', to: 'bee', reason: 'reversal' });
  });

  it('reversing twice is a no-op replay', () => {
    const sim = new Sim();
    sim.buy(150_000, d0);
    sim.reverse('p1', d0);
    const again = sim.reverse('p1', d0);
    expect(again.replayed).toBe(true);
    expect(again.ledger).toHaveLength(0);
  });

  it('unknown purchase id → PURCHASE_NOT_FOUND', () => {
    const sim = new Sim();
    expect(() => sim.reverse('nope', d0)).toThrow(/not found/);
  });
});

describe('idempotency', () => {
  it('re-submitting the same key returns the original purchase with no new effects', () => {
    const sim = new Sim();
    const input = { purchaseId: 'a', idempotencyKey: 'order-42', staffId: 's1', lines: flowers(300_000), channel: 'store' as const };
    const first = applyPurchase(sim.rules, sim.state, input, d0);
    sim.state = applyOutcome(sim.state, first);
    const second = applyPurchase(sim.rules, sim.state, { ...input, purchaseId: 'b' }, plusDays(d0, 1));
    expect(second.replayed).toBe(true);
    expect(second.purchase?.id).toBe('a');
    expect(second.purchase?.result).toEqual(first.purchase?.result);
    expect(second.ledger).toHaveLength(0);
    expect(second.cardMoves).toHaveLength(0);
    expect(second.events).toHaveLength(0);
  });

  it('the same key with a different amount is rejected as a conflict', () => {
    const sim = new Sim();
    sim.buy(300_000, d0, { idempotencyKey: 'order-1' });
    expect(() => sim.buy(310_000, d0, { idempotencyKey: 'order-1' })).toThrow(/different purchase/);
  });
});
