import { emptyOutcome, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceFromLedger } from '../state.js';
import type { ClientState } from '../types.js';
import { assert } from './common.js';

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
export function manualAdjust(_rules: LoyaltyRules, state: ClientState, input: ManualAdjustInput, now: Date): Outcome {
  assert(Number.isSafeInteger(input.amount) && input.amount !== 0, 'INVALID_INPUT', 'amount must be a non-zero integer');
  assert(input.reason?.trim(), 'INVALID_INPUT', 'reason is required');
  if (state.ledger.some((e) => e.idempotencyKey === input.idempotencyKey)) return { ...emptyOutcome(), replayed: true };
  const out = emptyOutcome();
  out.ledger.push({
    clientId: state.clientId,
    type: 'manual_adjust',
    amount: input.amount,
    purchaseId: null,
    staffId: input.staffId,
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
  });
  if (balanceFromLedger(state.ledger) + input.amount < 0) out.warnings.push('balance becomes negative');
  return out;
}
