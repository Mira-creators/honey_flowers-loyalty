export type StockKind = 'flower' | 'greenery' | 'supply' | 'service';
export type BaseUnit = 'stem' | 'pcs' | 'cm' | 'sheet' | 'g';
export type StaffRole = 'florist' | 'manager' | 'owner';
export type Currency = 'UZS' | 'USD';

/** Kinds whose cost counts as «цветы» for the 25 % target. */
export const isFlowerKind = (k: StockKind) => k === 'flower' || k === 'greenery';
