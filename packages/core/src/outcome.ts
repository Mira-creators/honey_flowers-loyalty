import type { LoyaltyEvent } from './events.js';
import type { CardMove, ClientState, LedgerEntry, LevelOverride, PurchaseRecord, Reward } from './types.js';

/**
 * Result of every command. It lists the facts to persist (in one DB
 * transaction) and the notifications to send. Commands never mutate input.
 */
export interface Outcome {
  /** True when an idempotent replay returned a previous result: nothing to persist. */
  replayed: boolean;
  /** New ledger rows. */
  ledger: LedgerEntry[];
  /** New card moves. */
  cardMoves: CardMove[];
  /** Existing card moves to mark as reverted (matched by purchaseId + cycle + cell). */
  cardMovesReverted: CardMove[];
  /** Newly unlocked rewards. */
  rewardsUnlocked: Reward[];
  /** Existing rewards whose status changed (full new value). */
  rewardsUpdated: Reward[];
  /** New or updated purchase record. */
  purchase: PurchaseRecord | null;
  /** undefined = unchanged; null = cleared; object = new override. */
  levelOverride?: LevelOverride | null;
  levelChange: { from: string; to: string } | null;
  events: LoyaltyEvent[];
  /** Dedupe keys of notifications emitted (persist to notifications_log). */
  notificationKeys: string[];
  /** Non-fatal issues for staff, e.g. a reversed purchase whose gift was already used. */
  warnings: string[];
}

export function emptyOutcome(): Outcome {
  return {
    replayed: false,
    ledger: [],
    cardMoves: [],
    cardMovesReverted: [],
    rewardsUnlocked: [],
    rewardsUpdated: [],
    purchase: null,
    levelChange: null,
    events: [],
    notificationKeys: [],
    warnings: [],
  };
}

/** Concatenate two outcomes (b happened after a). */
export function mergeOutcomes(a: Outcome, b: Outcome): Outcome {
  return {
    replayed: a.replayed && b.replayed,
    ledger: [...a.ledger, ...b.ledger],
    cardMoves: [...a.cardMoves, ...b.cardMoves],
    cardMovesReverted: [...a.cardMovesReverted, ...b.cardMovesReverted],
    rewardsUnlocked: [...a.rewardsUnlocked, ...b.rewardsUnlocked],
    rewardsUpdated: [...a.rewardsUpdated, ...b.rewardsUpdated],
    purchase: b.purchase ?? a.purchase,
    levelOverride: b.levelOverride !== undefined ? b.levelOverride : a.levelOverride,
    levelChange: b.levelChange ?? a.levelChange,
    events: [...a.events, ...b.events],
    notificationKeys: [...a.notificationKeys, ...b.notificationKeys],
    warnings: [...a.warnings, ...b.warnings],
  };
}

function sameMove(a: CardMove, b: CardMove): boolean {
  return a.purchaseId === b.purchaseId && a.cycle === b.cycle && a.cell === b.cell && a.reason === b.reason;
}

/**
 * Apply an outcome to a state snapshot and return the new snapshot.
 * Used by the in-memory repository and by tests; the Postgres repository
 * should persist the same facts as SQL rows instead.
 */
export function applyOutcome(state: ClientState, o: Outcome): ClientState {
  if (o.replayed) return state;
  const rewardUpdates = new Map(o.rewardsUpdated.map((r) => [r.id, r]));
  let purchases = state.purchases;
  if (o.purchase) {
    const exists = purchases.some((p) => p.id === o.purchase!.id);
    purchases = exists
      ? purchases.map((p) => (p.id === o.purchase!.id ? o.purchase! : p))
      : [...purchases, o.purchase];
  }
  const cardMoves = state.cardMoves.map((m) => {
    const rev = o.cardMovesReverted.find((r) => sameMove(r, m) && !m.revertedAt);
    return rev ? { ...m, revertedAt: rev.revertedAt ?? new Date(0) } : m;
  });
  return {
    ...state,
    levelOverride: o.levelOverride !== undefined ? o.levelOverride : state.levelOverride,
    purchases,
    ledger: [...state.ledger, ...o.ledger],
    cardMoves: [...cardMoves, ...o.cardMoves],
    rewards: [...state.rewards.map((r) => rewardUpdates.get(r.id) ?? r), ...o.rewardsUnlocked],
    sentNotificationKeys: [...state.sentNotificationKeys, ...o.notificationKeys],
  };
}
