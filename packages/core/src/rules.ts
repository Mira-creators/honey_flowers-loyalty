import { z } from 'zod';
import { CATEGORIES, REWARD_TYPES } from './types.js';

/**
 * Loyalty rules: every number the business may change lives here.
 * Rules are versioned (`version`) and stored as JSON in `rules_versions`;
 * each purchase records the version it was computed with.
 *
 * Use `parseRules()` to validate untrusted JSON (admin panel, DB).
 */

const uzs = z.number().int().nonnegative();
const pct = z.number().min(0).max(100);

export const levelTierSchema = z.object({
  /** Stable id used in storage (level_override) and events. */
  id: z.string().min(1),
  /** Display name, e.g. "Пчёлка". */
  title: z.string().min(1),
  /** Cashback percent for purchases made while on this level. */
  cashbackPct: pct,
  /**
   * Minimum metric value to reach this level: UZS when criterion = 'sum',
   * number of purchases when criterion = 'count'. The first tier must be 0.
   */
  threshold: z.number().int().nonnegative(),
});

export const cellRewardSchema = z.object({
  cell: z.number().int().positive(),
  type: z.enum(REWARD_TYPES),
  value: z.number().nonnegative().optional(),
  title: z.string().min(1),
});

export const loyaltyRulesSchema = z
  .object({
    /** Monotonic rules version; bump on every change. */
    version: z.number().int().positive(),
    /** IANA time zone for calendar-day logic (daily limits, expiry dates). */
    timezone: z.string().min(1),
    /** UI languages offered to clients. */
    languages: z.array(z.enum(['ru', 'uz', 'en'])).min(1),

    levels: z.object({
      /** 'sum' = total purchase amount, 'count' = number of purchases. */
      criterion: z.enum(['sum', 'count']),
      /** null = all time; N = only purchases of the last N calendar months. */
      windowMonths: z.number().int().positive().nullable(),
      /** Ascending by threshold; first tier has threshold 0. */
      tiers: z.array(levelTierSchema).min(1),
    }),

    /** Share of the order amount (percent) that may be paid with points. */
    maxRedeemPct: pct,
    /** May a discount reward (discount_pct) be combined with points in one order? */
    allowDiscountWithPoints: z.boolean(),
    /** Points credited once at registration. 0 disables. */
    welcomeBonus: uzs,
    /** Cashback is accrued only on purchase lines of enabled categories. */
    cashbackCategories: z.object({
      flowers: z.boolean(),
      delivery: z.boolean(),
      cards: z.boolean(),
      wedding: z.boolean(),
    }),

    honeycomb: z.object({
      /** Number of cells on one card. */
      cells: z.number().int().min(1).max(50),
      /** Rewards placed into cells; cells without a reward are plain steps. */
      rewards: z.array(cellRewardSchema),
      /** Minimum purchase amount (UZS) that advances the card. */
      minPurchaseForCell: uzs,
      /** Max purchases per client per calendar day that advance the card. */
      maxCellsPerDay: z.number().int().positive(),
      /** After the last cell: same card again, or a different card. */
      afterLastCell: z.enum(['restart', 'new_card']),
      /** Rewards of cards #2+ when afterLastCell = 'new_card'. */
      nextCardRewards: z.array(cellRewardSchema).optional(),
    }),

    expiry: z.object({
      /** Points expire after this many calendar days without a purchase. */
      expiryDays: z.number().int().positive(),
      /** Send reminders this many days before expiry. */
      expiryWarnDays: z.array(z.number().int().positive()),
      /** What burns on expiry. */
      onExpiry: z.enum(['balance_only', 'balance_and_level_down', 'reset_all']),
    }),

    /** STUB: not used by the engine yet (questionnaire Q16). */
    birthdayReward: z.object({
      enabled: z.boolean(),
      type: z.enum(['points', 'discount_pct', 'custom']),
      value: z.number().nonnegative(),
      daysBefore: z.number().int().nonnegative(),
      daysAfter: z.number().int().nonnegative(),
    }),
  })
  .superRefine((r, ctx) => {
    const tiers = r.levels.tiers;
    if (tiers[0] && tiers[0].threshold !== 0) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'tiers', 0, 'threshold'], message: 'first tier must have threshold 0' });
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i]!.threshold <= tiers[i - 1]!.threshold) {
        ctx.addIssue({ code: 'custom', path: ['levels', 'tiers', i, 'threshold'], message: 'thresholds must be strictly ascending' });
      }
    }
    if (new Set(tiers.map((t) => t.id)).size !== tiers.length) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'tiers'], message: 'tier ids must be unique' });
    }
    const checkRewards = (list: { cell: number }[], key: string) => {
      const seen = new Set<number>();
      list.forEach((rw, i) => {
        if (rw.cell > r.honeycomb.cells) {
          ctx.addIssue({ code: 'custom', path: ['honeycomb', key, i, 'cell'], message: `cell must be <= ${r.honeycomb.cells}` });
        }
        if (seen.has(rw.cell)) {
          ctx.addIssue({ code: 'custom', path: ['honeycomb', key, i, 'cell'], message: 'duplicate cell' });
        }
        seen.add(rw.cell);
      });
    };
    checkRewards(r.honeycomb.rewards, 'rewards');
    if (r.honeycomb.nextCardRewards) checkRewards(r.honeycomb.nextCardRewards, 'nextCardRewards');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: r.timezone });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'unknown IANA time zone' });
    }
  });

export type LoyaltyRules = z.infer<typeof loyaltyRulesSchema>;
export type LevelTier = z.infer<typeof levelTierSchema>;

/** Validate untrusted rules JSON. Throws a ZodError with readable paths. */
export function parseRules(input: unknown): LoyaltyRules {
  return loyaltyRulesSchema.parse(input);
}

export { CATEGORIES };
