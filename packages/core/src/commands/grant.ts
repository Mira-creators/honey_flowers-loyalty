import { LoyaltyError } from '../errors.js';
import { applyOutcome, emptyOutcome, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceOf, cardPosition } from '../state.js';
import { REWARD_TYPES, type ClientState, type Reward, type RewardType } from '../types.js';
import { assert } from './common.js';
import { manualAdjust } from './manualAdjust.js';

/**
 * Owner grants WITHOUT a purchase: a gift (greeting card, free delivery,
 * discount…) or bonus мёд, always with a reason ("извинение за задержку",
 * "день рождения"). Both are idempotent by `idempotencyKey`.
 */

/** Ids of granted gifts start with this prefix (honeycomb gifts use `${cycle}-${cell}-${purchaseId}`). */
export const GRANT_REWARD_PREFIX = 'grant-';

export function grantRewardId(idempotencyKey: string): string {
  return `${GRANT_REWARD_PREFIX}${idempotencyKey}`;
}

/** Was this gift granted by the owner (not unlocked on the honeycomb)? */
export function isGrantedReward(r: Pick<Reward, 'id' | 'unlockedByPurchase'>): boolean {
  return r.unlockedByPurchase === null && r.id.startsWith(GRANT_REWARD_PREFIX);
}

export interface GrantGiftInput {
  idempotencyKey: string;
  staffId: string;
  gift: { type: RewardType; value?: number | null; title: string };
  reason: string;
}

/**
 * Give the client a gift outside the honeycomb. It lands in "Подарки" as an
 * available gift and is used exactly like a honeycomb gift (in a purchase or
 * handed out). It is not tied to a card cell: storage needs cell >= 1, so the
 * bee's current cell (at least 1) of the current card is recorded for reference.
 * Does not touch мёд, the card or the expiry timer.
 */
export function grantGift(rules: LoyaltyRules, state: ClientState, input: GrantGiftInput, now: Date): Outcome {
  assert(input.idempotencyKey, 'INVALID_INPUT', 'idempotencyKey is required');
  const reason = input.reason?.trim();
  assert(reason, 'INVALID_INPUT', 'reason is required');
  const title = input.gift?.title?.trim();
  assert(title, 'INVALID_INPUT', 'gift title is required');
  assert((REWARD_TYPES as readonly string[]).includes(input.gift.type), 'INVALID_INPUT', `unknown gift type: ${String(input.gift.type)}`);
  const value = input.gift.value ?? null;
  if (value !== null) {
    assert(Number.isFinite(value) && value >= 0, 'INVALID_INPUT', 'gift value must be non-negative');
    if (input.gift.type === 'discount_pct') assert(value <= 100, 'INVALID_INPUT', 'discount cannot exceed 100%');
  }

  const id = grantRewardId(input.idempotencyKey);
  const prior = state.rewards.find((r) => r.id === id);
  if (prior) {
    if (prior.type !== input.gift.type || prior.title !== title || (prior.value ?? null) !== value) {
      throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different gift');
    }
    return { ...emptyOutcome(), replayed: true };
  }

  const pos = cardPosition(rules, state);
  const reward: Reward = {
    id,
    clientId: state.clientId,
    cycle: pos.cycle,
    cell: Math.max(1, pos.filled),
    type: input.gift.type,
    value,
    title,
    status: 'available',
    unlockedByPurchase: null,
    usedInPurchase: null,
    unlockedAt: now,
    usedAt: null,
    grantedBy: input.staffId,
    grantReason: reason,
  };
  const out = emptyOutcome();
  out.rewardsUnlocked.push(reward);
  out.events.push({ type: 'gift_granted', clientId: state.clientId, rewardId: id, rewardType: reward.type, title, reason });
  return out;
}

export interface GrantPointsInput {
  idempotencyKey: string;
  staffId: string;
  /** Bonus мёд, a positive integer. */
  points: number;
  reason: string;
}

/**
 * Credit bonus мёд: a positive manual adjustment (manualAdjust settles overdue
 * expiry first and restarts the expiry timer), announced to the client as a
 * `points_granted` event instead of manualAdjust's `points_adjusted`. Same key with another amount is a conflict.
 */
export function grantPoints(rules: LoyaltyRules, state: ClientState, input: GrantPointsInput, now: Date): Outcome {
  assert(Number.isSafeInteger(input.points) && input.points > 0, 'INVALID_INPUT', 'points must be a positive integer');
  assert(input.idempotencyKey, 'INVALID_INPUT', 'idempotencyKey is required');
  const prior = state.ledger.find((e) => e.idempotencyKey === input.idempotencyKey);
  if (prior) {
    if (prior.type !== 'manual_adjust' || prior.amount !== input.points) {
      throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different operation');
    }
    return { ...emptyOutcome(), replayed: true };
  }
  const out = manualAdjust(rules, state, { idempotencyKey: input.idempotencyKey, staffId: input.staffId, amount: input.points, reason: input.reason }, now);
  const balance = balanceOf(applyOutcome(state, out));
  // A grant is announced as a gift, not as a correction: replace manualAdjust's points_adjusted.
  out.events = out.events.filter((e) => e.type !== 'points_adjusted');
  out.events.push({ type: 'points_granted', clientId: state.clientId, amount: input.points, balance, reason: input.reason.trim() });
  return out;
}
