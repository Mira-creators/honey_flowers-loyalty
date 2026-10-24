import type { LevelTier, LoyaltyRules } from './rules.js';
import type { CardMove, CellReward, ClientState, LedgerEntry, PurchaseRecord, Reward, Uzs } from './types.js';
import { calendarDaysBetween, keyFromDayNumber, localDateKey, localDayNumber, monthsBeforeKey } from './time.js';

/**
 * Derived values. Everything here is a pure function of (rules, state, now).
 */

/** Points balance = sum of all ledger amounts. May be negative after a reversal. */
export function balanceFromLedger(ledger: readonly LedgerEntry[]): Uzs {
  return ledger.reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Points balance of a client: the loaded ledger plus what a bounded state folded away
 * (ClientState.folded). Use this, not balanceFromLedger(state.ledger), for a state.
 */
export function balanceOf(state: ClientState): Uzs {
  return (state.folded?.ledgerSum ?? 0) + balanceFromLedger(state.ledger);
}

/** Loaded active purchases (a bounded state may hold only the latest ones, see activePurchaseCount). */
export function activePurchases(state: ClientState): PurchaseRecord[] {
  return state.purchases.filter((p) => p.status === 'active');
}

/** All active purchases of the client, loaded or folded. */
export function activePurchaseCount(state: ClientState): number {
  return (state.folded?.activeCount ?? 0) + activePurchases(state).length;
}

/**
 * What the folded (not loaded) active purchases add to the all-time level metric for the current
 * override: their sums were computed for the override in force at load time; an override set
 * later (expiry, at `now`, after every stored purchase) forgets them all.
 */
export function foldedLevel(state: ClientState): { sum: Uzs; count: number } {
  const f = state.folded;
  if (!f) return { sum: 0, count: 0 };
  const at = state.levelOverride?.setAt.getTime() ?? null;
  const since = f.levelSince?.getTime() ?? null;
  if (at !== since && at !== null && (since === null || at > since)) return { sum: 0, count: 0 };
  return { sum: f.levelSum, count: f.levelCount };
}

/**
 * All-time level totals (no window, no "now"): active purchases at/after the override's setAt,
 * loaded + folded. Stored per client (apps/worker client_stats.level_sum / level_count) so a
 * bounded state can be loaded without reading every purchase.
 */
export function levelTotals(state: ClientState): { sum: Uzs; count: number } {
  const since = state.levelOverride?.setAt.getTime() ?? null;
  const f = foldedLevel(state);
  let sum = f.sum;
  let count = f.count;
  for (const p of activePurchases(state)) {
    if (since !== null && p.createdAt.getTime() < since) continue;
    sum += p.amount;
    count++;
  }
  return { sum, count };
}

// ---------------------------------------------------------------- levels

export interface LevelInfo {
  tier: LevelTier;
  index: number;
  /** Metric used for the level (UZS sum or purchase count) within the window. */
  metric: number;
  /** Where the metric is counted from (local date key), null = all time. */
  countedFrom: string | null;
  next: { tier: LevelTier; remaining: number } | null;
}

/**
 * Level of the client at `now`.
 *
 * - Only active (not reversed) purchases made at or before `now` count.
 * - criterion 'sum' uses the gross purchase amount; 'count' the number of purchases.
 * - With `windowMonths`, only purchases on/after the same local date N months ago count.
 * - With a level override (set by expiry), only purchases after the override
 *   count and the result is max(override, derived).
 */
export function deriveLevel(rules: LoyaltyRules, state: ClientState, now: Date): LevelInfo {
  const { tiers, criterion, windowMonths } = rules.levels;
  const tz = rules.timezone;
  const windowStartKey = windowMonths ? monthsBeforeKey(now, windowMonths, tz) : null;
  const override = state.levelOverride;

  const counted = activePurchases(state).filter((p) => {
    if (p.createdAt.getTime() > now.getTime()) return false;
    // Purchases strictly before the override are forgotten; a purchase in the
    // same instant (expiry settled inside applyPurchase) still counts.
    if (override && p.createdAt.getTime() < override.setAt.getTime()) return false;
    if (windowStartKey && localDateKey(p.createdAt, tz) < windowStartKey) return false;
    return true;
  });
  // Folded (not loaded) purchases count only for an all-time level: with a window, storage loads
  // every active purchase inside the window (apps/worker D1Repository bounded load).
  const folded = windowStartKey ? { sum: 0, count: 0 } : foldedLevel(state);
  const metric = criterion === 'sum' ? folded.sum + counted.reduce((s, p) => s + p.amount, 0) : folded.count + counted.length;

  let index = 0;
  tiers.forEach((t, i) => {
    if (metric >= t.threshold) index = i;
  });
  if (override) {
    // Match by id; if a rules edit renamed the tier, fall back to the stored index.
    let oi = tiers.findIndex((t) => t.id === override.levelId);
    if (oi < 0 && override.levelIndex !== undefined) oi = Math.min(override.levelIndex, tiers.length - 1);
    if (oi > index) index = oi;
  }
  const tier = tiers[index]!;
  const nextTier = tiers[index + 1];
  return {
    tier,
    index,
    metric,
    countedFrom: windowStartKey,
    next: nextTier ? { tier: nextTier, remaining: Math.max(0, nextTier.threshold - metric) } : null,
  };
}

// ---------------------------------------------------------------- honeycomb

export interface CardPosition {
  /** 1-based number of the current card. */
  cycle: number;
  /** Cells filled on the current card (0..cells-1; a full card rolls over). */
  filled: number;
}

export function activeCardMoves(state: ClientState): CardMove[] {
  return state.cardMoves.filter((m) => !m.revertedAt);
}

/** The latest non-reverted card move, i.e. the one a reversal may roll back. */
export function latestCardMove(state: ClientState): CardMove | null {
  const moves = activeCardMoves(state);
  return moves.length ? moves[moves.length - 1]! : null;
}

/** Current card position. A completed card (last cell filled) shows as the next, empty card. */
export function cardPosition(rules: LoyaltyRules, state: ClientState): CardPosition {
  const last = latestCardMove(state);
  if (!last) return { cycle: 1, filled: 0 };
  if (last.cell >= rules.honeycomb.cells) return { cycle: last.cycle + 1, filled: 0 };
  return { cycle: last.cycle, filled: last.cell };
}

/** Rewards layout of a given card number. */
export function rewardsForCycle(rules: LoyaltyRules, cycle: number): CellReward[] {
  const hc = rules.honeycomb;
  if (hc.afterLastCell === 'new_card' && cycle > 1 && hc.nextCardRewards) return hc.nextCardRewards;
  return hc.rewards;
}

/** Purchases left until the next gift cell on the card, or null if none ahead. */
export function purchasesToNextReward(rules: LoyaltyRules, pos: CardPosition): number | null {
  const ahead = rewardsForCycle(rules, pos.cycle)
    .map((r) => r.cell)
    .filter((c) => c > pos.filled)
    .sort((a, b) => a - b);
  return ahead.length ? ahead[0]! - pos.filled : null;
}

// ---------------------------------------------------------------- expiry

/**
 * The moment the expiry timer counts from: the latest of registration, the
 * last active purchase, the welcome bonus and the last positive manual
 * adjustment (i.e. any event that credited points or should keep them alive).
 */
export function activityAnchor(state: ClientState): Date {
  let anchor = state.registeredAt;
  const later = (d: Date) => {
    if (d.getTime() > anchor.getTime()) anchor = d;
  };
  for (const p of activePurchases(state)) later(p.createdAt);
  for (const e of state.ledger) if ((e.type === 'manual_adjust' || e.type === 'welcome') && e.amount > 0) later(e.createdAt);
  return anchor;
}

/** Latest `expire` ledger entry, or null. */
export function lastExpiry(state: ClientState): LedgerEntry | null {
  let last: LedgerEntry | null = null;
  for (const e of state.ledger) if (e.type === 'expire' && (!last || e.createdAt.getTime() >= last.createdAt.getTime())) last = e;
  return last;
}

export interface ExpiryInfo {
  anchor: Date;
  anchorKey: string;
  /** Local date (YYYY-MM-DD) on which the balance expires. */
  expiresOn: string;
  daysSinceActivity: number;
  /** Calendar days until expiry; 0 or less means expired/due. */
  daysLeft: number;
}

/**
 * Points expire when `expiryDays` full local calendar days have passed since
 * the anchor: last purchase on day D → expires on day D + expiryDays.
 */
export function expiryInfo(rules: LoyaltyRules, state: ClientState, now: Date): ExpiryInfo {
  const tz = rules.timezone;
  const anchor = activityAnchor(state);
  const daysSince = calendarDaysBetween(anchor, now, tz);
  return {
    anchor,
    anchorKey: localDateKey(anchor, tz),
    expiresOn: keyFromDayNumber(localDayNumber(anchor, tz) + rules.expiry.expiryDays),
    daysSinceActivity: daysSince,
    daysLeft: rules.expiry.expiryDays - daysSince,
  };
}

// ---------------------------------------------------------------- gifts

export function availableRewards(state: ClientState): Reward[] {
  return state.rewards.filter((r) => r.status === 'available');
}

/** All available gifts of the client, loaded or folded (ClientState.folded.availableGifts). */
export function availableGiftCount(state: ClientState): number {
  return (state.folded?.availableGifts ?? 0) + availableRewards(state).length;
}
