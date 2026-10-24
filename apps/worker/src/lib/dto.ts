import type {
  CardDTO,
  ClientSummaryDTO,
  GiftDTO,
  HistoryItemDTO,
  Lang,
  LevelInfo,
  NextLevelInfo,
  PublicRulesDTO,
  PurchasePreviewDTO,
} from '@honey/contracts';
import {
  applyOutcome,
  balanceOf,
  cardPosition,
  dayNumberFromKey,
  deriveLevel,
  expiryInfo,
  isGrantedReward,
  keyFromDayNumber,
  rewardsForCycle,
  settleExpiry,
  type ClientState,
  type LevelTier,
  type LoyaltyRules,
  type PurchaseSummary,
  type Reward,
} from '@honey/core';
import { maskPhone, type ClientProfile } from '@honey/service';
import { giftCode, giftLayout } from './gifts.js';

/** Mapping of engine state to the HTTP contract (packages/contracts). */

export function levelInfo(t: LevelTier): LevelInfo {
  return { id: t.id, name: t.title, pct: t.cashbackPct, from: t.threshold };
}

export function publicRules(rules: LoyaltyRules): PublicRulesDTO {
  return {
    minPurchaseForCell: rules.honeycomb.minPurchaseForCell,
    maxRedeemPct: rules.maxRedeemPct,
    expiryDays: rules.expiry.expiryDays,
    welcomeBonus: rules.welcomeBonus,
    levels: rules.levels.tiers.map(levelInfo),
    cells: rules.honeycomb.cells,
  };
}

export function giftDTO(r: Reward): GiftDTO {
  return {
    id: r.id,
    type: giftCode(r),
    cycle: r.cycle,
    cell: r.cell,
    status: r.status,
    unlockedAt: r.unlockedAt.toISOString(),
    usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    ...(isGrantedReward(r) ? { source: 'grant' as const, ...(r.grantReason ? { reason: r.grantReason } : {}) } : {}),
  };
}

/** Start of a Tashkent-local day 'YYYY-MM-DD' as an ISO instant. Tashkent has no DST (UTC+5). */
export function tashkentDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+05:00`).toISOString();
}

/** State as the client sees it now: overdue expiry applied in memory (not persisted). */
export function viewState(rules: LoyaltyRules, stored: ClientState, now: Date): ClientState {
  return applyOutcome(stored, settleExpiry(rules, stored, now));
}

function sumBy<T>(list: readonly T[], f: (x: T) => number): number {
  return list.reduce((s, x) => s + f(x), 0);
}

export function cardDTO(rules: LoyaltyRules, state: ClientState): CardDTO {
  const pos = cardPosition(rules, state);
  return { cycle: pos.cycle, filled: pos.filled, cells: rules.honeycomb.cells, gifts: giftLayout(rewardsForCycle(rules, pos.cycle)) };
}

/**
 * The client card as the client sees it. `history` comes from SQL (lib/history.ts), not from the
 * state: a bounded state (db/stateLoader.ts) carries only what the engine needs.
 */
export function clientSummary(rules: LoyaltyRules, client: ClientProfile, stored: ClientState, now: Date, history: HistoryItemDTO[]): ClientSummaryDTO {
  const state = viewState(rules, stored, now);
  const balance = balanceOf(state);
  const level = deriveLevel(rules, state, now);
  const next: NextLevelInfo | null = level.next ? { ...levelInfo(level.next.tier), left: level.next.remaining } : null;
  const exp = expiryInfo(rules, state, now);
  return {
    id: client.id,
    name: client.name ?? '',
    phoneMasked: maskPhone(client.phone),
    code: client.code,
    lang: (client.language === 'uz' ? 'uz' : 'ru') as Lang,
    balance,
    spent: level.metric,
    level: levelInfo(level.tier),
    next,
    card: cardDTO(rules, state),
    // exp.expiresOn is the day the points burn (engine); the client is told the last valid day.
    expiresOn: balance > 0 ? keyFromDayNumber(dayNumberFromKey(exp.expiresOn) - 1) : null,
    expiresAt: balance > 0 ? tashkentDayStartIso(exp.expiresOn) : null,
    gifts: [...state.rewards]
      .sort((a, b) => b.unlockedAt.getTime() - a.unlockedAt.getTime())
      .map(giftDTO),
    history,
  };
}

export function previewFromSummary(
  res: PurchaseSummary,
  maxRedeem: number,
  unlocked: readonly Reward[],
): PurchasePreviewDTO {
  const gift = unlocked[0] ?? null;
  return {
    amount: res.amount,
    maxRedeem,
    redeemed: res.pointsRedeemed,
    discount: res.discountApplied,
    paid: res.paid,
    cashback: res.cashback,
    pct: res.cashbackPct,
    cell: res.cellAdvanced ? res.cell : null,
    cellBlockedReason: res.cellSkipReason === 'below_min_amount' ? 'below_min' : res.cellSkipReason === 'daily_limit' ? 'daily_limit' : null,
    unlocksGift: unlocked.length > 0,
    giftType: gift ? giftCode(gift) : null,
  };
}
