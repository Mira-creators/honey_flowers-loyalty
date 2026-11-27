/**
 * Bouquet builder helpers for the phone (A1 «касса флориста за минимум касаний»): undo history,
 * «не хватает / в минус» per line, stable tile order, quick quantities. Pure, no IO.
 */
import type { NegativePolicy } from './config.js';

/** Quick quantities in the «сколько?» sheet: one tap instead of tapping «+» N times. */
export const QTY_PRESETS: readonly number[] = [1, 3, 5, 7, 9, 11, 15, 21, 25, 51];

export interface BuilderSnapshot {
  qty: Record<string, number>;
  planned: Record<string, number> | null;
  templateId: string | null;
  price: string;
  priceEdited: boolean;
}

export interface UndoEntry { label: string; snap: BuilderSnapshot }

/** Max undo steps kept on the phone. */
export const UNDO_LIMIT = 30;

export function snapshotOf(s: BuilderSnapshot): BuilderSnapshot {
  return { qty: { ...s.qty }, planned: s.planned ? { ...s.planned } : null, templateId: s.templateId, price: s.price, priceEdited: s.priceEdited };
}

/** Remember the state BEFORE an action; the oldest entries drop off past `limit`. */
export function pushUndo(stack: readonly UndoEntry[], before: BuilderSnapshot, label: string, limit = UNDO_LIMIT): UndoEntry[] {
  const next = [...stack, { label, snap: snapshotOf(before) }];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Take the last entry: the state to restore and the shorter stack. */
export function popUndo(stack: readonly UndoEntry[]): { entry: UndoEntry | null; stack: UndoEntry[] } {
  if (!stack.length) return { entry: null, stack: [] };
  return { entry: stack[stack.length - 1]!, stack: stack.slice(0, -1) };
}

export interface ShortItemInfo { id: string; name: string; qty: number; trackStock: boolean }
export interface ShortLine { itemId: string; name: string; need: number; have: number; missing: number }
export interface ShortState {
  lines: ShortLine[];
  /** ok — всего хватает; minus — соберётся в минус (с комментарием); blocked — политика запрещает. */
  mode: 'ok' | 'minus' | 'blocked';
}

/** What is missing for this composition, with the shop's negative-stock policy applied. */
export function shortageOf(qty: Record<string, number>, items: readonly ShortItemInfo[], policy: NegativePolicy): ShortState {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: ShortLine[] = [];
  for (const [itemId, need] of Object.entries(qty)) {
    const it = byId.get(itemId);
    if (!it || !it.trackStock || need <= 0) continue;
    const have = Math.max(0, it.qty);
    if (need > have) lines.push({ itemId, name: it.name, need, have, missing: need - have });
  }
  return { lines, mode: lines.length === 0 ? 'ok' : policy === 'block' ? 'blocked' : 'minus' };
}

export interface TileOrderInfo { id: string; uses30d: number }

/**
 * Tile order: most used (30 days) first, then catalog order. The order does NOT depend on what is
 * already in the bouquet, so a tile never jumps away from under the finger between two taps.
 */
export function tileOrder<T extends TileOrderInfo>(items: readonly T[]): T[] {
  return items.map((it, k) => ({ it, k })).sort((a, z) => z.it.uses30d - a.it.uses30d || a.k - z.k).map((x) => x.it);
}
