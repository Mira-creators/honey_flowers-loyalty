/**
 * Integer money math. Amounts are integer UZS; percentages may be fractional
 * (e.g. 1.5%), so they are converted to basis points and multiplied with
 * BigInt to avoid float error and overflow. All rounding is floor.
 */

/** floor(amount * pct / 100) for a non-negative integer amount. */
export function percentOf(amount: number, pct: number): number {
  if (amount <= 0 || pct <= 0) return 0;
  const bps = BigInt(Math.round(pct * 100));
  return Number((BigInt(amount) * bps) / 10_000n);
}

/** floor(a * b / c) with exact integer arithmetic. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

export function isUzs(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
