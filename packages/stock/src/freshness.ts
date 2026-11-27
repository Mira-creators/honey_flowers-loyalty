/**
 * Freshness of a lot by its sell-by date (received + sell_days):
 *  overdue — sell-by already passed; today — sell it today; soon — within warn_days; fresh — later.
 * Lots without a sell-by date (supplies) are always 'fresh'.
 */
import { addDays } from './money.js';

export type Freshness = 'overdue' | 'today' | 'soon' | 'fresh';

export function freshnessOf(sellBy: string | null | undefined, warnDays: number, today: string): Freshness {
  if (!sellBy) return 'fresh';
  if (sellBy < today) return 'overdue';
  if (sellBy === today) return 'today';
  if (sellBy <= addDays(today, Math.max(0, warnDays))) return 'soon';
  return 'fresh';
}

export const FRESHNESS_ORDER: Record<Freshness, number> = { overdue: 0, today: 1, soon: 2, fresh: 3 };
