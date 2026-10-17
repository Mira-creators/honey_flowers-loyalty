import { balanceFromLedger } from '../state.js';
import { emptyOutcome, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import type { ClientState } from '../types.js';

/**
 * Registration effects: credits the welcome bonus (rules.welcomeBonus) once.
 * Idempotent: a client who already got a welcome entry gets nothing.
 */
export function registerClient(rules: LoyaltyRules, state: ClientState, now: Date): Outcome {
  const out = emptyOutcome();
  const amount = rules.welcomeBonus;
  if (amount <= 0) return out;
  if (state.ledger.some((e) => e.type === 'welcome')) {
    out.replayed = true;
    return out;
  }
  out.ledger.push({
    clientId: state.clientId,
    type: 'welcome',
    amount,
    purchaseId: null,
    staffId: null,
    reason: 'welcome bonus',
    createdAt: now,
  });
  out.events.push({
    type: 'welcome_bonus',
    clientId: state.clientId,
    amount,
    balance: balanceFromLedger(state.ledger) + amount,
  });
  return out;
}
