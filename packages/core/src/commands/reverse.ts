import { emptyOutcome, type Outcome } from '../outcome.js';
import { applyOutcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceFromLedger, deriveLevel, latestCardMove } from '../state.js';
import type { ClientState } from '../types.js';
import { assert } from './common.js';

export interface ReverseInput {
  purchaseId: string;
  /** Mandatory human-readable reason (shown in the audit log). */
  reason: string;
  /** Staff member who reverses the purchase. */
  staffId: string | null;
}

/**
 * Reverse (cancel) a purchase:
 *  - the cashback accrual and the points redemption are undone with
 *    'reversal' ledger entries (the balance may go negative if the accrued
 *    points were already spent — reported in `warnings`);
 *  - the card step is rolled back only if it is the client's latest card
 *    move; otherwise the card stays and a warning is returned;
 *  - gifts unlocked by the purchase: available → revoked; already used →
 *    kept as used, with a warning;
 *  - a gift used IN the purchase becomes available again;
 *  - the level is re-derived without the purchase (level_down event if it drops).
 *
 * Idempotent: reversing an already reversed purchase is a no-op replay.
 */
export function reversePurchase(rules: LoyaltyRules, state: ClientState, input: ReverseInput, now: Date): Outcome {
  const reason = input.reason?.trim();
  assert(reason, 'INVALID_INPUT', 'reason is required to reverse a purchase');
  const purchase = state.purchases.find((p) => p.id === input.purchaseId);
  assert(purchase, 'PURCHASE_NOT_FOUND', `purchase ${input.purchaseId} not found`);
  if (purchase.status === 'reversed') return { ...emptyOutcome(), replayed: true, purchase };

  const out = emptyOutcome();
  const clientId = state.clientId;
  const levelBefore = deriveLevel(rules, state, now);

  // Ledger: undo every entry of this purchase (accrual and redeem).
  const related = state.ledger.filter((e) => e.purchaseId === purchase.id && (e.type === 'accrual' || e.type === 'redeem'));
  for (const e of related) {
    out.ledger.push({
      clientId,
      type: 'reversal',
      amount: -e.amount,
      purchaseId: purchase.id,
      staffId: input.staffId,
      reason: `${e.type} reversed: ${reason}`,
      createdAt: now,
    });
  }

  // Card: roll back only the latest move.
  const ownMove = state.cardMoves.find((m) => m.purchaseId === purchase.id && m.reason === 'purchase' && !m.revertedAt);
  if (ownMove) {
    if (latestCardMove(state) === ownMove) {
      out.cardMovesReverted.push({ ...ownMove, revertedAt: now });
    } else {
      out.warnings.push(
        `card step (card ${ownMove.cycle}, cell ${ownMove.cell}) was not rolled back: later purchases already moved the card`,
      );
    }
  }

  // Gifts unlocked by this purchase.
  for (const r of state.rewards.filter((x) => x.unlockedByPurchase === purchase.id)) {
    if (r.status === 'available') {
      out.rewardsUpdated.push({ ...r, status: 'revoked' });
    } else if (r.status === 'used') {
      out.warnings.push(
        `gift "${r.title}" (card ${r.cycle}, cell ${r.cell}) unlocked by this purchase was already used${
          r.usedInPurchase ? ` in purchase ${r.usedInPurchase}` : ''
        }; it is kept`,
      );
    }
  }

  // Gift used in this purchase becomes available again.
  if (purchase.rewardUsedId) {
    const used = state.rewards.find((r) => r.id === purchase.rewardUsedId);
    if (used && used.status === 'used') {
      out.rewardsUpdated.push({ ...used, status: 'available', usedInPurchase: null, usedAt: null });
    }
  }

  out.purchase = { ...purchase, status: 'reversed', reversedReason: reason, reversedBy: input.staffId, reversedAt: now };
  out.events.push({ type: 'purchase_reversed', clientId, purchaseId: purchase.id, reason });

  const after = applyOutcome(state, out);
  const balance = balanceFromLedger(after.ledger);
  if (balance < 0) {
    out.warnings.push(`points balance is negative (${balance}): accrued points were already spent`);
  }
  const levelAfter = deriveLevel(rules, after, now);
  if (levelAfter.index < levelBefore.index) {
    out.levelChange = { from: levelBefore.tier.id, to: levelAfter.tier.id };
    out.events.push({ type: 'level_down', clientId, from: levelBefore.tier.id, to: levelAfter.tier.id, reason: 'reversal' });
  }
  return out;
}
