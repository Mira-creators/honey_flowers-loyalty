import type { LoyaltyRules } from './rules.js';

/**
 * Default ("placeholder") rules until Honey Flowers answers the questionnaire
 * (brief of 17 Oct 2026, section 5 "Анкета"). Each field names the question
 * number (Q#) whose answer decides it. Fields marked "ours" are technical.
 */
export const defaultRules: LoyaltyRules = {
  // ours: bump on every change; purchases store the version they used.
  version: 1,
  // ours: the shop works in Tashkent; calendar days are counted here.
  timezone: 'Asia/Tashkent',
  // Q20: app languages (русский / узбекский латиница / английский).
  languages: ['ru', 'uz'],

  // Q6: one mechanic — levels with cashback 1% → 3% → 5% (our recommendation).
  levels: {
    // Q7: level by purchase sum or by purchase count.
    criterion: 'sum',
    // Q7: "за всё время" (null) or "за последние N месяцев".
    windowMonths: null,
    // Q7: thresholds for 3% and 5% (placeholders, depend on Q3 average check).
    // Q23: names of levels.
    tiers: [
      { id: 'bee', title: 'Пчёлка', cashbackPct: 1, threshold: 0 },
      { id: 'honey', title: 'Медовая', cashbackPct: 3, threshold: 2_000_000 },
      { id: 'queen', title: 'Королева улья', cashbackPct: 5, threshold: 6_000_000 },
    ],
  },

  // Q8: how much of an order may be paid with мёд (30% / 50% / no limit=100).
  maxRedeemPct: 50,
  // ours (antifraud / typo guard): a single purchase cannot exceed this amount.
  maxPurchaseAmount: 100_000_000,
  // Owner decision: a purchase can be reversed by staff only within N hours (and only if its мёд
  // and gift are unused), see commands/reverse.ts.
  reversalWindowHours: 24,
  // Q11: may the 10% discount and мёд be used in the same order.
  allowDiscountWithPoints: false,
  // Q12: welcome bonus at registration, сум (0 = no bonus).
  welcomeBonus: 0,
  // Q9: which categories earn cashback.
  cashbackCategories: {
    flowers: true,
    delivery: false,
    cards: true,
    wedding: true,
  },

  honeycomb: {
    // ours (brief section 2): a card of 10 purchases.
    cells: 10,
    // Q13: which gift sits in which cell (example from the client's ideas).
    rewards: [
      { cell: 3, type: 'free_card', title: 'Открытка в подарок' },
      { cell: 6, type: 'free_delivery', title: 'Бесплатная доставка' },
      { cell: 10, type: 'discount_pct', value: 10, title: 'Скидка 10% на следующий заказ' },
    ],
    // Q14: minimum order amount that counts as a purchase on the card (placeholder).
    minPurchaseForCell: 100_000,
    // ours (antifraud): at most one card step per client per day.
    maxCellsPerDay: 1,
    // Q15: after the 10th purchase — same card again or a new card with other gifts.
    afterLastCell: 'restart',
    // Q15: gifts of the new card if 'new_card' is chosen (unset = same as rewards).
    nextCardRewards: undefined,
  },

  expiry: {
    // Q10 / brief: мёд burns after 3 months (90 days) without purchases.
    expiryDays: 90,
    // brief: reminders 14, 7 and 1 day before.
    expiryWarnDays: [14, 7, 1],
    // Q10: only мёд / мёд + one level down / everything.
    onExpiry: 'balance_only',
  },

  // Q16: birthday gift (stub — not implemented in the engine yet).
  birthdayReward: {
    enabled: false,
    type: 'discount_pct',
    value: 10,
    daysBefore: 3,
    daysAfter: 3,
  },
};
