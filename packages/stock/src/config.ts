/**
 * Stock settings (`settings.stock_config`, JSON). Defaults = architecture Appendix B and
 * docs/Спорные вопросы.md section 4 (С1–С7). The Worker validates the owner's edits with zod;
 * this file has no dependencies so the Mini App can use the same defaults.
 */
import type { StaffRole, StockKind } from './types.js';

export type NegativePolicy = 'block' | 'warn' | 'allow';

export interface LifeDefaults {
  vaseLifeDays: number | null;
  sellDays: number | null;
  warnDays: number;
}

export interface StockConfig {
  /** С3: a bouquet «в минус» — `warn` = allowed after confirmation with a comment. */
  negativePolicy: NegativePolicy;
  /**
   * С2: who may post receipts. In this app florist and manager are both «Сотрудник»; the owner's
   * «менеджеры» are the shop staff, so by default every staff role may receive goods.
   */
  receiptRoles: StaffRole[];
  /** Receipts may be dated up to N days back (owner only). */
  backdateDays: number;
  /** A florist may cancel their own assembly within N hours (owner: always). */
  assemblyCancelHours: number;
  /** С4: write-offs from this value (сум) wait for the owner's approval. */
  writeoffApprovalUzs: number;
  labourInCost: boolean;
  pricing: {
    flowersMultiplier: number;
    suppliesMultiplier: number;
    labourPct: number;
    round: { step: number; offset: number };
    targets: { costShare: number; flowersShare: number; amberBandPp: number };
    priceMode: 'suggest' | 'fixed';
  };
  wasteTargets: { normPct: number; alarmPct: number };
  showcaseStaleDays: number;
  /** С7: vase life / sell days per group, applied when an item is created. */
  defaults: Record<'rose' | 'tulip' | 'eustoma' | 'chrysanthemum' | 'flower' | 'greenery' | 'supply', LifeDefaults>;
}

export const DEFAULT_STOCK_CONFIG: StockConfig = {
  negativePolicy: 'warn',
  receiptRoles: ['owner', 'manager', 'florist'],
  backdateDays: 3,
  assemblyCancelHours: 2,
  writeoffApprovalUzs: 200_000,
  labourInCost: false,
  pricing: {
    flowersMultiplier: 3,
    suppliesMultiplier: 2.5,
    labourPct: 20,
    round: { step: 10_000, offset: 5_000 },
    targets: { costShare: 33, flowersShare: 25, amberBandPp: 5 },
    priceMode: 'suggest',
  },
  wasteTargets: { normPct: 10, alarmPct: 15 },
  showcaseStaleDays: 2,
  defaults: {
    rose: { vaseLifeDays: 7, sellDays: 4, warnDays: 1 },
    tulip: { vaseLifeDays: 5, sellDays: 3, warnDays: 1 },
    eustoma: { vaseLifeDays: 10, sellDays: 6, warnDays: 2 },
    chrysanthemum: { vaseLifeDays: 14, sellDays: 8, warnDays: 2 },
    flower: { vaseLifeDays: 7, sellDays: 4, warnDays: 1 },
    greenery: { vaseLifeDays: 10, sellDays: 6, warnDays: 2 },
    supply: { vaseLifeDays: null, sellDays: null, warnDays: 0 },
  },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of a stored (possibly partial / older) config over the defaults. Arrays replace. */
export function mergeStockConfig(stored: unknown, base: StockConfig = DEFAULT_STOCK_CONFIG): StockConfig {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlain(a) || !isPlain(b)) return b === undefined ? a : b;
    const out: Plain = { ...a };
    for (const [k, v] of Object.entries(b)) if (k in a) out[k] = merge(a[k], v);
    return out;
  };
  return merge(structuredCloneJson(base), isPlain(stored) ? stored : {}) as StockConfig;
}

const structuredCloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Default life of a new item by its kind and group name (С7). */
export function lifeDefaultsFor(cfg: StockConfig, kind: StockKind, group: string): LifeDefaults {
  if (kind === 'supply' || kind === 'service') return cfg.defaults.supply;
  if (kind === 'greenery') return cfg.defaults.greenery;
  const g = group.toLowerCase();
  if (g.startsWith('роз')) return cfg.defaults.rose;
  if (g.startsWith('тюльп')) return cfg.defaults.tulip;
  if (g.startsWith('эустом')) return cfg.defaults.eustoma;
  if (g.startsWith('хризант')) return cfg.defaults.chrysanthemum;
  return cfg.defaults.flower;
}

/** What the Mini App needs (no secrets in the config, but keep the DTO small). */
export function publicConfig(cfg: StockConfig) {
  return {
    pricing: cfg.pricing,
    negativePolicy: cfg.negativePolicy,
    writeoffApprovalUzs: cfg.writeoffApprovalUzs,
    assemblyCancelHours: cfg.assemblyCancelHours,
    receiptRoles: cfg.receiptRoles,
    backdateDays: cfg.backdateDays,
  };
}
