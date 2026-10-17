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
  balanceFromLedger,
  cardPosition,
  dayNumberFromKey,
  deriveLevel,
  expiryInfo,
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

/** Client history, newest first, max `limit`. */
export function history(state: ClientState, actorNames: Map<string, string>, limit = 50): HistoryItemDTO[] {
  const items: HistoryItemDTO[] = [];
  const staffName = (id: string | null) => (id ? actorNames.get(id) : undefined);
  for (const p of state.purchases) {
    const entries = state.ledger.filter((e) => e.purchaseId === p.id);
    const res: PurchaseSummary | null = p.result;
    items.push({
      id: p.id,
      at: p.createdAt.toISOString(),
      kind: 'purchase',
      points: sumBy(entries.filter((e) => e.type === 'accrual' || e.type === 'redeem'), (e) => e.amount),
      cashback: sumBy(entries.filter((e) => e.type === 'accrual'), (e) => e.amount),
      purchaseId: p.id,
      purchaseAmount: p.amount,
      pct: res?.cashbackPct ?? 0,
      cell: res?.cellAdvanced ? res.cell : null,
      redeemed: p.pointsRedeemed,
      status: p.status,
      ...(staffName(p.staffId) ? { staffName: staffName(p.staffId)! } : {}),
    });
    if (p.status === 'reversed' && p.reversedAt) {
      items.push({
        id: `rev-${p.id}`,
        at: p.reversedAt.toISOString(),
        kind: 'reversal',
        points: sumBy(entries.filter((e) => e.type === 'reversal'), (e) => e.amount),
        purchaseId: p.id,
        purchaseAmount: p.amount,
        status: 'reversed',
        ...(p.reversedReason ? { reason: p.reversedReason } : {}),
        ...(staffName(p.reversedBy) ? { staffName: staffName(p.reversedBy)! } : {}),
      });
    }
  }
  for (const e of state.ledger) {
    if (e.purchaseId) continue;
    const kind = e.type === 'welcome' ? 'welcome' : e.type === 'redeem' ? 'redeem' : e.type === 'expire' ? 'expire' : 'manual';
    items.push({
      id: e.id ?? `${e.type}-${e.createdAt.toISOString()}`,
      at: e.createdAt.toISOString(),
      kind,
      points: e.amount,
      ...(kind === 'manual' && e.reason ? { reason: e.reason } : {}),
      ...(staffName(e.staffId) ? { staffName: staffName(e.staffId)! } : {}),
    });
  }
  for (const r of state.rewards) {
    if (r.status === 'used' && !r.usedInPurchase && r.usedAt) {
      items.push({ id: `gift-${r.id}`, at: r.usedAt.toISOString(), kind: 'gift_used', points: 0 });
    }
  }
  // Newest first; stable for equal timestamps (purchase before its reversal when same instant).
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.at < b.it.at ? 1 : a.it.at > b.it.at ? -1 : b.i - a.i))
    .slice(0, limit)
    .map((x) => x.it);
}

export function cardDTO(rules: LoyaltyRules, state: ClientState): CardDTO {
  const pos = cardPosition(rules, state);
  return { cycle: pos.cycle, filled: pos.filled, cells: rules.honeycomb.cells, gifts: giftLayout(rewardsForCycle(rules, pos.cycle)) };
}

/** All staff/actor ids referenced in a client's state (for name lookup). */
export function actorIds(state: ClientState): string[] {
  return [
    ...state.purchases.flatMap((p) => [p.staffId, p.reversedBy]),
    ...state.ledger.map((e) => e.staffId),
  ].filter((x): x is string => !!x);
}

export function clientSummary(
  rules: LoyaltyRules,
  client: ClientProfile,
  stored: ClientState,
  now: Date,
  actorNames: Map<string, string>,
): ClientSummaryDTO {
  const state = viewState(rules, stored, now);
  const balance = balanceFromLedger(state.ledger);
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
    history: history(state, actorNames),
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
