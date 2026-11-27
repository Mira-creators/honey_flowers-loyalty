/**
 * Disassembly of an unsold bouquet (architecture §2.6): every stem goes back into the lot it was
 * taken from (`disassembly_return`, +qty, original received date — freshness is not «rejuvenated»),
 * then the stems the florist marked as not usable leave again as `disassembly_waste` (−qty).
 * Waste is taken from the OLDEST of the bouquet's lots first (FIFO), so the fresher stems stay.
 *
 * Value conservation (QA invariant): Σ return value = −Σ assembly value of the bouquet
 * (deficit-lot stems excepted: they never physically existed in a lot and are only written off);
 * waste value ≤ return value.
 */
import { compareLots, type PickLot } from './fifo.js';

export interface TakenLot extends PickLot {
  /** Quantity the assembly took from this lot (positive). */
  taken: number;
  deficit: boolean;
}

export interface DisassemblyMove {
  lotId: string;
  itemId: string;
  qty: number;
  unitCostMu: number;
  reason: 'disassembly_return' | 'disassembly_waste';
}

/**
 * `good` = usable stems per item (missing item = all usable). Returns moves in insert order:
 * all returns first, then waste (so a lot never goes below 0 inside the statement).
 */
export function planDisassembly(taken: readonly TakenLot[], good: ReadonlyMap<string, number>): { moves: DisassemblyMove[]; waste: Map<string, number> } {
  const returns: DisassemblyMove[] = [];
  const wastes: DisassemblyMove[] = [];
  const wasteByItem = new Map<string, number>();
  const items = [...new Set(taken.map((t) => t.itemId))];
  for (const itemId of items) {
    // Stems taken «в минус» (deficit lot) are not returned: the deficit lot may already be settled by
    // a receipt, and returning into it could push it above 0. Prototype simplification (see docs).
    const normal = taken.filter((t) => t.itemId === itemId && t.taken > 0 && !t.deficit).sort(compareLots);
    const total = normal.reduce((a, t) => a + t.taken, 0);
    const keep = Math.max(0, Math.min(total, good.has(itemId) ? Math.floor(good.get(itemId)!) : total));
    let waste = total - keep;
    wasteByItem.set(itemId, waste);
    for (const t of normal) returns.push({ lotId: t.id, itemId, qty: t.taken, unitCostMu: t.unitCostMu, reason: 'disassembly_return' });
    for (const t of normal) {
      if (waste <= 0) break;
      const w = Math.min(waste, t.taken);
      wastes.push({ lotId: t.id, itemId, qty: -w, unitCostMu: t.unitCostMu, reason: 'disassembly_waste' });
      waste -= w;
    }
  }
  return { moves: [...returns, ...wastes], waste: wasteByItem };
}
