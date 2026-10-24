import type { EditableRulesDTO } from '@honey/contracts';
import { parseRules, type LoyaltyRules } from '@honey/core';
import { z } from 'zod';
import { GIFT_CODE_RE, giftLayout, rewardFromCode } from './gifts.js';
import { HttpError } from './errors.js';

/** Owner rules editor: LoyaltyRules ⇄ EditableRulesDTO (packages/contracts). */

export function toEditable(rules: LoyaltyRules): EditableRulesDTO {
  return {
    levels: rules.levels.tiers.map((t) => ({ id: t.id, name: t.title, pct: t.cashbackPct, from: t.threshold })),
    minPurchaseForCell: rules.honeycomb.minPurchaseForCell,
    maxCellsPerDay: rules.honeycomb.maxCellsPerDay,
    maxRedeemPct: rules.maxRedeemPct,
    expiryDays: rules.expiry.expiryDays,
    expiryWarnDays: [...rules.expiry.expiryWarnDays].sort((a, b) => b - a),
    welcomeBonus: rules.welcomeBonus,
    reversalWindowHours: rules.reversalWindowHours,
    cells: rules.honeycomb.cells,
    gifts: giftLayout(rules.honeycomb.rewards),
    version: rules.version,
  };
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const editableRulesSchema = z
  .object({
    levels: z
      .array(
        z.object({
          id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, 'латиница/цифры, до 32 символов'),
          name: z.string().trim().min(1).max(40),
          pct: z.number().min(0).max(100),
          from: int(0, 1_000_000_000_000),
        }),
      )
      .min(1)
      .max(5),
    minPurchaseForCell: int(0, 1_000_000_000),
    maxCellsPerDay: int(1, 10),
    maxRedeemPct: z.number().min(0).max(100),
    expiryDays: int(1, 3650),
    expiryWarnDays: z.array(int(1, 365)).max(5),
    welcomeBonus: int(0, 100_000_000),
    // Owner decision (item 8): staff may reverse a purchase only within N hours. Older Mini App builds
    // do not send it: keep the current value then.
    reversalWindowHours: int(1, 720).optional(),
    cells: int(1, 50),
    gifts: z.record(z.string().regex(/^\d{1,2}$/), z.string().regex(GIFT_CODE_RE, 'card | delivery | mini | discN')),
    version: z.number().int().positive(),
  })
  .superRefine((r, ctx) => {
    if (r.levels[0] && r.levels[0].from !== 0) {
      ctx.addIssue({ code: 'custom', path: ['levels', 0, 'from'], message: 'первый уровень должен начинаться с 0' });
    }
    for (let i = 1; i < r.levels.length; i++) {
      if (r.levels[i]!.from <= r.levels[i - 1]!.from) {
        ctx.addIssue({ code: 'custom', path: ['levels', i, 'from'], message: 'пороги уровней должны расти' });
      }
    }
    if (new Set(r.levels.map((l) => l.id)).size !== r.levels.length) {
      ctx.addIssue({ code: 'custom', path: ['levels'], message: 'id уровней должны быть разными' });
    }
    for (const cell of Object.keys(r.gifts)) {
      const n = Number(cell);
      if (n < 1 || n > r.cells) ctx.addIssue({ code: 'custom', path: ['gifts', cell], message: `ячейка должна быть от 1 до ${r.cells}` });
    }
    if (new Set(r.expiryWarnDays).size !== r.expiryWarnDays.length) {
      ctx.addIssue({ code: 'custom', path: ['expiryWarnDays'], message: 'дни напоминаний повторяются' });
    }
    if (r.expiryWarnDays.some((d) => d >= r.expiryDays)) {
      ctx.addIssue({ code: 'custom', path: ['expiryWarnDays'], message: 'напоминание должно быть раньше срока сгорания' });
    }
  });

/**
 * Build the next rules version from the current one and an edited DTO.
 * Throws 409 if the DTO was based on an older version (someone saved meanwhile).
 */
export function applyEditable(current: LoyaltyRules, input: unknown): LoyaltyRules {
  const e = editableRulesSchema.parse(input);
  if (e.version !== current.version) {
    throw new HttpError(409, 'conflict', `Правила уже изменены (сейчас версия ${current.version}), обновите страницу`);
  }
  if (e.cells !== current.honeycomb.cells) {
    throw new HttpError(400, 'validation', `Количество ячеек пока фиксировано: ${current.honeycomb.cells}`);
  }
  const next: LoyaltyRules = {
    ...current,
    version: current.version + 1,
    levels: {
      ...current.levels,
      tiers: e.levels.map((l) => ({ id: l.id, title: l.name, cashbackPct: l.pct, threshold: l.from })),
    },
    maxRedeemPct: e.maxRedeemPct,
    welcomeBonus: e.welcomeBonus,
    reversalWindowHours: e.reversalWindowHours ?? current.reversalWindowHours,
    honeycomb: {
      ...current.honeycomb,
      minPurchaseForCell: e.minPurchaseForCell,
      maxCellsPerDay: e.maxCellsPerDay,
      rewards: Object.entries(e.gifts)
        .map(([cell, code]) => rewardFromCode(Number(cell), code))
        .sort((a, b) => a.cell - b.cell),
    },
    expiry: {
      ...current.expiry,
      expiryDays: e.expiryDays,
      expiryWarnDays: [...e.expiryWarnDays].sort((a, b) => b - a),
    },
  };
  // Final check with the engine's own schema (same rules as packages/core).
  return parseRules(JSON.parse(JSON.stringify(next)));
}
