import { describe, expect, it } from 'vitest';
import { applyOutcome, grantGift, grantPoints, isGrantedReward, LoyaltyError, type GrantGiftInput } from '../src/index.js';
import { at, eventTypes, plusDays, Sim } from './helpers.js';

const d0 = at('2026-11-01 10:00');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LoyaltyError) return e.code;
    throw e;
  }
  return undefined;
}

const card = (key = 'g1', reason = 'день рождения'): GrantGiftInput => ({
  idempotencyKey: key,
  staffId: 'owner',
  gift: { type: 'free_card', title: 'Открытка в подарок' },
  reason,
});

describe('owner grants: gift without a purchase', () => {
  it('adds an available gift with reason and author; card, мёд and expiry untouched', () => {
    const sim = new Sim();
    sim.buy(200_000, d0);
    const before = sim.state;
    const o = grantGift(sim.rules, sim.state, card(), plusDays(d0, 1));
    sim.state = applyOutcome(sim.state, o);
    const gift = sim.state.rewards.find((r) => r.id === 'grant-g1')!;
    expect(gift).toMatchObject({ type: 'free_card', status: 'available', unlockedByPurchase: null, grantedBy: 'owner', grantReason: 'день рождения', cycle: 1 });
    expect(gift.cell).toBeGreaterThanOrEqual(1);
    expect(isGrantedReward(gift)).toBe(true);
    expect(eventTypes(o)).toEqual(['gift_granted']);
    expect(o.events[0]).toMatchObject({ title: 'Открытка в подарок', reason: 'день рождения', rewardType: 'free_card' });
    expect(o.ledger).toHaveLength(0);
    expect(o.cardMoves).toHaveLength(0);
    expect(sim.balance).toBe(2_000);
    expect(sim.card).toEqual({ cycle: 1, filled: 1 });
    expect(before.rewards).toHaveLength(0);
  });

  it('is idempotent; the same key with another gift is a conflict', () => {
    const sim = new Sim();
    sim.state = applyOutcome(sim.state, grantGift(sim.rules, sim.state, card(), d0));
    const again = grantGift(sim.rules, sim.state, card(), plusDays(d0, 1));
    expect(again.replayed).toBe(true);
    expect(again.events).toHaveLength(0);
    expect(code(() => grantGift(sim.rules, sim.state, { ...card(), gift: { type: 'free_delivery', title: 'Бесплатная доставка' } }, d0))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('validates reason, type and discount value', () => {
    const sim = new Sim();
    expect(code(() => grantGift(sim.rules, sim.state, card('k', '  '), d0))).toBe('INVALID_INPUT');
    expect(code(() => grantGift(sim.rules, sim.state, { ...card(), gift: { type: 'nope' as never, title: 'x' } }, d0))).toBe('INVALID_INPUT');
    expect(code(() => grantGift(sim.rules, sim.state, { ...card(), gift: { type: 'discount_pct', value: 150, title: 'x' } }, d0))).toBe('INVALID_INPUT');
  });

  it('a granted discount gift is used in the next purchase like a honeycomb gift; a reversal gives it back', () => {
    const sim = new Sim();
    const grant: GrantGiftInput = { idempotencyKey: 'g2', staffId: 'owner', gift: { type: 'discount_pct', value: 10, title: 'Скидка 10%' }, reason: 'извинение за задержку' };
    sim.state = applyOutcome(sim.state, grantGift(sim.rules, sim.state, grant, d0));
    sim.buy(300_000, plusDays(d0, 1), { useRewardId: 'grant-g2' });
    expect(sim.last.purchase!.result).toMatchObject({ discountApplied: 30_000, paid: 270_000, cashback: 2_700 });
    expect(sim.gifts('used').map((r) => r.id)).toEqual(['grant-g2']);
    sim.reverse('p1', plusDays(d0, 1));
    expect(sim.gifts('available').map((r) => r.id)).toEqual(['grant-g2']);
  });
});

describe('owner grants: bonus мёд', () => {
  it('credits a manual adjustment with a points_granted event and restarts the expiry timer', () => {
    const sim = new Sim();
    sim.buy(500_000, d0); // 5 000
    const when = plusDays(d0, 80);
    const o = grantPoints(sim.rules, sim.state, { idempotencyKey: 'h1', staffId: 'owner', points: 20_000, reason: 'день рождения' }, when);
    sim.state = applyOutcome(sim.state, o);
    expect(o.ledger).toEqual([expect.objectContaining({ type: 'manual_adjust', amount: 20_000, reason: 'день рождения', staffId: 'owner', idempotencyKey: 'h1' })]);
    expect(o.events).toEqual([{ type: 'points_granted', clientId: 'c1', amount: 20_000, balance: 25_000, reason: 'день рождения' }]);
    // Day 91 after the purchase but only 11 after the grant: nothing burns.
    expect(sim.expiry(plusDays(d0, 91)).ledger).toHaveLength(0);
    expect(sim.balance).toBe(25_000);
  });

  it('settles overdue expiry first (a grant cannot resurrect burnt мёд) and reports it', () => {
    const sim = new Sim();
    sim.buy(500_000, d0);
    const o = grantPoints(sim.rules, sim.state, { idempotencyKey: 'h1', staffId: 'owner', points: 10_000, reason: 'компенсация' }, plusDays(d0, 95));
    expect(eventTypes(o)).toEqual(['points_expired', 'points_granted']);
    sim.state = applyOutcome(sim.state, o);
    expect(sim.balance).toBe(10_000);
  });

  it('is idempotent; same key with another amount is a conflict; amount must be positive', () => {
    const sim = new Sim();
    const input = { idempotencyKey: 'h1', staffId: 'owner', points: 5_000, reason: 'подарок' };
    sim.state = applyOutcome(sim.state, grantPoints(sim.rules, sim.state, input, d0));
    expect(grantPoints(sim.rules, sim.state, input, d0).replayed).toBe(true);
    expect(code(() => grantPoints(sim.rules, sim.state, { ...input, points: 6_000 }, d0))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(() => grantPoints(sim.rules, sim.state, { ...input, idempotencyKey: 'h2', points: 0 }, d0))).toBe('INVALID_INPUT');
    expect(code(() => grantPoints(sim.rules, sim.state, { ...input, idempotencyKey: 'h3', points: -5 }, d0))).toBe('INVALID_INPUT');
    expect(code(() => grantPoints(sim.rules, sim.state, { ...input, idempotencyKey: 'h4', reason: ' ' }, d0))).toBe('INVALID_INPUT');
  });
});
