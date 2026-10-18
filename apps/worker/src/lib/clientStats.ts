import {
  activePurchases,
  availableRewards,
  balanceFromLedger,
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
}

export function computeClientStats(rules: LoyaltyRules, state: ClientState, now: Date): ClientStats {
  const balance = balanceFromLedger(state.ledger);
  const level = deriveLevel(rules, state, now);
  const active = activePurchases(state);
  let last = '';
  for (const p of active) {
    const at = p.createdAt.toISOString();
    if (at > last) last = at;
  }
  const exp = expiryInfo(rules, state, now);
  return {
    balance,
    spent: level.metric,
    purchasesCount: active.length,
    lastPurchaseAt: last,
    levelId: level.tier.id,
    giftsAvailable: availableRewards(state).length,
    activityAt: exp.anchor.toISOString(),
    expiresOn: balance > 0 ? keyFromDayNumber(dayNumberFromKey(exp.expiresOn) - 1) : '',
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
    a.expiresOn === b.expiresOn
  );
}
