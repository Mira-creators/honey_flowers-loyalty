/**
 * Disassembly of an unsold bouquet (architecture §2.6): every stem goes back into the lot it was
 * taken from (`disassembly_return`, +qty, original received date — freshness is not «rejuvenated»),
 * then the stems the florist marked as not usable leave again as `disassembly_waste` (−qty).
 * Waste is taken from the OLDEST of the bouquet's lots first (FIFO), so the fresher stems stay.
 *
 * Value conservation (QA invariant): Σ return value = −Σ assembly value of the bouquet
 * (deficit-lot stems: back into the deficit lot while its shortage is open, else into the settling receipt lots);
 * waste value ≤ return value.
 */
import { compareLots, type PickLot } from './fifo.js';

export interface RefillLot extends PickLot {
  /** How many stems the lot can take back (qty_received − qty_on_hand). */
  room: number;
}

export interface TakenLot extends PickLot {
  /** Quantity the assembly took from this lot (positive). */
  taken: number;
  deficit: boolean;
  /** Deficit lot only: how much of its shortage is still open now (−qty_on_hand ≥ 0). */
  deficitOpen?: number;
  /** Deficit lot only: receipt lots that settled it (newest first) — stems beyond the open shortage go back there. */
  refill?: RefillLot[];
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
 *
 * Stems taken «в минус» physically exist (they were in the bucket, only not received yet). They go back
 * (audit API-1: they used to vanish, and a late receipt then «settled» a shortage that no longer existed):
 *  - while the deficit lot's shortage is still open — into the deficit lot (the shortage shrinks);
 *  - the part a receipt has already settled — into the receipt lots that settled it (up to their room).
 * Waste is taken from the real lots first (oldest first), then from what would go back to the deficit lot.
 */
export function planDisassembly(taken: readonly TakenLot[], good: ReadonlyMap<string, number>): { moves: DisassemblyMove[]; waste: Map<string, number> } {
  const returns: DisassemblyMove[] = [];
  const wastes: DisassemblyMove[] = [];
  const wasteByItem = new Map<string, number>();
  const items = [...new Set(taken.map((t) => t.itemId))];
  for (const itemId of items) {
    const mine = taken.filter((t) => t.itemId === itemId && t.taken > 0);
    // real lots the stems go back to: the ones they came from + receipt lots that settled a deficit
    const real = new Map<string, { lot: PickLot; qty: number }>();
    const add = (lot: PickLot, q: number) => { if (q <= 0) return; const r = real.get(lot.id); if (r) r.qty += q; else real.set(lot.id, { lot, qty: q }); };
    const toDeficit: Array<{ lot: TakenLot; qty: number }> = [];
    for (const t of mine) {
      if (!t.deficit) { add(t, t.taken); continue; }
      const back = Math.min(t.taken, Math.max(0, t.deficitOpen ?? 0));
      if (back > 0) toDeficit.push({ lot: t, qty: back });
      let rest = t.taken - back;
      for (const r of t.refill ?? []) {
        if (rest <= 0) break;
        const already = real.get(r.id)?.qty ?? 0;
        const q = Math.min(rest, Math.max(0, r.room - already));
        add(r, q);
        rest -= q;
      }
    }
    const realList = [...real.values()].sort((a, z) => compareLots(a.lot, z.lot));
    const total = realList.reduce((a, x) => a + x.qty, 0) + toDeficit.reduce((a, x) => a + x.qty, 0);
    const keep = Math.max(0, Math.min(total, good.has(itemId) ? Math.floor(good.get(itemId)!) : total));
    let waste = total - keep;
    wasteByItem.set(itemId, waste);
    for (const x of realList) returns.push({ lotId: x.lot.id, itemId, qty: x.qty, unitCostMu: x.lot.unitCostMu, reason: 'disassembly_return' });
    for (const x of realList) {
      if (waste <= 0) break;
      const w = Math.min(waste, x.qty);
      wastes.push({ lotId: x.lot.id, itemId, qty: -w, unitCostMu: x.lot.unitCostMu, reason: 'disassembly_waste' });
      waste -= w;
    }
    // stems written off out of the «в минус» part simply do not reduce the shortage
    for (const d of toDeficit) {
      const w = Math.min(waste, d.qty);
      waste -= w;
      if (d.qty - w > 0) returns.push({ lotId: d.lot.id, itemId, qty: d.qty - w, unitCostMu: d.lot.unitCostMu, reason: 'disassembly_return' });
    }
  }
  return { moves: [...returns, ...wastes], waste: wasteByItem };
}
