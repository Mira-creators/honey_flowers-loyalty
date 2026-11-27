/**
 * Largest-remainder (Hamilton) allocation: split an integer `total` into parts proportional to
 * `weights` so that the parts sum to `total` EXACTLY. Used for:
 *  - a receipt entered «одной суммой за поставку» (total → lines by reference price),
 *  - extra costs (delivery, customs) → lines by line value.
 *
 * Deterministic: equal remainders go to the lower index. All weights 0 (or negative, treated as 0)
 * → equal split. total must be ≥ 0.
 */
export function largestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new RangeError('largestRemainder: total must be >= 0');
  const n = weights.length;
  if (n === 0) {
    if (total !== 0n) throw new RangeError('largestRemainder: nothing to allocate to');
    return [];
  }
  let w = weights.map((x) => (x > 0n ? x : 0n));
  let sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    w = w.map(() => 1n);
    sum = BigInt(n);
  }
  const parts: bigint[] = [];
  const rems: Array<{ i: number; r: bigint }> = [];
  let given = 0n;
  for (let i = 0; i < n; i++) {
    const num = total * w[i]!;
    const q = num / sum;
    parts.push(q);
    given += q;
    rems.push({ i, r: num % sum });
  }
  let left = total - given; // 0 ≤ left < n
  // Only parts with a positive weight may receive the remainder.
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rems) {
    if (left <= 0n) break;
    if (w[i]! === 0n) continue;
    parts[i] = parts[i]! + 1n;
    left -= 1n;
  }
  return parts;
}
