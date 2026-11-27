import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  applyPurchase,
  balanceOf,
  birthdayWindow,
  calendarDaysBetween,
  defaultRules,
  deriveLevel,
  emptyClientState,
  localDateKey,
  localDayNumber,
  LoyaltyError,
  maxRedeemable,
  parseRules,
  registerClient,
  runExpiry,
  type ClientState,
  type LoyaltyRules,
} from '../src/index.js';
import { at, eventTypes, flowers, ownerRules, plusDays, Sim } from './helpers.js';

/** Owner rules (questionnaire 10.11.2026 + docs/Спорные вопросы.md Л1–Л8). */

const R = ownerRules();
const level = (s: Sim, now: Date) => deriveLevel(s.rules, s.state, now);

describe('owner rules: defaults', () => {
  it('match the questionnaire', () => {
    expect(() => parseRules(defaultRules)).not.toThrow();
    expect(R.levels).toMatchObject({ criterion: 'count', windowDays: 90, oncePerDay: true, mode: 'sticky', resetAfterDays: 90, resetWarnDays: [7, 1] });
    expect(R.levels.tiers.map((t) => [t.title, t.cashbackPct, t.threshold])).toEqual([['Пчёлка', 1, 0], ['Королева улья', 3, 3], ['Золотой мёд', 5, 10]]);
    expect(R.welcomeBonus).toBe(15_000);
    expect(R.expiry).toMatchObject({ expiryDays: 180, expiryWarnDays: [14, 7, 1], onExpiry: 'balance_only' });
    expect(R.honeycomb).toMatchObject({ minPurchaseForCell: 0, maxCellsPerDay: 1, afterLastCell: 'restart' });
    expect(R.maxRedeemPct).toBe(50);
    expect(R.allowDiscountWithPoints).toBe(false);
    expect(R.cashbackCategories.delivery).toBe(false);
    expect(R.staffCanReverse).toBe(true);
    expect(R.birthdayReward).toEqual({ enabled: true, type: 'discount_pct', value: 10, daysBefore: 3, daysAfter: 3 });
  });

  it('schema: sticky needs resetAfterDays, oncePerDay needs a window, one window kind only', () => {
    const bad = (patch: Record<string, unknown>) => () => parseRules({ ...defaultRules, levels: { ...defaultRules.levels, ...patch } });
    expect(bad({ resetAfterDays: null })).toThrow();
    expect(bad({ windowDays: null })).toThrow(); // oncePerDay without a window
    expect(bad({ windowMonths: 3 })).toThrow();
    expect(bad({ resetWarnDays: [90] })).toThrow();
    expect(bad({ mode: 'rolling' })).not.toThrow();
  });
});

describe('levels by purchase count, one per day (Л1, Л2)', () => {
  it('rises at the purchase that reaches 3 days with a purchase; same-day orders count once', () => {
    const s = new Sim(R, at('2026-11-01 09:00'));
    s.buy(100_000, at('2026-11-02 10:00'));
    s.buy(50_000, at('2026-11-02 18:00')); // same day: does not count for the level
    expect(level(s, at('2026-11-02 19:00'))).toMatchObject({ metric: 1, index: 0 });
    s.buy(100_000, at('2026-11-05 10:00'));
    expect(eventTypes(s.last)).not.toContain('level_up');
    const third = s.buy(100_000, at('2026-11-09 10:00'));
    expect(eventTypes(third)).toContain('level_up');
    expect(third.purchase!.result).toMatchObject({ cashbackPct: 1, levelBefore: 'bee', levelAfter: 'queen', stickyLevel: 'queen' });
    // 3 % from the next purchase on, any amount
    const next = s.buy(10_000, at('2026-11-10 10:00'));
    expect(next.purchase!.result).toMatchObject({ cashbackPct: 3, cashback: 300 });
  });

  it('Золотой мёд at 10 purchase days within 90 days', () => {
    const s = new Sim(R, at('2026-01-01 09:00'));
    for (let i = 0; i < 10; i++) s.buy(200_000, plusDays(at('2026-01-02 12:00'), i * 8));
    expect(level(s, plusDays(at('2026-01-02 12:00'), 72)).tier.id).toBe('gold');
    expect(s.last.events.map((e) => e.type)).toContain('level_up');
  });
});

