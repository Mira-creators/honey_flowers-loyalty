import { emptyOutcome, type Outcome } from '../outcome.js';
import { applyOutcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { activeCardMoves, balanceFromLedger, deriveLevel } from '../state.js';
import type { ClientState, Reward } from '../types.js';
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
 *  - the points redemption is refunded and the cashback accrual is clawed
 *    back — but only the part that has not expired since (the balance may
 *    still go negative if the accrued points were spent — reported in
 *    `warnings`);
 *  - the card step is rolled back only if it is the client's latest card
 *    move; otherwise the card stays and a warning is returned. Rolling back
 *    the latest step also rolls back the steps right before it that belong to
 *    purchases reversed earlier, so the card never shows a tail of cells
 *    that no active purchase earned (order of reversals does not matter);
 *  - gifts unlocked by the purchase: available → revoked; already used →
 *    kept as used, with a warning;
 *  - a gift used IN the purchase becomes available again, unless the
 *    purchase that unlocked it was reversed or an expiry reset burned the
 *    card since (then it stays unavailable: revoked);
 *  - the level is re-derived without the purchase (level_down event if it drops).
 *  Expiry is NOT settled here: if the reversal moves the activity anchor back
 *  past the due date, the next scheduler run (or the next purchase) burns the
 *  balance; the dashboard already shows it as expired.
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

  // Ledger: refund the redemption in full; claw back only the cashback that
  // is still on the books (an expiry after the purchase already burned it).
  const expiredSince = state.ledger.some((e) => e.type === 'expire' && e.createdAt.getTime() > purchase.createdAt.getTime());
  const related = state.ledger.filter((e) => e.purchaseId === purchase.id && (e.type === 'accrual' || e.type === 'redeem'));
  let accrualAlreadyExpired = 0;
  for (const e of related) {
    if (e.type === 'accrual' && expiredSince) {
      accrualAlreadyExpired += e.amount;
      continue;
    }
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
  if (accrualAlreadyExpired > 0) {
    out.warnings.push(`cashback of this purchase (${accrualAlreadyExpired}) had already expired and is not taken back`);
  }

  // Card: roll back only the latest move, then cascade over stale moves of
  // purchases that were reversed earlier.
  const ownMove = state.cardMoves.find((m) => m.purchaseId === purchase.id && m.reason === 'purchase' && !m.revertedAt);
  if (ownMove) {
    const active = activeCardMoves(state);
    const latest = active[active.length - 1] ?? null;
    if (latest === ownMove) {
      const reversedIds = new Set(state.purchases.filter((p) => p.status === 'reversed').map((p) => p.id));
      for (let i = active.length - 1; i >= 0; i--) {
        const m = active[i]!;
        if (m.reason !== 'purchase') break;
        if (m !== ownMove && !reversedIds.has(m.purchaseId!)) break;
        out.cardMovesReverted.push({ ...m, revertedAt: now });
      }
    } else if (latest?.reason === 'expiry_reset' || active.some((m) => m.reason === 'expiry_reset' && m.createdAt.getTime() > ownMove.createdAt.getTime())) {
      out.warnings.push(`card step (card ${ownMove.cycle}, cell ${ownMove.cell}) was not rolled back: the card was reset since`);
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

  // Gift used in this purchase becomes available again — only if it is still
  // legitimately the client's: its unlocking purchase is active and no card
  // reset happened since it was unlocked.
  if (purchase.rewardUsedId) {
    const used = state.rewards.find((r) => r.id === purchase.rewardUsedId);
    if (used && used.status === 'used') {
      out.rewardsUpdated.push(restoreOrRevoke(state, used, purchase.id, out.warnings));
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

function restoreOrRevoke(state: ClientState, used: Reward, reversedPurchaseId: string, warnings: string[]): Reward {
  const unlocker = used.unlockedByPurchase ? state.purchases.find((p) => p.id === used.unlockedByPurchase) : null;
  const unlockerActive = !used.unlockedByPurchase || (unlocker !== null && unlocker !== undefined && unlocker.status === 'active' && unlocker.id !== reversedPurchaseId);
  const resetSince = state.cardMoves.some((m) => m.reason === 'expiry_reset' && m.createdAt.getTime() > used.unlockedAt.getTime());
  if (unlockerActive && !resetSince) {
    return { ...used, status: 'available', usedInPurchase: null, usedAt: null };
  }
  warnings.push(
    `gift "${used.title}" (card ${used.cycle}, cell ${used.cell}) used in this purchase is not returned: ${
      resetSince ? 'the card was reset since' : 'the purchase that unlocked it was reversed'
    }`,
  );
  return { ...used, status: 'revoked', usedInPurchase: null, usedAt: null };
}
