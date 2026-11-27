/**
 * Bouquet cost (architecture §4.9) and suggested price (§4.10).
 *
 * cost_mu           = Σ picks qty × unit_cost_mu + Σ untracked qty × std_cost_mu
 * flowers_cost_uzs  = round_half_up(Σ value of flower + greenery lines / 1000)
 * supplies_cost_uzs = round_half_up(Σ value of supply lines / 1000)
 * cost_uzs          = flowers + supplies   (so the two parts always add up on screen)
 * raw   = (Σ flower value × m_flowers + Σ supply value × m_supplies) × (1 + labour%)
 * price = ceil((raw − offset) / step) × step + offset     → prices like …5 000
 */
import type { StockConfig } from './config.js';
import { divCeil, muToUzs } from './money.js';
import { isFlowerKind, type StockKind } from './types.js';

export interface CostLine {
  kind: StockKind;
  valueMu: bigint;
  /** Item's own multiplier × 100 (300 = 3,0×), overrides the kind's multiplier. */
  markupX100?: number | null;
}

export interface BouquetCost {
  costMu: bigint;
  flowersCostUzs: number;
  suppliesCostUzs: number;
  costUzs: number;
}

export function bouquetCost(lines: readonly CostLine[]): BouquetCost {
  let flowers = 0n;
  let supplies = 0n;
  for (const l of lines) {
    if (isFlowerKind(l.kind)) flowers += l.valueMu;
    else supplies += l.valueMu;
  }
  const flowersCostUzs = muToUzs(flowers);
  const suppliesCostUzs = muToUzs(supplies);
  return { costMu: flowers + supplies, flowersCostUzs, suppliesCostUzs, costUzs: flowersCostUzs + suppliesCostUzs };
}

export function roundPrice(raw: number, step: number, offset: number): number {
  if (!(raw > 0)) return 0;
  if (step <= 0) return Math.ceil(raw);
  const k = Number(divCeil(BigInt(Math.ceil(raw)) - BigInt(offset), BigInt(step)));
  return Math.max(k, 0) * step + offset;
}

/** Suggested price in сум. Multipliers are applied per line (an item markup overrides its kind's). */
export function suggestPrice(lines: readonly CostLine[], pricing: StockConfig['pricing']): number {
  // Work in mu × 100 to keep 2,5× exact: Σ value × multiplier_x100.
  let raw = 0n;
  for (const l of lines) {
    const mx100 = l.markupX100 ?? Math.round((isFlowerKind(l.kind) ? pricing.flowersMultiplier : pricing.suppliesMultiplier) * 100);
    raw += l.valueMu * BigInt(mx100);
  }
  const labourX100 = BigInt(100 + Math.round(pricing.labourPct));
  // raw (mu×100) × (100+labour)/100 / 100 / 1000 → сум
  const rawUzs = Number(raw * labourX100) / 1e7;
  return roundPrice(rawUzs, pricing.round.step, pricing.round.offset);
}

export type ShareLevel = 'good' | 'warn' | 'bad';

/** Green ≤ target, amber ≤ target + band, red above. share and target are fractions / percents. */
export function shareLevel(share: number, targetPct: number, amberBandPp: number): ShareLevel {
  const pct = share * 100;
  if (pct <= targetPct + 1e-9) return 'good';
  if (pct <= targetPct + amberBandPp + 1e-9) return 'warn';
  return 'bad';
}

export function shares(cost: BouquetCost, price: number): { costShare: number; flowersShare: number } {
  if (!(price > 0)) return { costShare: 0, flowersShare: 0 };
  return { costShare: cost.costUzs / price, flowersShare: cost.flowersCostUzs / price };
}
