/**
 * Lot picking (architecture §4.3): FIFO/FEFO over the open lots of each item.
 * Order: priority DESC («в букет первыми»), expires_on (FEFO, unknown last), received_at (FIFO), id.
 * Deterministic: the same lots and demand always give the same picks.
 *
 * Shortage handling by policy:
 *  - block: shortage → `short`, no picks for that demand are usable (caller answers 409 stock_short);
 *  - warn:  same, unless `confirmedShort` → the missing quantity goes to the item's deficit lot;
 *  - allow: silently to the deficit lot.
 */
import type { NegativePolicy } from './config.js';

export interface PickLot {
  id: string;
  itemId: string;
  /** Open quantity (qty_on_hand), base units. */
  qty: number;
  unitCostMu: number;
  priority: number;
  expiresOn: string | null;
  receivedAt: string;
}

export interface Demand {
  itemId: string;
  qty: number;
}

export interface Pick {
  lotId: string;
  itemId: string;
  /** Positive quantity taken from the lot. */
  qty: number;
  unitCostMu: number;
  /** qty × unitCostMu. */
  valueMu: bigint;
  deficit: boolean;
}

export interface Shortage {
  itemId: string;
  need: number;
  have: number;
}

export const deficitLotId = (itemId: string, costMu: number) => `def:${itemId}:${costMu}`;

export function compareLots(a: PickLot, b: PickLot): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ea = a.expiresOn ?? '9999-12-31';
  const eb = b.expiresOn ?? '9999-12-31';
  if (ea !== eb) return ea < eb ? -1 : 1;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface PickOptions {
  policy: NegativePolicy;
  confirmedShort: boolean;
  /** Cost of one unit sold «в минус» (last receipt cost → std cost → 0). */
  deficitCostMu: (itemId: string) => number;
}

export function pickLots(lots: readonly PickLot[], demand: readonly Demand[], opts: PickOptions): { picks: Pick[]; short: Shortage[] } {
  const byItem = new Map<string, PickLot[]>();
  for (const l of lots) {
    if (l.qty <= 0) continue;
    const arr = byItem.get(l.itemId) ?? [];
    arr.push(l);
    byItem.set(l.itemId, arr);
  }
  const picks: Pick[] = [];
  const short: Shortage[] = [];
  const toDeficit = opts.policy === 'allow' || (opts.policy === 'warn' && opts.confirmedShort);
  for (const d of demand) {
    if (!Number.isSafeInteger(d.qty) || d.qty <= 0) continue;
    const open = (byItem.get(d.itemId) ?? []).slice().sort(compareLots);
    const have = open.reduce((a, l) => a + l.qty, 0);
    let need = d.qty;
    for (const l of open) {
      if (need <= 0) break;
      const q = Math.min(need, l.qty);
      picks.push({ lotId: l.id, itemId: d.itemId, qty: q, unitCostMu: l.unitCostMu, valueMu: BigInt(q) * BigInt(l.unitCostMu), deficit: false });
      need -= q;
    }
    if (need > 0) {
      short.push({ itemId: d.itemId, need: d.qty, have });
      if (toDeficit) {
        const cost = Math.max(0, Math.round(opts.deficitCostMu(d.itemId)));
        picks.push({ lotId: deficitLotId(d.itemId, cost), itemId: d.itemId, qty: need, unitCostMu: cost, valueMu: BigInt(need) * BigInt(cost), deficit: true });
      }
    }
  }
  return { picks, short };
}

/** Is the shortage blocking for this policy (→ 409 stock_short)? */
export const shortBlocks = (short: readonly Shortage[], policy: NegativePolicy, confirmedShort: boolean) =>
  short.length > 0 && (policy === 'block' || (policy === 'warn' && !confirmedShort));
