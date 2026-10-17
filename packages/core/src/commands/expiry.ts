import { emptyOutcome, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { balanceFromLedger, cardPosition, deriveLevel, expiryInfo, lastExpiry } from '../state.js';
import type { ClientState } from '../types.js';

/**
 * Which parts of an overdue expiry have already been applied? Derived from
 * stored facts, so re-running the scheduler is harmless:
 *  - ledger: the last `expire` entry is later than the anchor and no points
 *    were credited after it (a refund from a reversal or a late welcome bonus
 *    must still expire);
 *  - level: a level override was set after the anchor;
 *  - card: an expiry reset was recorded after the anchor.
 */
function expiryDone(state: ClientState, anchor: Date): { ledger: boolean; level: boolean; card: boolean } {
  const after = (d: Date) => d.getTime() > anchor.getTime();
  const lastExpire = lastExpiry(state);
  const ledger =
    lastExpire !== null &&
    after(lastExpire.createdAt) &&
    !state.ledger.some((e) => e.amount > 0 && e.createdAt.getTime() > lastExpire.createdAt.getTime());
  const level = state.levelOverride !== null && after(state.levelOverride.setAt);
  const card = state.cardMoves.some((m) => m.reason === 'expiry_reset' && after(m.createdAt));
  return { ledger, level, card };
}

/**
 * Apply expiry if it is due at `now` (no warnings). Called by runExpiry and
 * at the start of purchase/redeem/manual adjustment so a late scheduler
 * cannot "save" points.
 *
 * Due when `expiryDays` local calendar days have passed since the last
 * activity: last purchase on day D, expiry on day D + expiryDays.
 */
export function settleExpiry(rules: LoyaltyRules, state: ClientState, now: Date): Outcome {
  const out = emptyOutcome();
  const info = expiryInfo(rules, state, now);
  if (info.daysLeft > 0) return out;
  const done = expiryDone(state, info.anchor);

  const mode = rules.expiry.onExpiry;
  const balance = balanceFromLedger(state.ledger);
  const level = deriveLevel(rules, state, now);
  const pos = cardPosition(rules, state);
  const burnsBalance = balance > 0 && !done.ledger;
  const touchesLevel = mode !== 'balance_only' && level.index > 0 && !done.level;
  const touchesCard = mode === 'reset_all' && !done.card && (pos.filled > 0 || state.rewards.some((r) => r.status === 'available'));
  if (!burnsBalance && !touchesLevel && !touchesCard) return out;

  out.notificationKeys.push(`expired:${info.anchorKey}`);

  if (burnsBalance) {
    out.ledger.push({
      clientId: state.clientId,
      type: 'expire',
      amount: -balance,
      purchaseId: null,
      staffId: null,
      reason: `no purchases for ${rules.expiry.expiryDays} days (since ${info.anchorKey})`,
      createdAt: now,
    });
    out.events.push({ type: 'points_expired', clientId: state.clientId, amount: balance });
  }

  if (touchesLevel) {
    const tiers = rules.levels.tiers;
    const newIndex = mode === 'reset_all' ? 0 : level.index - 1;
    const to = tiers[newIndex]!;
    out.levelOverride = { levelId: to.id, setAt: now, levelIndex: newIndex };
    out.levelChange = { from: level.tier.id, to: to.id };
    out.events.push({ type: 'level_down', clientId: state.clientId, from: level.tier.id, to: to.id, reason: 'expiry' });
  } else if (mode === 'reset_all' && !done.level) {
    // Still restart the level metric so old purchases do not count again.
    out.levelOverride = { levelId: rules.levels.tiers[0]!.id, setAt: now, levelIndex: 0 };
  }

  if (touchesCard) {
    // Start a fresh card (next cycle) and burn gifts that were not used.
    out.cardMoves.push({
      clientId: state.clientId,
      purchaseId: null,
      cycle: pos.filled > 0 ? pos.cycle + 1 : pos.cycle,
      cell: 0,
      reason: 'expiry_reset',
      createdAt: now,
    });
    for (const r of state.rewards.filter((x) => x.status === 'available')) {
      out.rewardsUpdated.push({ ...r, status: 'revoked' });
    }
    out.events.push({ type: 'card_reset', clientId: state.clientId });
  }
  return out;
}

/**
 * Scheduler entry point for one client: expires points that are due and
 * emits expiry warnings `expiryWarnDays` days before expiry.
 *
 * Warnings are deduplicated with keys `expiry_warning:<anchor>:<day>` kept in
 * `state.sentNotificationKeys`. If the scheduler missed a day, only the most
 * urgent pending warning is sent (with the real number of days left) and the
 * skipped ones are marked as sent.
 */
export function runExpiry(rules: LoyaltyRules, state: ClientState, now: Date): Outcome {
  const expired = settleExpiry(rules, state, now);
  if (expired.ledger.length || expired.levelOverride !== undefined || expired.cardMoves.length) return expired;

  const out = emptyOutcome();
  const balance = balanceFromLedger(state.ledger);
  if (balance <= 0) return out;
  const info = expiryInfo(rules, state, now);
  if (info.daysLeft <= 0) return out;

  const sent = new Set(state.sentNotificationKeys);
  const pending = [...new Set(rules.expiry.expiryWarnDays)]
    .filter((d) => info.daysLeft <= d)
    .map((d) => ({ d, key: `expiry_warning:${info.anchorKey}:${d}` }))
    .filter((w) => !sent.has(w.key));
  if (pending.length === 0) return out;

  out.notificationKeys.push(...pending.map((w) => w.key));
  out.events.push({
    type: 'expiry_warning',
    clientId: state.clientId,
    daysLeft: info.daysLeft,
    balance,
    expiresOn: info.expiresOn,
  });
  return out;
}
