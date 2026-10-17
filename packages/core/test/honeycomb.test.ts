import { describe, expect, it } from 'vitest';
import { at, eventTypes, makeRules, plusDays, Sim } from './helpers.js';

const start = at('2026-11-01 12:00');
/** Buy n qualifying purchases on n consecutive days starting at `from`. */
function buyDays(sim: Sim, n: number, from = start, amount = 150_000) {
  for (let i = 0; i < n; i++) sim.buy(amount, plusDays(from, i));
}

describe('соты: honeycomb card', () => {
  it('each qualifying purchase advances one cell', () => {
    const sim = new Sim();
    const o = sim.buy(150_000, start);
    expect(sim.card).toEqual({ cycle: 1, filled: 1 });
    expect(o.events.find((e) => e.type === 'card_advanced')).toMatchObject({ cell: 1, purchasesToNextReward: 2 });
  });

  it('a purchase below minPurchaseForCell does not advance (but earns cashback)', () => {
    const sim = new Sim();
    const o = sim.buy(99_999, start);
    expect(sim.card.filled).toBe(0);
    expect(o.purchase?.result?.cellSkipReason).toBe('below_min_amount');
    expect(sim.balance).toBe(999);
  });

  it('a purchase exactly at minPurchaseForCell advances', () => {
    const sim = new Sim();
    sim.buy(100_000, start);
    expect(sim.card.filled).toBe(1);
  });

  it('default rewards unlock at cells 3, 6 and 10 into gifts (not auto-applied)', () => {
    const sim = new Sim();
    buyDays(sim, 2);
    expect(sim.gifts()).toHaveLength(0);
    const third = sim.buy(150_000, plusDays(start, 2));
    expect(eventTypes(third)).toContain('reward_unlocked');
    expect(sim.gifts('available').map((g) => [g.cell, g.type])).toEqual([[3, 'free_card']]);
    buyDays(sim, 7, plusDays(start, 3));
    expect(sim.gifts('available').map((g) => [g.cell, g.type, g.value])).toEqual([
      [3, 'free_card', null],
      [6, 'free_delivery', null],
      [10, 'discount_pct', 10],
    ]);
  });

  it('daily limit: second purchase on the same Tashkent day does not advance', () => {
    const sim = new Sim();
    sim.buy(150_000, at('2026-11-01 10:00'));
    const second = sim.buy(150_000, at('2026-11-01 18:00'));
    expect(second.purchase?.result?.cellSkipReason).toBe('daily_limit');
    expect(sim.card.filled).toBe(1);
  });

  it('daily limit resets at Tashkent midnight, not UTC midnight', () => {
    const sim = new Sim();
    sim.buy(150_000, at('2026-11-01 23:50')); // 18:50 UTC
    const next = sim.buy(150_000, at('2026-11-02 00:10')); // still Nov 1 in UTC
    expect(next.purchase?.result?.cellAdvanced).toBe(true);
    expect(sim.card.filled).toBe(2);
  });

  it('daily limit is per local day even when UTC dates match', () => {
    const sim = new Sim();
    // 2026-11-02 00:30 local = 2026-11-01 19:30 UTC; 2026-11-02 23:30 local = 18:30 UTC Nov 2.
    sim.buy(150_000, at('2026-11-02 00:30'));
    const sameLocalDay = sim.buy(150_000, at('2026-11-02 23:30'));
    expect(sameLocalDay.purchase?.result?.cellSkipReason).toBe('daily_limit');
  });

  it('maxCellsPerDay is configurable', () => {
    const sim = new Sim(makeRules({ honeycomb: { maxCellsPerDay: 2 } }));
    sim.buy(150_000, at('2026-11-01 10:00'));
    sim.buy(150_000, at('2026-11-01 11:00'));
    sim.buy(150_000, at('2026-11-01 12:00'));
    expect(sim.card.filled).toBe(2);
  });

  it('a purchase below the minimum does not use up the daily limit', () => {
    const sim = new Sim();
    sim.buy(20_000, at('2026-11-01 10:00'));
    const o = sim.buy(150_000, at('2026-11-01 11:00'));
    expect(o.purchase?.result?.cellAdvanced).toBe(true);
  });

  it('after cell 10 the card restarts: cycle +1, same rewards', () => {
    const sim = new Sim();
    buyDays(sim, 10);
    expect(sim.card).toEqual({ cycle: 2, filled: 0 });
    const done = sim.state.cardMoves.at(-1);
    expect(done).toMatchObject({ cycle: 1, cell: 10 });
    buyDays(sim, 3, plusDays(start, 10));
    expect(sim.card).toEqual({ cycle: 2, filled: 3 });
    const cycle2Gifts = sim.gifts().filter((g) => g.cycle === 2);
    expect(cycle2Gifts.map((g) => g.type)).toEqual(['free_card']);
  });

  it('card_advanced reports cardCompleted on the last cell', () => {
    const sim = new Sim();
    buyDays(sim, 9);
    const tenth = sim.buy(150_000, plusDays(start, 9));
    expect(tenth.events.find((e) => e.type === 'card_advanced')).toMatchObject({ cell: 10, cardCompleted: true });
  });

  it("afterLastCell 'new_card' uses nextCardRewards from the second card", () => {
    const sim = new Sim(
      makeRules({
        honeycomb: {
          afterLastCell: 'new_card',
          nextCardRewards: [{ cell: 2, type: 'custom', title: 'Мини-букет' }],
        },
      }),
    );
    buyDays(sim, 12);
    const second = sim.gifts().filter((g) => g.cycle === 2);
    expect(second.map((g) => [g.cell, g.title])).toEqual([[2, 'Мини-букет']]);
  });

  it('using a gift marks it used and applies its value', () => {
    const sim = new Sim();
    buyDays(sim, 10);
    const discount = sim.gifts('available').find((g) => g.type === 'discount_pct')!;
    const o = sim.buy(300_000, plusDays(start, 10), { useRewardId: discount.id });
    expect(o.purchase?.result?.discountApplied).toBe(30_000);
    expect(sim.state.rewards.find((r) => r.id === discount.id)?.status).toBe('used');
    // A used gift cannot be used again.
    expect(() => sim.buy(300_000, plusDays(start, 11), { useRewardId: discount.id })).toThrow(/used/);
  });

  it('free delivery gift zeroes the delivery line', () => {
    const sim = new Sim();
    buyDays(sim, 6);
    const free = sim.gifts('available').find((g) => g.type === 'free_delivery')!;
    const o = sim.buy(0, plusDays(start, 6), {
      useRewardId: free.id,
      lines: [
        { category: 'flowers', amount: 300_000 },
        { category: 'delivery', amount: 35_000 },
      ],
    });
    expect(o.purchase?.result?.discountApplied).toBe(35_000);
    expect(o.purchase?.result?.paid).toBe(300_000);
  });
});
