/**
 * Randomized properties of the stock math (deterministic seeds, like packages/core/test/property.test.ts):
 *  - allocation: Σ parts = total exactly, parts ≥ 0, monotone in weight;
 *  - receipt: Σ line values = delivery total exactly (total mode), Σ landed = extra exactly,
 *    unit × qty + rounding = value + landed for every line;
 *  - ledger model: random receipts / assemblies / disassemblies / write-offs with FIFO picking —
 *    cost conservation (Σ lot values received = Σ consumed + Σ remaining), FIFO order,
 *    lots never negative, never above what was received.
 */
import { describe, expect, it } from 'vitest';
import {
  computeReceipt,
  largestRemainder,
  pickLots,
  planDisassembly,
  compareLots,
  type PickLot,
  type ReceiptItemInfo,
  type ReceiptLineInput,
} from '../src/index.js';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RUNS = Number(process.env.PROPERTY_RUNS ?? 300);

describe('property: largestRemainder', () => {
  it('Σ = total, non-negative, bigger weight never gets less', () => {
    for (let s = 1; s <= RUNS; s++) {
      const r = mulberry32(s);
      const n = 1 + Math.floor(r() * 12);
      const weights = Array.from({ length: n }, () => BigInt(Math.floor(r() * (r() < 0.2 ? 3 : 1_000_000))));
      const total = BigInt(Math.floor(r() * 1e12));
      const parts = largestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      for (const p of parts) expect(p >= 0n).toBe(true);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (weights[i]! > weights[j]!) expect(parts[i]! >= parts[j]!).toBe(true);
    }
  });
});

