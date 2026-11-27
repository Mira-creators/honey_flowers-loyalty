/**
 * Money and quantity arithmetic of the stock module.
 *
 *  - Documents, prices and bouquet costs are integer сум (`*_uzs`).
 *  - The cost of ONE base unit of a lot and the value of a move are integer milli-сум (`*_mu`,
 *    1 сум = 1000 mu), so FIFO keeps value exactly (ribbon at 4,8 сум/cm loses nothing).
 *  - Multiplications that may leave the safe-integer range are done in BigInt.
 */

export const MU_PER_UZS = 1000n;

/** Max quantity of one document line in base units (10 km of ribbon in cm). */
export const MAX_LINE_QTY = 1_000_000;
/** Max cost of one base unit: 100 млн сум. */
export const MAX_UNIT_COST_MU = 100_000_000_000;
/** Max value of one line / one document: 1 трлн сум in mu (well below 2^53). */
export const MAX_VALUE_MU = 1_000_000_000_000_000n;

/** n / d rounded half away from zero (d > 0). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divRound: divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** n / d rounded up (ceil) for d > 0. */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divCeil: divisor must be positive');
  return n >= 0n ? (n + d - 1n) / d : -((-n) / d);
}

/** milli-сум → сум, half up (half away from zero). */
export function muToUzs(mu: bigint | number): number {
  return Number(divRound(BigInt(mu), MU_PER_UZS));
}

export const uzsToMu = (uzs: number): bigint => BigInt(uzs) * MU_PER_UZS;

/** BigInt → Number, throwing when the value is not a safe integer (never silently loses precision). */
export function toSafe(v: bigint, what = 'value'): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`${what} is out of the safe integer range`);
  return Number(v);
}

/** Calendar day arithmetic on 'YYYY-MM-DD' keys (UTC-based, no DST issues). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Asia/Tashkent (UTC+5, no DST) calendar day of an instant. */
export function tashkentDay(d: Date | number | string): string {
  const t = typeof d === 'string' ? Date.parse(d) : typeof d === 'number' ? d : d.getTime();
  return new Date(t + 5 * 3_600_000).toISOString().slice(0, 10);
}