describe('sticky level (Л1) and its reset timer', () => {
  function queen(): Sim {
    const s = new Sim(R, at('2026-01-01 09:00'));
    s.buy(100_000, at('2026-01-02 10:00'));
    s.buy(100_000, at('2026-01-03 10:00'));
    s.buy(100_000, at('2026-01-04 10:00'));
    expect(s.level(at('2026-01-04 11:00'))).toBe('queen');
    return s;
  }

  it('does not drop while the client buys at least once per 90 days', () => {
    const s = queen();
    let d = at('2026-01-04 10:00');
    for (let i = 0; i < 6; i++) {
      d = plusDays(d, 85);
      expect(s.level(d)).toBe('queen'); // the 90-day count is 1, the level is kept
      s.buy(50_000, d);
      expect(s.last.purchase!.result!.cashbackPct).toBe(3);
    }
    // the rolling alternative would have dropped long ago
    const rolling = { ...R, levels: { ...R.levels, mode: 'rolling' as const } };
    expect(deriveLevel(rolling, s.state, plusDays(d, 1)).tier.id).toBe('bee');
  });

  it('resets to Пчёлка after 90 days without purchases; shows the date until which it is kept', () => {
    const s = queen();
    const info = level(s, at('2026-01-10 10:00'));
    expect(info.resetsOn).toBe('2026-04-04'); // last purchase 04.01 + 90 days
    expect(s.level(at('2026-04-03 23:59'))).toBe('queen');
    expect(s.level(at('2026-04-04 00:00'))).toBe('bee');
    // the next purchase after the reset counts from scratch: 3 % is gone
    s.buy(100_000, at('2026-04-10 10:00'));
    expect(s.last.purchase!.result).toMatchObject({ cashbackPct: 1, levelAfter: 'bee' });
  });

  it('daily job: reminders 7 and 1 day before the reset, one message on the reset day; separate from мёд expiry', () => {
    const s = queen();
    expect(eventTypes(s.expiry(at('2026-03-27 09:00')))).toEqual([]); // 8 days left
    const w7 = s.expiry(at('2026-03-28 09:00'));
    expect(w7.events).toEqual([{ type: 'level_reset_warning', clientId: 'c1', levelId: 'queen', daysLeft: 7, resetsOn: '2026-04-04' }]);
    expect(eventTypes(s.expiry(at('2026-03-29 09:00')))).toEqual([]);
    expect(s.expiry(at('2026-04-03 09:00')).events[0]).toMatchObject({ type: 'level_reset_warning', daysLeft: 1 });
    const reset = s.expiry(at('2026-04-04 09:00'));
    expect(reset.events).toEqual([{ type: 'level_down', clientId: 'c1', from: 'queen', to: 'bee', reason: 'inactivity' }]);
    expect(reset.ledger).toEqual([]); // мёд stays
    expect(balanceOf(s.state)).toBeGreaterThan(0);
    expect(eventTypes(s.expiry(at('2026-04-05 09:00')))).toEqual([]);
    // мёд: 180 days after the last purchase, reminders 14/7/1 before
    expect(eventTypes(s.expiry(at('2026-06-19 09:00')))).toEqual(['expiry_warning']);
    const burn = s.expiry(at('2026-07-03 09:00'));
    expect(eventTypes(burn)).toEqual(['points_expired']);
    expect(balanceOf(s.state)).toBe(0);
  });

  it('a level reached by a purchase that is then reversed is taken back (stored checkpoints are not trusted)', () => {
    const s = new Sim(ownerRules({ reversalWindowHours: 72 }), at('2026-01-01 09:00'));
    s.buy(100_000, at('2026-01-02 10:00'));
    s.buy(100_000, at('2026-01-03 10:00'));
    s.buy(100_000, at('2026-01-04 10:00'));
    s.buy(100_000, at('2026-01-04 18:00')); // stores stickyLevel 'queen'
    expect(s.level(at('2026-01-04 19:00'))).toBe('queen');
    const o = s.reverse('p1', at('2026-01-04 20:00'));
    expect(eventTypes(o)).toContain('level_down');
    expect(s.level(at('2026-01-04 21:00'))).toBe('bee'); // 2 purchase days remain
    s.buy(100_000, at('2026-01-05 10:00'));
    expect(s.last.purchase!.result).toMatchObject({ levelBefore: 'bee', levelAfter: 'queen', cashbackPct: 1 });
  });
});

