import { describe, expect, it } from 'vitest';
import { applyPurchase, expiryInfo } from '../src/index.js';
import { at, eventTypes, flowers, makeRules, plusDays, Sim } from './helpers.js';

const last = at('2026-11-01 15:00');

describe('expiry of мёд', () => {
  it('nothing expires on day 89', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const o = sim.expiry(plusDays(at('2026-11-01 23:59'), 89));
    expect(o.ledger).toHaveLength(0);
    expect(sim.balance).toBe(5_000);
  });

  it('the whole balance expires on day 90 (local calendar days)', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    expect(expiryInfo(sim.rules, sim.state, last).expiresOn).toBe('2027-01-30');
    const o = sim.expiry(at('2027-01-30 00:05'));
    expect(o.ledger).toEqual([expect.objectContaining({ type: 'expire', amount: -5_000 })]);
    expect(eventTypes(o)).toContain('points_expired');
    expect(sim.balance).toBe(0);
  });

  it('running the scheduler twice does not expire twice', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    sim.expiry(at('2027-01-30 01:00'));
    const again = sim.expiry(at('2027-01-31 01:00'));
    expect(again.ledger).toHaveLength(0);
    expect(again.events).toHaveLength(0);
  });

  it('every purchase extends the expiry period', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    sim.buy(20_000, plusDays(last, 60));
    const o = sim.expiry(plusDays(last, 100));
    expect(o.ledger).toHaveLength(0);
    expect(expiryInfo(sim.rules, sim.state, last).expiresOn).toBe('2027-03-31');
  });

  it('a purchase after the due date settles expiry first (late scheduler)', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const o = sim.buy(100_000, plusDays(last, 95));
    expect(o.ledger.map((e) => e.type)).toEqual(['expire', 'accrual']);
    expect(sim.balance).toBe(1_000);
  });

  it('expired points cannot be redeemed in the same purchase', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const s = sim.state;
    expect(() =>
      applyPurchase(sim.rules, s, { purchaseId: 'x', idempotencyKey: 'x', staffId: null, lines: flowers(100_000), channel: 'store', redeemPoints: 1_000 }, plusDays(last, 95)),
    ).toThrow(/balance/);
  });

  it("onExpiry 'balance_only' keeps the level", () => {
    const sim = new Sim();
    sim.buy(2_500_000, last);
    sim.expiry(plusDays(last, 90));
    expect(sim.level(plusDays(last, 90))).toBe('honey');
    expect(sim.state.levelOverride).toBeNull();
  });

  it("onExpiry 'balance_and_level_down' drops one level and old purchases stop counting", () => {
    const sim = new Sim(makeRules({ expiry: { onExpiry: 'balance_and_level_down' } }));
    sim.buy(7_000_000, last); // Королева улья
    const o = sim.expiry(plusDays(last, 90));
    expect(o.events.find((e) => e.type === 'level_down')).toMatchObject({ from: 'queen', to: 'honey' });
    expect(sim.level(plusDays(last, 91))).toBe('honey');
    // New purchases count from zero towards the next level.
    sim.buy(5_000_000, plusDays(last, 92));
    expect(sim.level(plusDays(last, 92))).toBe('honey');
    sim.buy(1_000_000, plusDays(last, 93));
    expect(sim.level(plusDays(last, 93))).toBe('queen');
  });

  it("onExpiry 'balance_and_level_down' on the lowest level only burns points", () => {
    const sim = new Sim(makeRules({ expiry: { onExpiry: 'balance_and_level_down' } }));
    sim.buy(500_000, last);
    const o = sim.expiry(plusDays(last, 90));
    expect(eventTypes(o)).toEqual(['points_expired']);
    expect(o.levelOverride).toBeUndefined();
  });

  it("onExpiry 'reset_all' resets points, level, card and unused gifts", () => {
    const sim = new Sim(makeRules({ expiry: { onExpiry: 'reset_all' } }));
    sim.buy(2_500_000, last);
    sim.buy(150_000, plusDays(last, 1));
    sim.buy(150_000, plusDays(last, 2)); // cell 3 → free card gift
    const lastBuy = plusDays(last, 2);
    const o = sim.expiry(plusDays(lastBuy, 90));
    expect(eventTypes(o)).toEqual(expect.arrayContaining(['points_expired', 'level_down', 'card_reset']));
    expect(sim.balance).toBe(0);
    expect(sim.level(plusDays(lastBuy, 90))).toBe('bee');
    expect(sim.card).toEqual({ cycle: 2, filled: 0 });
    expect(sim.gifts('available')).toHaveLength(0);
    expect(sim.gifts('revoked')).toHaveLength(1);
    // Next purchase starts the new card at cell 1.
    sim.buy(150_000, plusDays(lastBuy, 91));
    expect(sim.card).toEqual({ cycle: 2, filled: 1 });
  });

  it('warnings are sent 14, 7 and 1 days before expiry, each once', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const sent: number[] = [];
    for (let d = 70; d < 90; d++) {
      const o = sim.expiry(plusDays(last, d));
      for (const e of o.events) if (e.type === 'expiry_warning') sent.push(e.daysLeft);
    }
    expect(sent).toEqual([14, 7, 1]);
  });

  it('warning carries balance and expiry date', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const o = sim.expiry(plusDays(last, 76));
    expect(o.events[0]).toMatchObject({ type: 'expiry_warning', daysLeft: 14, balance: 5_000, expiresOn: '2027-01-30' });
  });

  it('a missed scheduler run sends one warning with the real days left', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    const o = sim.expiry(plusDays(last, 85)); // 14 and 7 were missed
    expect(o.events).toEqual([expect.objectContaining({ type: 'expiry_warning', daysLeft: 5 })]);
    expect(sim.expiry(plusDays(last, 86)).events).toHaveLength(0);
    expect(sim.expiry(plusDays(last, 89)).events[0]).toMatchObject({ daysLeft: 1 });
  });

  it('no warning when the balance is zero', () => {
    const sim = new Sim();
    sim.register(last);
    expect(sim.expiry(plusDays(last, 76)).events).toHaveLength(0);
  });

  it('a new purchase restarts the warning cycle', () => {
    const sim = new Sim();
    sim.buy(500_000, last);
    sim.expiry(plusDays(last, 76)); // 14-day warning
    sim.buy(100_000, plusDays(last, 80));
    const o = sim.expiry(plusDays(last, 80 + 76));
    expect(o.events[0]).toMatchObject({ type: 'expiry_warning', daysLeft: 14 });
  });

  it('welcome bonus expires 90 days after registration if there are no purchases', () => {
    const reg = at('2026-11-01 09:00');
    const sim = new Sim(makeRules({ welcomeBonus: 10_000 }), reg);
    sim.register(reg);
    sim.expiry(plusDays(reg, 90));
    expect(sim.balance).toBe(0);
  });
});
