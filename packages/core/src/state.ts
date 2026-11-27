import type { LevelTier, LoyaltyRules } from './rules.js';
import type { CardMove, CellReward, ClientState, LedgerEntry, PurchaseRecord, Reward, Uzs } from './types.js';
import { calendarDaysBetween, dayNumberFromKey, keyFromDayNumber, localDateKey, localDayNumber, monthsBeforeKey } from './time.js';

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
  /** Metric used for the level (UZS sum or purchase count) within the window, at `now`. */
  metric: number;
  /** Where the metric is counted from (local date key), null = all time. */
  countedFrom: string | null;
  next: { tier: LevelTier; remaining: number } | null;
  /**
   * levels.mode 'sticky' and a level above the first: the LOCAL date on which the level resets to the
   * first tier unless the client buys before (last purchase day + resetAfterDays). null otherwise.
   */
  resetsOn: string | null;
}

/** First local day (inclusive) of the level window at `at`; null = all time. */
export function levelWindowStartKey(rules: LoyaltyRules, at: Date): string | null {
  const { windowMonths, windowDays } = rules.levels;
  const tz = rules.timezone;
  if (windowDays) return keyFromDayNumber(localDayNumber(at, tz) - windowDays + 1);
  if (windowMonths) return monthsBeforeKey(at, windowMonths, tz);
  return null;
}

/**
 * The level metric at instant `at`: active purchases made at or before `at`, at/after the level
 * override, inside the window; the UZS sum, the number of purchases, or (count + oncePerDay) the
 * number of distinct local days with a purchase. Folded (not loaded) purchases count only for an
 * all-time level: with a window, storage loads every active purchase inside it.
 */
export function levelMetricAt(rules: LoyaltyRules, state: ClientState, at: Date): { metric: number; countedFrom: string | null } {
  const { criterion, oncePerDay } = rules.levels;
  const tz = rules.timezone;
  const startKey = levelWindowStartKey(rules, at);
  const override = state.levelOverride;
  const counted = activePurchases(state).filter((p) => {
    if (p.createdAt.getTime() > at.getTime()) return false;
    // Purchases strictly before the override are forgotten; a purchase in the
    // same instant (expiry settled inside applyPurchase) still counts.
    if (override && p.createdAt.getTime() < override.setAt.getTime()) return false;
    if (startKey && localDateKey(p.createdAt, tz) < startKey) return false;
    return true;
  });
  const folded = startKey ? { sum: 0, count: 0 } : foldedLevel(state);
  let metric: number;
  if (criterion === 'sum') metric = folded.sum + counted.reduce((s, p) => s + p.amount, 0);
  else if (oncePerDay && startKey) metric = new Set(counted.map((p) => localDateKey(p.createdAt, tz))).size;
  else metric = folded.count + counted.length;
  return { metric, countedFrom: startKey };
}

/** Highest tier whose threshold the metric reaches. */
function tierIndexFor(rules: LoyaltyRules, metric: number): number {
  let index = 0;
  rules.levels.tiers.forEach((t, i) => {
    if (metric >= t.threshold) index = i;
  });
  return index;
}

/** Tier index of the level override (by id; by the stored index if a rules edit renamed the tier). */
function overrideIndex(rules: LoyaltyRules, state: ClientState): number {
  const o = state.levelOverride;
  if (!o) return -1;
  const tiers = rules.levels.tiers;
  let oi = tiers.findIndex((t) => t.id === o.levelId);
  if (oi < 0 && o.levelIndex !== undefined) oi = Math.min(o.levelIndex, tiers.length - 1);
  return oi;
}

export interface StickyState {
  /** Level reached by the last activity (before any inactivity reset at `now`). */
  index: number;
  /** Last activity that keeps the level: the latest active purchase or the override; null = none. */
  anchor: Date | null;
}

/**
 * Sticky level (levels.mode 'sticky') as of the last activity, WITHOUT the inactivity reset at `now`
 * (see deriveLevel / levelReset). Definition, over the active purchases in time order: at each
 * purchase the level drops to the first tier if `resetAfterDays` local days passed since the
 * previous activity, then rises to the tier the metric reaches at that purchase (never falls).
 * A level override (expiry level-down, import floor) restarts the sequence at its tier and time.
 *
 * Bounded history: every purchase stores its sticky level in `result.stickyLevel`. The derivation
 * starts from the newest active purchase whose stored value is still exact — none of the purchases
 * made before it was reversed after it — and replays only what follows (usually nothing).
 */
