import { describe, expect, it } from 'vitest';
import { popUndo, pushUndo, QTY_PRESETS, shortageOf, tileOrder, UNDO_LIMIT, type BuilderSnapshot } from '../src/index.js';

const snap = (qty: Record<string, number>, over: Partial<BuilderSnapshot> = {}): BuilderSnapshot => ({ qty, planned: null, templateId: null, price: '', priceEdited: false, ...over });

describe('builder undo', () => {
  it('restores the state before the last action, step by step', () => {
    let st = pushUndo([], snap({}), '+ Роза');
    st = pushUndo(st, snap({ r: 1 }), '+ Роза');
    st = pushUndo(st, snap({ r: 2 }), 'Шаблон');
    let p = popUndo(st);
    expect(p.entry?.label).toBe('Шаблон');
    expect(p.entry?.snap.qty).toEqual({ r: 2 });
    p = popUndo(p.stack);
    expect(p.entry?.snap.qty).toEqual({ r: 1 });
    p = popUndo(p.stack);
    expect(p.entry?.snap.qty).toEqual({});
    expect(popUndo(p.stack).entry).toBeNull();
  });
  it('snapshots are copies: later changes do not leak into history', () => {
    const live = snap({ r: 1 }, { planned: { r: 1 } });
    const st = pushUndo([], live, 'x');
    live.qty.r = 5; live.planned!.r = 5;
    expect(st[0]!.snap.qty).toEqual({ r: 1 });
    expect(st[0]!.snap.planned).toEqual({ r: 1 });
  });
  it('keeps at most UNDO_LIMIT steps (oldest dropped)', () => {
    let st: ReturnType<typeof pushUndo> = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) st = pushUndo(st, snap({ r: i }), String(i));
    expect(st.length).toBe(UNDO_LIMIT);
    expect(st[0]!.label).toBe('5');
  });
});

describe('shortageOf', () => {
  const items = [
    { id: 'r', name: 'Роза', qty: 10, trackStock: true },
    { id: 'e', name: 'Эвкалипт', qty: -2, trackStock: true },
    { id: 'k', name: 'Крафт', qty: 0, trackStock: false },
  ];
  it('ok when everything is on stock; untracked items never short', () => {
    expect(shortageOf({ r: 10, k: 99 }, items, 'warn')).toEqual({ lines: [], mode: 'ok' });
  });
  it('lists what is missing; negative stock counts as zero', () => {
    const s = shortageOf({ r: 12, e: 3 }, items, 'warn');
    expect(s.mode).toBe('minus');
    expect(s.lines).toEqual([
      { itemId: 'r', name: 'Роза', need: 12, have: 10, missing: 2 },
      { itemId: 'e', name: 'Эвкалипт', need: 3, have: 0, missing: 3 },
    ]);
  });
  it('policy block → blocked, allow → minus', () => {
    expect(shortageOf({ r: 11 }, items, 'block').mode).toBe('blocked');
    expect(shortageOf({ r: 11 }, items, 'allow').mode).toBe('minus');
  });
});

describe('tileOrder', () => {
  it('most used first, ties keep catalog order, independent of the composition', () => {
    const xs = [{ id: 'a', uses30d: 1 }, { id: 'b', uses30d: 9 }, { id: 'c', uses30d: 1 }, { id: 'd', uses30d: 0 }];
    expect(tileOrder(xs).map((x) => x.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(xs.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('QTY_PRESETS', () => {
  it('ascending, positive, has the usual bouquet counts', () => {
    expect([...QTY_PRESETS].sort((a, b) => a - b)).toEqual([...QTY_PRESETS]);
    expect(QTY_PRESETS.every((x) => x > 0)).toBe(true);
    for (const n of [5, 7, 15, 25, 51]) expect(QTY_PRESETS).toContain(n);
  });
});