describe('welcome bonus 15 000 (Л5) and the 50 % cap', () => {
  it('is credited at registration and spendable on the first order within 50 %', () => {
    const t = at('2026-11-10 10:00');
    let s = emptyClientState('c1', t);
    s = applyOutcome(s, registerClient(R, s, t));
    expect(balanceOf(s)).toBe(15_000);
    expect(maxRedeemable(R, s, flowers(20_000), null, t)).toBe(10_000);
    expect(maxRedeemable(R, s, flowers(100_000), null, t)).toBe(15_000);
    const o = applyPurchase(R, s, { purchaseId: 'p1', idempotencyKey: 'k1', staffId: 's', lines: flowers(100_000), channel: 'store', redeemPoints: 15_000 }, t);
    expect(o.purchase!.result).toMatchObject({ pointsRedeemed: 15_000, paid: 85_000, cashback: 850 });
    expect(() => applyPurchase(R, s, { purchaseId: 'p2', idempotencyKey: 'k2', staffId: 's', lines: flowers(20_000), channel: 'store', redeemPoints: 10_001 }, t)).toThrow(LoyaltyError);
  });

  it('a discount gift and мёд never combine (cap 0 with the gift)', () => {
    const s = new Sim(R, at('2026-01-01 09:00'));
    s.register(at('2026-01-01 09:00'));
    for (let i = 0; i < 10; i++) s.buy(100_000, plusDays(at('2026-01-02 10:00'), i));
    const disc = s.gifts('available').find((g) => g.type === 'discount_pct')!;
    expect(disc).toBeTruthy();
    const now = at('2026-01-20 10:00');
    expect(maxRedeemable(R, s.state, flowers(200_000), disc.id, now)).toBe(0);
    expect(() => s.buy(200_000, now, { useRewardId: disc.id, redeemPoints: 1_000 })).toThrow(/combined/);
  });
});

describe('birthday gift (Л6, Л7)', () => {
  const withBirthday = (birthday: string, from = at('2026-01-01 09:00')): Sim => {
    const s = new Sim(R, from);
    s.state = { ...s.state, birthday };
    return s;
  };

  it('appears 3 days before, valid until 3 days after, once a year', () => {
    const s = withBirthday('1990-11-20');
    expect(eventTypes(s.expiry(at('2026-11-16 09:00')))).toEqual([]);
    const o = s.expiry(at('2026-11-17 00:10'));
    expect(o.events).toEqual([expect.objectContaining({ type: 'birthday_gift', validUntil: '2026-11-23', title: 'Скидка 10% ко дню рождения' })]);
    expect(s.gifts('available')).toEqual([expect.objectContaining({ id: 'bday-2026-c1', type: 'discount_pct', value: 10, validUntil: '2026-11-23' })]);
    expect(eventTypes(s.expiry(at('2026-11-18 09:00')))).toEqual([]); // once
    // after the last day: revoked, and a purchase cannot use it
    const late = at('2026-11-24 10:00');
    expect(() => applyPurchase(R, s.state, { purchaseId: 'x', idempotencyKey: 'x', staffId: 's', lines: flowers(100_000), channel: 'store', useRewardId: 'bday-2026-c1' }, late)).toThrow(/valid until/);
    s.expiry(late);
    expect(s.gifts('revoked').map((g) => g.id)).toEqual(['bday-2026-c1']);
    // next year again
    s.expiry(at('2027-11-17 09:00'));
    expect(s.gifts('available').map((g) => g.id)).toEqual(['bday-2027-c1']);
  });

  it('is a discount: not with мёд; with the cell-10 discount the client picks one and keeps the other', () => {
    const s = withBirthday('1990-02-10');
    s.register(at('2026-01-01 09:00'));
    for (let i = 0; i < 10; i++) s.buy(100_000, plusDays(at('2026-01-02 10:00'), i));
    s.expiry(at('2026-02-08 09:00'));
    const avail = s.gifts('available');
    const bday = avail.find((g) => g.id.startsWith('bday-'))!;
    const cell = avail.find((g) => g.cell === 10)!;
    expect(bday && cell).toBeTruthy();
    expect(() => s.buy(100_000, at('2026-02-09 10:00'), { useRewardId: bday.id, redeemPoints: 500 })).toThrow(/combined/);
    s.buy(100_000, at('2026-02-09 10:00'), { useRewardId: bday.id });
    expect(s.last.purchase!.result!.discountApplied).toBe(10_000);
    expect(s.gifts('available').map((g) => g.id)).toContain(cell.id);
  });

  it('window across the new year; 29 February', () => {
    expect(birthdayWindow(R, '2000-01-01', at('2026-12-30 10:00'))).toMatchObject({ year: 2027, from: '2026-12-29', until: '2027-01-04', current: true });
    expect(birthdayWindow(R, '2000-02-29', at('2027-02-20 10:00'))).toMatchObject({ birthday: '2027-02-28', from: '2027-02-25', current: false });
    expect(birthdayWindow(R, '2000-02-29', at('2028-02-27 10:00'))).toMatchObject({ birthday: '2028-02-29', current: true });
    expect(birthdayWindow({ ...R, birthdayReward: { ...R.birthdayReward, enabled: false } }, '2000-01-01', at('2026-12-30 10:00'))).toBeNull();
    expect(birthdayWindow(R, 'garbage', at('2026-12-30 10:00'))).toBeNull();
  });
});

