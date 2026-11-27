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
/** Percent with at most 2 decimals (0.01% steps): anything finer would be rounded by the money math. */
const pct = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, { message: 'at most 2 decimals' });

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

export const cellRewardSchema = z
  .object({
    cell: z.number().int().positive(),
    type: z.enum(REWARD_TYPES),
    /** discount_pct: percent (<= 100, 2 decimals); free_*: integer cap in UZS. */
    value: z.number().nonnegative().optional(),
    title: z.string().min(1),
  })
  .superRefine((r, ctx) => {
    if (r.value === undefined) return;
    if (r.type === 'discount_pct') {
      if (r.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'discount cannot exceed 100%' });
      if (Math.abs(r.value * 100 - Math.round(r.value * 100)) > 1e-9) ctx.addIssue({ code: 'custom', path: ['value'], message: 'at most 2 decimals' });
    } else if (!Number.isSafeInteger(r.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'cap must be an integer amount in UZS' });
    }
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
      /**
       * null = no day window; N = only purchases of the last N LOCAL calendar days, today included
       * (90 = "за последние 90 дней"). Mutually exclusive with windowMonths.
       */
      windowDays: z.number().int().positive().max(3650).nullable().default(null),
      /**
       * criterion 'count' only: at most ONE purchase per local calendar day counts ("все заказы за
       * день — один заказ"). Requires a window (windowDays / windowMonths).
       */
      oncePerDay: z.boolean().default(false),
      /**
       * 'rolling' (the old behaviour): the level is always what the metric gives right now, so it can
       *   drop as old purchases leave the window.
       * 'sticky' (owner decision Л1): the level RISES at a purchase when the metric reaches a threshold
       *   and never drops while the client keeps buying; after `resetAfterDays` local days without a
       *   purchase it resets to the first tier. A separate timer from мёд expiry.
       */
      mode: z.enum(['rolling', 'sticky']).default('rolling'),
      /** sticky: days without purchases after which the level resets to the first tier (required). */
      resetAfterDays: z.number().int().positive().max(3650).nullable().default(null),
      /** sticky: remind the client this many days before the level resets. */
      resetWarnDays: z.array(z.number().int().positive()).default([]),
      /** Ascending by threshold; first tier has threshold 0. */
      tiers: z.array(levelTierSchema).min(1),
    }),

    /** Share of the order amount (percent) that may be paid with points. */
    maxRedeemPct: pct,
    /** Largest purchase amount (UZS) the engine accepts; protects against typos. Defaults for rules stored before it existed. */
    maxPurchaseAmount: uzs.positive().default(100_000_000),
    /**
     * Staff may reverse a purchase only within this many hours of it (owner decision: a reversal
     * corrects a mistake at the till, it is not a refund). 1..720; rules stored before it existed get 24.
     */
    reversalWindowHours: z.number().int().min(1).max(720).default(24),
    /**
     * Owner switch «Сотрудники могут отменять покупки» (Л8). true: florists / managers and the owner
     * may reverse (within reversalWindowHours); false: only the owner. Rules stored before it existed get true.
     */
    staffCanReverse: z.boolean().default(true),
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

    /**
     * Birthday gift (Л6, commands/birthday.ts): a gift appears `daysBefore` local days before the
     * client's birthday and is valid until `daysAfter` days after it, once per year. 'discount_pct'
     * (value = percent) and 'custom' (handed over) are supported; 'points' is reserved (not used).
     */
    birthdayReward: z.object({
      enabled: z.boolean(),
      type: z.enum(['points', 'discount_pct', 'custom']),
      value: z.number().nonnegative(),
      daysBefore: z.number().int().nonnegative().max(60),
      daysAfter: z.number().int().nonnegative().max(60),
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
    const lv = r.levels;
    if (lv.windowDays !== null && lv.windowMonths !== null) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'windowDays'], message: 'use either windowDays or windowMonths' });
    }
    if (lv.oncePerDay && lv.criterion === 'count' && lv.windowDays === null && lv.windowMonths === null) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'oncePerDay'], message: 'oncePerDay needs a level window (windowDays or windowMonths)' });
    }
    if (lv.mode === 'sticky' && lv.resetAfterDays === null) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'resetAfterDays'], message: 'sticky levels need resetAfterDays' });
    }
    if (lv.resetAfterDays !== null && lv.resetWarnDays.some((d) => d >= lv.resetAfterDays!)) {
      ctx.addIssue({ code: 'custom', path: ['levels', 'resetWarnDays'], message: 'a reminder must come before the reset' });
    }
    if (r.birthdayReward.enabled && r.birthdayReward.type === 'discount_pct' && (r.birthdayReward.value <= 0 || r.birthdayReward.value > 100)) {
      ctx.addIssue({ code: 'custom', path: ['birthdayReward', 'value'], message: 'birthday discount must be 0 < value <= 100' });
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
