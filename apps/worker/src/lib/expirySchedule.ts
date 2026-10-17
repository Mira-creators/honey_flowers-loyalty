import {
  balanceFromLedger,
  dayNumberFromKey,
  expiryInfo,
  keyFromDayNumber,
  localDateKey,
  settleExpiry,
  type ClientState,
  type LoyaltyRules,
} from '@honey/core';
import { hasEffects } from '@honey/service';

/** clients.next_check_on value meaning "nothing can happen until new activity". */
export const NEVER = '9999-12-31';

/**
 * Local date (YYYY-MM-DD) on which the daily job must look at this client
 * again: the next unsent expiry warning or the expiry day itself. Computed on
 * the state AFTER the current run's outcome was applied. Any write to the
 * client's ledger/purchases resets clients.next_check_on to NULL = "check on
 * the next run", so a too-late date here can only delay, never lose, an
 * expiry — and the engine still settles overdue expiry inside every purchase.
 */
export function nextCheckOn(rules: LoyaltyRules, state: ClientState, now: Date): string {
  const info = expiryInfo(rules, state, now);
  if (info.daysLeft <= 0) {
    // Overdue: the engine decides whether anything is still left to expire.
    return hasEffects(settleExpiry(rules, state, now)) ? localDateKey(now, rules.timezone) : NEVER;
  }
  const balance = balanceFromLedger(state.ledger);
  const dates: string[] = [];
  if (balance > 0) {
    const sent = new Set(state.sentNotificationKeys);
    for (const d of rules.expiry.expiryWarnDays) {
      if (d < info.daysLeft && !sent.has(`expiry_warning:${info.anchorKey}:${d}`)) {
        dates.push(keyFromDayNumber(dayNumberFromKey(info.expiresOn) - d));
      }
    }
  }
  if (balance > 0 || rules.expiry.onExpiry !== 'balance_only') dates.push(info.expiresOn);
  return dates.length ? dates.sort()[0]! : NEVER;
}
