import {
  activePurchaseCount,
  activePurchases,
  availableGiftCount,
  balanceOf,
  levelTotals,
  dayNumberFromKey,
  deriveLevel,
  expiryInfo,
  keyFromDayNumber,
  type ClientState,
  type LoyaltyRules,
} from '@honey/core';

/**
 * One row of client_stats (migration 0004): the engine-derived summary of a client
 * that the owner's list, filters, sorts and CSV export read instead of the ledger.
 * Computed with the SAME core functions as the client card (lib/dto.ts), from the
 * state after an outcome, and written in the same batch as the outcome itself.
 */
export interface ClientStats {
  balance: number;
  spent: number;
  purchasesCount: number;
  /** ISO instant of the last active purchase, '' = never (so DESC sorts "never" last). */
  lastPurchaseAt: string;
  levelId: string;
  giftsAvailable: number;
  /** Expiry anchor (core activityAnchor) as ISO: lets a rules change recompute expiresOn in SQL. */
  activityAt: string;
  /** Last day the balance is valid (YYYY-MM-DD, Tashkent), '' when the balance is not positive. */
  expiresOn: string;
  /**
   * All-time level totals (core levelTotals): active purchases at/after the level override.
   * With balance and purchasesCount they let D1Repository load a BOUNDED state (migration 0010).
   */
  levelSum: number;
  levelCount: number;
}

export function computeClientStats(rules: LoyaltyRules, state: ClientState, now: Date): ClientStats {
  const balance = balanceOf(state);
  const level = deriveLevel(rules, state, now);
  const totals = levelTotals(state);
  // A bounded state always carries the latest active purchases (D1Repository), so the max is exact.
  let last = '';
  for (const p of activePurchases(state)) {
    const at = p.createdAt.toISOString();
    if (at > last) last = at;
  }
  const exp = expiryInfo(rules, state, now);
  return {
    balance,
    spent: level.metric,
    purchasesCount: activePurchaseCount(state),
    lastPurchaseAt: last,
    levelId: level.tier.id,
    giftsAvailable: availableGiftCount(state),
    activityAt: exp.anchor.toISOString(),
    expiresOn: balance > 0 ? keyFromDayNumber(dayNumberFromKey(exp.expiresOn) - 1) : '',
    levelSum: totals.sum,
    levelCount: totals.count,
  };
}

export function sameStats(a: ClientStats, b: ClientStats): boolean {
  return (
    a.balance === b.balance &&
    a.spent === b.spent &&
    a.purchasesCount === b.purchasesCount &&
    a.lastPurchaseAt === b.lastPurchaseAt &&
    a.levelId === b.levelId &&
    a.giftsAvailable === b.giftsAvailable &&
    a.activityAt === b.activityAt &&
    a.expiresOn === b.expiresOn &&
    a.levelSum === b.levelSum &&
    a.levelCount === b.levelCount
  );
}
