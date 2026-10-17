import { describe, expect, it } from 'vitest';
import { defaultRules, loyaltyRulesSchema, parseRules } from '../src/index.js';
import { makeRules } from './helpers.js';

describe('rules config', () => {
  it('default rules pass schema validation', () => {
    expect(() => parseRules(defaultRules)).not.toThrow();
    expect(defaultRules.levels.tiers.map((t) => t.cashbackPct)).toEqual([1, 3, 5]);
    expect(defaultRules.honeycomb.cells).toBe(10);
  });

  it('rejects a first tier with a non-zero threshold', () => {
    const bad = structuredClone(defaultRules);
    bad.levels.tiers[0]!.threshold = 10;
    expect(loyaltyRulesSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-ascending thresholds', () => {
    const bad = structuredClone(defaultRules);
    bad.levels.tiers[2]!.threshold = 1_000_000;
    expect(loyaltyRulesSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a reward placed outside the card or two rewards in one cell', () => {
    const outside = structuredClone(defaultRules);
    outside.honeycomb.rewards.push({ cell: 11, type: 'custom', title: 'x' });
    expect(loyaltyRulesSchema.safeParse(outside).success).toBe(false);
    const dup = structuredClone(defaultRules);
    dup.honeycomb.rewards.push({ cell: 3, type: 'custom', title: 'x' });
    expect(loyaltyRulesSchema.safeParse(dup).success).toBe(false);
  });

  it('rejects an unknown time zone and a redeem percent above 100', () => {
    expect(() => makeRules({ timezone: 'Mars/Olympus' })).toThrow();
    expect(() => makeRules({ maxRedeemPct: 120 })).toThrow();
  });
});
