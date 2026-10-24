import { applyOutcome, emptyOutcome, mergeOutcomes, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceOf } from '../state.js';
import type { ClientState } from '../types.js';
import { assert } from './common.js';
import { settleExpiry } from './expiry.js';

export interface ManualAdjustInput {
  idempotencyKey: string;
  staffId: string;
  /** Signed points delta. */
  amount: number;
  reason: string;
}

/**
 * Manager/owner correction of the points balance (e.g. migrating the old
 * client base). A positive adjustment also restarts the expiry timer.
 */
export function manualAdjust(rules: LoyaltyRules, state: ClientState, input: ManualAdjustInput, now: Date): Outcome {
  assert(Number.isSafeInteger(input.amount) && input.amount !== 0, 'INVALID_INPUT', 'amount must be a non-zero integer');
  assert(input.reason?.trim(), 'INVALID_INPUT', 'reason is required');
  if (state.ledger.some((e) => e.idempotencyKey === input.idempotencyKey)) return { ...emptyOutcome(), replayed: true };
  // Overdue expiry is settled first: an adjustment cannot "save" burnt points.
  const expiry = settleExpiry(rules, state, now);
  const s = applyOutcome(state, expiry);
  const out = emptyOutcome();
  out.ledger.push({
    clientId: s.clientId,
    type: 'manual_adjust',
    amount: input.amount,
    purchaseId: null,
    staffId: input.staffId,
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
  });
  const balance = balanceOf(s) + input.amount;
  if (balance < 0) out.warnings.push('balance becomes negative');
  out.events.push({ type: 'points_adjusted', clientId: s.clientId, amount: input.amount, balance, reason: input.reason.trim() });
  return mergeOutcomes(expiry, out);
}