describe('property: receipt allocation', () => {
  it('total mode sums to the delivery total exactly; extra costs sum exactly; per-line conservation', () => {
    for (let s = 1; s <= RUNS; s++) {
      const r = mulberry32(1000 + s);
      const n = 1 + Math.floor(r() * 15);
      const infos: ReceiptItemInfo[] = Array.from({ length: n }, (_, i) => ({
        id: `i${i}`, name: `i${i}`, kind: r() < 0.7 ? 'flower' : 'supply', packSize: r() < 0.6 ? 10 + Math.floor(r() * 40) : null, trackStock: true,
        lastCostMu: r() < 0.6 ? 1 + Math.floor(r() * 30_000_000) : null, stdCostMu: r() < 0.3 ? Math.floor(r() * 5_000_000) : null,
      }));
      const usd = r() < 0.4;
      const fx = usd ? 1_100_000 + Math.floor(r() * 300_000) : null;
      const total = r() < 0.5;
      const lines: ReceiptLineInput[] = infos.map((it) => {
        const unit = it.packSize && r() < 0.5 ? 'pack' : 'base';
        const qty = 1 + Math.floor(r() * (unit === 'pack' ? 5 : 300));
        const manual = !total || r() < 0.2;
        if (!manual) return { itemId: it.id, qty, unit };
        const per = r() < 0.5 ? 'unit' : it.packSize && r() < 0.5 ? 'pack' : 'line';
        return { itemId: it.id, qty, unit, price: Math.floor(r() * (usd ? 500 : 50_000)), per };
      });
      const map = new Map(infos.map((x) => [x.id, x]));
      const fixedApprox = 10_000_000; // big enough: total ≥ manual lines
      const extra = Math.floor(r() * 200_000);
      const input = { currency: (usd ? 'USD' : 'UZS') as 'USD' | 'UZS', fxRateX100: fx, priceMode: (total ? 'total' : 'lines') as 'total' | 'lines', total: total ? (usd ? 100_000 + Math.floor(r() * 400_000) : fixedApprox + Math.floor(r() * 1e7)) : null, extraCostUzs: extra, lines };
      let res;
      try {
        res = computeReceipt(input, map);
      } catch (e) {
        // all lines manual + sum ≠ total is a legit rejection
        if ((e as { code?: string }).code !== 'receipt_total_short') throw e;
        continue;
      }
      if (total) {
        const totalMu = usd ? (BigInt(input.total!) * BigInt(fx!) * 2n + 10n) / 20n : BigInt(input.total!) * 1000n;
        expect(res.goodsMu).toBe(totalMu);
      }
      expect(res.lines.reduce((a, l) => a + l.landedMu, 0n)).toBe(BigInt(extra) * 1000n);
      for (const l of res.lines) {
        expect(BigInt(l.unitCostMu) * BigInt(l.qtyBase) + BigInt(l.roundingMu)).toBe(l.valueMu + l.landedMu);
        expect(Math.abs(l.roundingMu)).toBeLessThanOrEqual(Math.ceil(l.qtyBase / 2));
        expect(l.unitCostMu).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('property: ledger model with FIFO', () => {
  it('conservation, FIFO order, 0 ≤ lot ≤ received', () => {
    for (let s = 1; s <= Math.max(50, RUNS / 3); s++) {
      const r = mulberry32(5000 + s);
      const itemsN = 1 + Math.floor(r() * 4);
      interface Lot extends PickLot { received: number }
      const lots: Lot[] = [];
      const moves: Array<{ lotId: string; qty: number; valueMu: bigint }> = [];
      const bouquets: Array<{ taken: Array<Lot & { taken: number; deficit: boolean }> }> = [];
      let day = 1;
      for (let step = 0; step < 120; step++) {
        const op = r();
        const itemId = `i${Math.floor(r() * itemsN)}`;
        if (op < 0.25) {
          const qty = 1 + Math.floor(r() * 50);
          const cost = Math.floor(r() * 20_000_000);
          const id = `L${lots.length}`;
          const d = String(++day).padStart(2, '0');
          lots.push({ id, itemId, qty, received: qty, unitCostMu: cost, priority: r() < 0.1 ? 1 : 0, expiresOn: `2026-12-${d}`, receivedAt: `2026-11-${d}T10:00:00Z` });
          moves.push({ lotId: id, qty, valueMu: BigInt(qty) * BigInt(cost) });
        } else if (op < 0.8) {
          const demand = [{ itemId, qty: 1 + Math.floor(r() * 30) }];
          const { picks, short } = pickLots(lots, demand, { policy: 'block', confirmedShort: false, deficitCostMu: () => 0 });
          if (short.length) {
            const have = lots.filter((l) => l.itemId === itemId).reduce((a, l) => a + l.qty, 0);
            expect(short[0]!.have).toBe(have);
            continue;
          }
          // FIFO: picks follow the pick order and only the LAST lot may be partial
          const order = lots.filter((l) => l.itemId === itemId && l.qty > 0).sort(compareLots).map((l) => l.id);
          expect(picks.map((p) => p.lotId)).toEqual(order.slice(0, picks.length));
          picks.forEach((p, i) => {
            const lot = lots.find((l) => l.id === p.lotId)!;
            if (i < picks.length - 1) expect(p.qty).toBe(lot.qty);
          });
          const taken: Array<Lot & { taken: number; deficit: boolean }> = [];
          for (const p of picks) {
            const lot = lots.find((l) => l.id === p.lotId)!;
            lot.qty -= p.qty;
            moves.push({ lotId: lot.id, qty: -p.qty, valueMu: -p.valueMu });
            taken.push({ ...lot, taken: p.qty, deficit: false });
          }
          bouquets.push({ taken });
        } else if (op < 0.9 && bouquets.length) {
          const b = bouquets.splice(Math.floor(r() * bouquets.length), 1)[0]!;
          const good = new Map<string, number>();
          for (const t of b.taken) good.set(t.itemId, Math.floor(r() * (t.taken + 2)));
          const { moves: dm } = planDisassembly(b.taken, good);
          for (const m of dm) {
            const lot = lots.find((l) => l.id === m.lotId)!;
            lot.qty += m.qty;
            expect(lot.qty).toBeGreaterThanOrEqual(0); // returns come before waste
            moves.push({ lotId: lot.id, qty: m.qty, valueMu: BigInt(m.qty) * BigInt(lot.unitCostMu) });
          }
          const ret = dm.filter((m) => m.reason === 'disassembly_return').reduce((a, m) => a + BigInt(m.qty) * BigInt(m.unitCostMu), 0n);
          const cost = b.taken.reduce((a, t) => a + BigInt(t.taken) * BigInt(t.unitCostMu), 0n);
          expect(ret).toBe(cost);
        } else {
          // write-off FIFO
          const { picks, short } = pickLots(lots, [{ itemId, qty: 1 + Math.floor(r() * 5) }], { policy: 'block', confirmedShort: false, deficitCostMu: () => 0 });
          if (short.length) continue;
          for (const p of picks) {
            const lot = lots.find((l) => l.id === p.lotId)!;
            lot.qty -= p.qty;
            moves.push({ lotId: lot.id, qty: -p.qty, valueMu: -p.valueMu });
          }
        }
        for (const l of lots) {
          expect(l.qty).toBeGreaterThanOrEqual(0);
          expect(l.qty).toBeLessThanOrEqual(l.received);
          const sum = moves.filter((m) => m.lotId === l.id).reduce((a, m) => a + m.qty, 0);
          expect(sum).toBe(l.qty);
        }
      }
      // Σ value received = Σ consumed (negative moves) + Σ remaining
      const received = lots.reduce((a, l) => a + BigInt(l.received) * BigInt(l.unitCostMu), 0n);
      const remaining = lots.reduce((a, l) => a + BigInt(l.qty) * BigInt(l.unitCostMu), 0n);
      const net = moves.reduce((a, m) => a + m.valueMu, 0n);
      expect(net).toBe(remaining);
      const consumed = received - remaining;
      expect(consumed >= 0n).toBe(true);
    }
  });
});
