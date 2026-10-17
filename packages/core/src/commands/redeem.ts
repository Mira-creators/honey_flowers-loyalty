import { LoyaltyError } from '../errors.js';
import { percentOf } from '../money.js';
import { applyOutcome, emptyOutcome, mergeOutcomes, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceFromLedger } from '../state.js';
import type { ClientState, Uzs } from '../types.js';
import { assert, findAvailableReward, redeemCap } from './common.js';
import { settleExpiry } from './expiry.js';

export interface RedeemInput {
  idempotencyKey: string;
  staffId: string | null;
  /**
   * Amount of the order the points are spent on; the cap (maxRedeemPct) is
   * computed from it. Required when points > 0.
   */
  orderAmount?: Uzs;
  /** Points to spend. */
  points?: Uzs;
  /** Gift to hand out / mark as used. */
  rewardId?: string | null;
  reason?: string | null;
}

/**
 * Standalone redemption — spend points and/or hand out a gift WITHOUT
 * registering a purchase (e.g. the order itself is registered elsewhere).
 * The normal flow is applyPurchase with redeemPoints/useRewardId, which also
 * accrues cashback on the paid part.
 *
 * Does not extend the expiry period (only purchases do).
 */
export function redeem(rules: LoyaltyRules, state: ClientState, input: RedeemInput, now: Date): Outcome {
  const points = input.points ?? 0;
  assert(input.idempotencyKey, 'INVALID_INPUT', 'idempotencyKey is required');
  assert(Number.isSafeInteger(points) && points >= 0, 'INVALID_INPUT', 'points must be a non-negative integer');
  assert(points > 0 || input.rewardId, 'INVALID_INPUT', 'nothing to redeem');

  // Idempotency: the key is stored on the ledger entry / used reward.
  const keyUsed =
    state.ledger.some((e) => e.idempotencyKey === input.idempotencyKey) ||
    state.rewards.some((r) => r.usedIdempotencyKey === input.idempotencyKey);
  if (keyUsed) return { ...emptyOutcome(), replayed: true };

  const expiry = settleExpiry(rules, state, now);
  const s = applyOutcome(state, expiry);
  const out = emptyOutcome();

  const reward = input.rewardId ? findAvailableReward(s, input.rewardId) : null;
  if (reward?.type === 'discount_pct' && points > 0 && !rules.allowDiscountWithPoints) {
    throw new LoyaltyError('DISCOUNT_WITH_POINTS_NOT_ALLOWED', 'discount gift and points cannot be combined');
  }

  if (points > 0) {
    const order = input.orderAmount;
    assert(Number.isSafeInteger(order) && (order ?? 0) > 0, 'INVALID_INPUT', 'orderAmount is required to redeem points');
    const discount = reward?.type === 'discount_pct' ? percentOf(order!, reward.value ?? 0) : 0;
    const cap = redeemCap(rules, order!, discount);
    const balance = balanceFromLedger(s.ledger);
    assert(points <= balance, 'INSUFFICIENT_BALANCE', `balance ${balance} < ${points}`);
    assert(points <= cap, 'REDEEM_CAP_EXCEEDED', `at most ${cap} points can be used on this order`);
    out.ledger.push({
      clientId: s.clientId,
      type: 'redeem',
      amount: -points,
      purchaseId: null,
      staffId: input.staffId,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    });
    out.events.push({ type: 'points_redeemed', clientId: s.clientId, purchaseId: null, amount: points, balance: balance - points });
  }
  if (reward) {
    out.rewardsUpdated.push({ ...reward, status: 'used', usedAt: now, usedIdempotencyKey: input.idempotencyKey });
    out.events.push({ type: 'reward_used', clientId: s.clientId, rewardId: reward.id, purchaseId: null });
  }
  return mergeOutcomes(expiry, out);
}