export function stickyLevel(rules: LoyaltyRules, state: ClientState, now: Date): StickyState {
  const tiers = rules.levels.tiers;
  const tz = rules.timezone;
  const resetDays = rules.levels.resetAfterDays ?? Infinity;
  const override = state.levelOverride;
  const since = override ? override.setAt.getTime() : -Infinity;
  const active = activePurchases(state)
    .filter((p) => p.createdAt.getTime() <= now.getTime() && p.createdAt.getTime() >= since)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const reversed = state.purchases.filter((p) => p.status === 'reversed' && p.reversedAt);
  const tainted = (t: number) => reversed.some((r) => r.createdAt.getTime() < t && r.reversedAt!.getTime() > t);

  let index = 0;
  let anchor: Date | null = null;
  let from = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    const p = active[i]!;
    const id = p.result?.stickyLevel;
    if (!id) continue;
    const idx = tiers.findIndex((t) => t.id === id);
    if (idx < 0 || tainted(p.createdAt.getTime())) continue;
    index = idx;
    anchor = p.createdAt;
    from = i + 1;
    break;
  }
  if (!anchor && override) {
    index = Math.max(0, overrideIndex(rules, state));
    anchor = override.setAt;
    from = 0;
  }
  for (let i = from; i < active.length; i++) {
    const p = active[i]!;
    if (anchor && calendarDaysBetween(anchor, p.createdAt, tz) >= resetDays) index = 0;
    index = Math.max(index, tierIndexFor(rules, levelMetricAt(rules, state, p.createdAt).metric));
    anchor = p.createdAt;
  }
  return { index, anchor };
}

/**
 * Which purchases storage must load for the level (bounded loads, apps/worker stateLoader): every
 * purchase created at/after `from` — only active ones for a rolling window, ALL of them in sticky
 * mode (reversed purchases tell which stored checkpoints are still exact) over the longer of the
 * window and the reset period plus the reversal window. null = no window: totals are folded.
 * `from` is a safe lower bound (one day early), never later than needed.
 */
export function levelHistoryFrom(rules: LoyaltyRules, now: Date): { from: Date; allStatuses: boolean } | null {
  const lv = rules.levels;
  const tz = rules.timezone;
  const today = localDayNumber(now, tz);
  if (lv.mode === 'sticky') {
    const days = Math.max(lv.windowDays ?? (lv.windowMonths ? lv.windowMonths * 31 : 0), lv.resetAfterDays ?? 0) + Math.ceil(rules.reversalWindowHours / 24) + 1;
    return { from: new Date((today - days - 1) * 86_400_000), allStatuses: true };
  }
  const key = levelWindowStartKey(rules, now);
  return key ? { from: new Date((dayNumberFromKey(key) - 1) * 86_400_000), allStatuses: false } : null;
}

/** Sticky mode: when the current level resets (null: not sticky, first tier, or no activity). */
export function levelReset(rules: LoyaltyRules, state: ClientState, now: Date): { index: number; anchor: Date; anchorKey: string; resetsOn: string; daysLeft: number } | null {
  const lv = rules.levels;
  if (lv.mode !== 'sticky' || !lv.resetAfterDays) return null;
  const st = stickyLevel(rules, state, now);
  if (st.index === 0 || !st.anchor) return null;
  const tz = rules.timezone;
  const anchorDay = localDayNumber(st.anchor, tz);
  const resetDay = anchorDay + lv.resetAfterDays;
  return { index: st.index, anchor: st.anchor, anchorKey: keyFromDayNumber(anchorDay), resetsOn: keyFromDayNumber(resetDay), daysLeft: resetDay - localDayNumber(now, tz) };
}

/**
 * Level of the client at `now`.
 *
 * - Only active (not reversed) purchases made at or before `now` count.
 * - criterion 'sum' uses the gross purchase amount; 'count' the number of purchases (oncePerDay:
 *   of local days with a purchase).
 * - With `windowMonths` / `windowDays`, only purchases inside the window count.
 * - 'rolling': the level is what the metric gives now; with a level override (set by expiry), only
 *   purchases after the override count and the result is max(override, derived).
 * - 'sticky': see stickyLevel; it resets to the first tier `resetAfterDays` local days after the
 *   last activity.
 */
export function deriveLevel(rules: LoyaltyRules, state: ClientState, now: Date): LevelInfo {
  const { tiers } = rules.levels;
  const { metric, countedFrom } = levelMetricAt(rules, state, now);
  let index: number;
  let resetsOn: string | null = null;
  if (rules.levels.mode === 'sticky') {
    const r = levelReset(rules, state, now);
    index = r && r.daysLeft > 0 ? r.index : 0;
    if (r && r.daysLeft > 0) resetsOn = r.resetsOn;
  } else {
    index = tierIndexFor(rules, metric);
    const oi = overrideIndex(rules, state);
    if (oi > index) index = oi;
  }
  const tier = tiers[index]!;
  const nextTier = tiers[index + 1];
  return {
    tier,
    index,
    metric,
    countedFrom,
    next: nextTier ? { tier: nextTier, remaining: Math.max(0, nextTier.threshold - metric) } : null,
    resetsOn,
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
