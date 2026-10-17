import { describe, expect, it } from 'vitest';
import { at, eventTypes, makeRules, Sim } from './helpers.js';

const day1 = at('2026-11-01 10:00');

describe('мёд: cashback and levels', () => {
  it('accrues 1% on the first purchase (Пчёлка)', () => {
    const sim = new Sim();
    const o = sim.buy(450_000, day1);
    expect(sim.balance).toBe(4_500);
    expect(o.purchase?.result?.cashbackPct).toBe(1);
    expect(eventTypes(o)).toContain('points_accrued');
  });

  it('floors fractional cashback to whole сум', () => {
    const sim = new Sim();
    sim.buy(123_456, day1);
    expect(sim.balance).toBe(1_234); // 1234.56 → 1234
  });

  it('supports fractional percentages without float error', () => {
    const rules = makeRules({
      levels: {
        tiers: [
          { id: 'bee', title: 'Пчёлка', cashbackPct: 1.5, threshold: 0 },
          { id: 'honey', title: 'Медовая', cashbackPct: 3, threshold: 2_000_000 },
        ],
      },
    });
    const sim = new Sim(rules);
    sim.buy(333_333, day1);
    expect(sim.balance).toBe(4_999); // 4999.995 → 4999
  });

  it('crossing the threshold: the crossing purchase earns the OLD rate, level_up is emitted', () => {
    const sim = new Sim();
    sim.buy(1_500_000, day1); // total 1.5M, Пчёлка
    const o = sim.buy(600_000, at('2026-11-02 10:00')); // total 2.1M → Медовая after
    expect(o.purchase?.result?.cashbackPct).toBe(1);
    expect(o.purchase?.result?.cashback).toBe(6_000);
    expect(o.levelChange).toEqual({ from: 'bee', to: 'honey' });
    expect(o.events.find((e) => e.type === 'level_up')).toMatchObject({ to: 'honey', cashbackPct: 3 });
    // Next purchase earns 3%.
    const next = sim.buy(100_000, at('2026-11-03 10:00'));
    expect(next.purchase?.result?.cashbackPct).toBe(3);
    expect(next.purchase?.result?.cashback).toBe(3_000);
  });

  it('reaching the threshold exactly counts as reaching the level', () => {
    const sim = new Sim();
    const o = sim.buy(2_000_000, day1);
    expect(o.levelChange?.to).toBe('honey');
    expect(sim.level(day1)).toBe('honey');
  });

  it('can jump two levels in one purchase (single level_up from→to)', () => {
    const sim = new Sim();
    const o = sim.buy(6_000_000, day1);
    expect(o.levelChange).toEqual({ from: 'bee', to: 'queen' });
    expect(eventTypes(o).filter((t) => t === 'level_up')).toHaveLength(1);
  });

  it("criterion 'count' uses the number of purchases", () => {
    const rules = makeRules({
      levels: {
        criterion: 'count',
        tiers: [
          { id: 'bee', title: 'Пчёлка', cashbackPct: 1, threshold: 0 },
          { id: 'honey', title: 'Медовая', cashbackPct: 3, threshold: 3 },
        ],
      },
    });
    const sim = new Sim(rules);
    sim.buy(50_000, at('2026-11-01 10:00'));
    sim.buy(50_000, at('2026-11-02 10:00'));
    const third = sim.buy(50_000, at('2026-11-03 10:00'));
    expect(third.levelChange?.to).toBe('honey');
  });

  it('window of N months: old purchases stop counting and the level drops', () => {
    const rules = makeRules({ levels: { windowMonths: 3 } });
    const sim = new Sim(rules);
    sim.buy(2_500_000, at('2026-11-01 10:00'));
    expect(sim.level(at('2026-12-01 10:00'))).toBe('honey');
    expect(sim.level(at('2027-02-01 10:00'))).toBe('honey'); // exactly 3 months: still counted
    expect(sim.level(at('2027-02-02 10:00'))).toBe('bee');
  });

  it('cashback is computed on the paid part only (amount − points)', () => {
    const sim = new Sim();
    sim.seedPoints(50_000, day1); // 5M purchase → 50 000 мёд, total 5M (Медовая)
    const o = sim.buy(200_000, at('2026-11-02 10:00'), { redeemPoints: 50_000 });
    expect(o.purchase?.result?.paid).toBe(150_000);
    expect(o.purchase?.result?.cashbackPct).toBe(3);
    expect(o.purchase?.result?.cashback).toBe(4_500); // 3% of 150 000, not of 200 000
  });

  it('only enabled categories earn cashback (delivery excluded by default)', () => {
    const sim = new Sim();
    const o = sim.buy(0, day1, {
      lines: [
        { category: 'flowers', amount: 300_000 },
        { category: 'delivery', amount: 40_000 },
      ],
    });
    expect(o.purchase?.result?.amount).toBe(340_000);
    expect(o.purchase?.result?.cashbackBase).toBe(300_000);
    expect(sim.balance).toBe(3_000);
  });

  it('a purchase of only excluded categories earns nothing but still counts for level and card', () => {
    const sim = new Sim(makeRules({ honeycomb: { minPurchaseForCell: 0 } }));
    const o = sim.buy(0, day1, { lines: [{ category: 'delivery', amount: 2_000_000 }] });
    expect(sim.balance).toBe(0);
    expect(eventTypes(o)).not.toContain('points_accrued');
    expect(o.levelChange?.to).toBe('honey');
    expect(sim.card.filled).toBe(1);
  });

  it('points are spread proportionally over categories when some are excluded', () => {
    const sim = new Sim();
    sim.seedPoints(100_000, day1);
    // 300k flowers + 100k delivery, pay 100k with points → paid 300k of 400k.
    const o = sim.buy(0, at('2026-11-02 10:00'), {
      redeemPoints: 100_000,
      lines: [
        { category: 'flowers', amount: 300_000 },
        { category: 'delivery', amount: 100_000 },
      ],
    });
    expect(o.purchase?.result?.cashbackBase).toBe(225_000); // 300k * 300/400
  });

  it('welcome bonus is credited once at registration', () => {
    const sim = new Sim(makeRules({ welcomeBonus: 20_000 }));
    const o = sim.register(at('2026-11-01 09:00'));
    expect(sim.balance).toBe(20_000);
    expect(o.ledger[0]?.type).toBe('welcome');
    expect(eventTypes(o)).toEqual(['welcome_bonus']);
    const again = sim.register(at('2026-11-01 09:05'));
    expect(again.replayed).toBe(true);
    expect(sim.balance).toBe(20_000);
  });

  it('welcome bonus 0 creates no ledger entry', () => {
    const sim = new Sim();
    const o = sim.register(at('2026-11-01 09:00'));
    expect(o.ledger).toHaveLength(0);
  });
});