/**
 * Independent model of the sticky level (no checkpoints): replay ALL active purchases. The engine's
 * checkpoint derivation must agree on random histories with reversals.
 */
function modelLevel(rules: LoyaltyRules, s: ClientState, now: Date): number {
  const tz = rules.timezone;
  const active = s.purchases.filter((p) => p.status === 'active' && p.createdAt <= now).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const tierFor = (n: number) => rules.levels.tiers.reduce((idx, t, i) => (n >= t.threshold ? i : idx), 0);
  let idx = 0;
  let anchor: Date | null = null;
  for (const p of active) {
    if (anchor && calendarDaysBetween(anchor, p.createdAt, tz) >= 90) idx = 0;
    const d = localDayNumber(p.createdAt, tz);
    const days = new Set(active.filter((q) => q.createdAt <= p.createdAt && localDayNumber(q.createdAt, tz) > d - 90).map((q) => localDateKey(q.createdAt, tz)));
    idx = Math.max(idx, tierFor(days.size));
    anchor = p.createdAt;
  }
  if (anchor && calendarDaysBetween(anchor, now, tz) >= 90) idx = 0;
  return idx;
}

describe('sticky level == independent model on random histories', () => {
  it('80 histories × 40 commands', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let h = 0; h < 80; h++) {
      const s = new Sim(R, at('2026-01-01 09:00'));
      let now = at('2026-01-01 10:00');
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = rnd();
        now = new Date(now.getTime() + (r < 0.3 ? 2 * 3_600_000 : r < 0.85 ? Math.floor(rnd() * 12) * 86_400_000 + 3_600_000 : Math.floor(60 + rnd() * 60) * 86_400_000));
        if (rnd() < 0.75 || !ids.length) {
          s.buy(10_000 + Math.floor(rnd() * 5) * 50_000, now);
          ids.push(s.last.purchase!.id);
        } else {
          try {
            s.reverse(ids[Math.floor(rnd() * ids.length)]!, now);
          } catch {
            /* outside the window / spent: refused */
          }
        }
        for (const t of [now, plusDays(now, 30), plusDays(now, 89), plusDays(now, 91)]) {
          expect(deriveLevel(R, s.state, t).index, `history ${h} step ${i}`).toBe(modelLevel(R, s.state, t));
        }
      }
    }
  }, 120_000);
});

describe('runExpiry combines the three timers', () => {
  it('nothing to do for a fresh client', () => {
    const s = new Sim(R, at('2026-01-01 09:00'));
    expect(runExpiry(R, s.state, at('2026-01-02 09:00')).events).toEqual([]);
  });
});
