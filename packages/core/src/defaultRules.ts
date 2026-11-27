import type { LoyaltyRules } from './rules.js';

/**
 * Rules of Honey Flowers from the owner's questionnaire (10 Nov 2026) and the chosen defaults of
 * docs/Спорные вопросы.md (Л1–Л12). Each field names the questionnaire question (Q#) or the
 * disputed-question id (Л#) that decides it. Fields marked "ours" are technical.
 *
 * apps/worker seeds a fresh database with these rules (version 1); migration 0011 switches a
 * database that still runs RULES_V1_PLACEHOLDER to them (as a new version, never over owner edits).
 * Keep apps/worker/migrations/0011_owner_rules.sql in sync (a test compares them).
 */
export const defaultRules: LoyaltyRules = {
  // ours: bump on every change; purchases store the version they used.
  version: 1,
  // ours: the shop works in Tashkent; calendar days are counted here.
  timezone: 'Asia/Tashkent',
  // Q20: русский → узбекский (латиница) → английский (later).
  languages: ['ru', 'uz'],

  // Q6/Q7 + Л1/Л2: one mechanic — levels by the NUMBER of purchases in the last 90 days, at most one
  // counted purchase per Tashkent day (any amount). Sticky: the level rises at a purchase, is kept
  // while the client buys at least once per 90 days, and resets to Пчёлка after 90 days without one.
  levels: {
    criterion: 'count',
    windowMonths: null,
    windowDays: 90,
    oncePerDay: true,
    mode: 'sticky',
    resetAfterDays: 90,
    // Л3: level-reset reminders 7 and 1 day before.
    resetWarnDays: [7, 1],
    // Q23 / Л12: Пчёлка 1 % · Королева улья 3 % (3 purchases) · Золотой мёд 5 % (10 purchases).
    tiers: [
      { id: 'bee', title: 'Пчёлка', cashbackPct: 1, threshold: 0 },
      { id: 'queen', title: 'Королева улья', cashbackPct: 3, threshold: 3 },
      { id: 'gold', title: 'Золотой мёд', cashbackPct: 5, threshold: 10 },
    ],
  },

  // Q8: up to 50 % of an order may be paid with мёд.
  maxRedeemPct: 50,
  // ours (antifraud / typo guard): a single purchase cannot exceed this amount.
  maxPurchaseAmount: 100_000_000,
  // Л8: staff may reverse a purchase within 24 h (and only if its мёд and gift are unused).
  reversalWindowHours: 24,
  // Л8: «Сотрудники могут отменять покупки» — on by default, the owner switches it off in «Правила».
  staffCanReverse: true,
  // Q11: the 10 % discount and мёд are never combined in one order.
  allowDiscountWithPoints: false,
  // Q12 / Л5: 15 000 мёда after registration, spendable at once (within the 50 % cap).
  welcomeBonus: 15_000,
  // Q9 / Л10: cashback on everything except delivery.
  cashbackCategories: {
    flowers: true,
    delivery: false,
    cards: true,
    wedding: true,
  },

  honeycomb: {
    // ours: a card of 10 purchases.
    cells: 10,
    // Q13: 3 — открытка, 6 — бесплатная доставка, 10 — скидка 10 %.
    rewards: [
      { cell: 3, type: 'free_card', title: 'Открытка в подарок' },
      { cell: 6, type: 'free_delivery', title: 'Бесплатная доставка' },
      { cell: 10, type: 'discount_pct', value: 10, title: 'Скидка 10% на следующий заказ' },
    ],
    // Q14: no minimum amount.
    minPurchaseForCell: 0,
    // Q14 / Л2: all orders of a day are one purchase on the card.
    maxCellsPerDay: 1,
    // Q15 / Л11: after the 10th cell — a new cycle with the same gifts.
    afterLastCell: 'restart',
    nextCardRewards: undefined,
  },

  expiry: {
    // Q10 / Л4: мёд burns after 180 days (6 months) without purchases; only the balance.
    expiryDays: 180,
    // Л3: reminders 14, 7 and 1 day before.
    expiryWarnDays: [14, 7, 1],
    onExpiry: 'balance_only',
  },

  // Q16 / Л6: −10 % from 3 days before to 3 days after the birthday, once a year.
  birthdayReward: {
    enabled: true,
    type: 'discount_pct',
    value: 10,
    daysBefore: 3,
    daysAfter: 3,
  },
};

/**
 * The placeholder rules the prototype ran with before the questionnaire (version 1 of existing
 * databases): levels by purchase SUM over all time (2 000 000 / 6 000 000 сум), мёд burns after
 * 90 days, a cell from 100 000 сум, no welcome bonus, no birthday gift. Kept for migration 0011
 * (it replaces exactly these rules) and as the baseline of the engine's older unit tests.
 */
export const RULES_V1_PLACEHOLDER: LoyaltyRules = {
  version: 1,
  timezone: 'Asia/Tashkent',
  languages: ['ru', 'uz'],
  levels: {
    criterion: 'sum',
    windowMonths: null,
    windowDays: null,
    oncePerDay: false,
    mode: 'rolling',
    resetAfterDays: null,
    resetWarnDays: [],
    tiers: [
      { id: 'bee', title: 'Пчёлка', cashbackPct: 1, threshold: 0 },
      { id: 'honey', title: 'Медовая', cashbackPct: 3, threshold: 2_000_000 },
      { id: 'queen', title: 'Королева улья', cashbackPct: 5, threshold: 6_000_000 },
    ],
  },
  maxRedeemPct: 50,
  maxPurchaseAmount: 100_000_000,
  reversalWindowHours: 24,
  staffCanReverse: true,
  allowDiscountWithPoints: false,
  welcomeBonus: 0,
  cashbackCategories: { flowers: true, delivery: false, cards: true, wedding: true },
  honeycomb: {
    cells: 10,
    rewards: [
      { cell: 3, type: 'free_card', title: 'Открытка в подарок' },
      { cell: 6, type: 'free_delivery', title: 'Бесплатная доставка' },
      { cell: 10, type: 'discount_pct', value: 10, title: 'Скидка 10% на следующий заказ' },
    ],
    minPurchaseForCell: 100_000,
    maxCellsPerDay: 1,
    afterLastCell: 'restart',
    nextCardRewards: undefined,
  },
  expiry: { expiryDays: 90, expiryWarnDays: [14, 7, 1], onExpiry: 'balance_only' },
  birthdayReward: { enabled: false, type: 'discount_pct', value: 10, daysBefore: 3, daysAfter: 3 },
};
