import { describe, expect, it } from 'vitest';
import {
  activePurchaseCount,
  applyOutcome,
  applyPurchase,
  balanceOf,
  cardPosition,
  deriveLevel,
  emptyClientState,
  expiryInfo,
  levelTotals,
  monthsBeforeKey,
  manualAdjust,
  maxRedeemable,
  redeem,
  registerClient,
  reversePurchase,
  runExpiry,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
} from '../src/index.js';
import { at, flowers, makeRules, plusDays } from './helpers.js';

/**
 * Bounded states (ClientState.folded): storage loads only the latest purchases and the rows a
 * command needs, plus aggregates of the rest. Every derived value and every command outcome must be
 * IDENTICAL to the full state. The bounded state here is cut exactly like apps/worker's loader.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cut a full state the way D1Repository's bounded loader does (keep = latest purchases kept). */
export function bounded(full: ClientState, keep: number, hint: { purchaseId?: string; keys?: string[]; rewardIds?: string[]; windowFrom?: Date } = {}): ClientState {
  const byTime = [...full.purchases].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ids = new Set(byTime.slice(-keep).map((p) => p.id));
  const active = byTime.filter((p) => p.status === 'active');
  for (const p of active.slice(-2)) ids.add(p.id);
  const activeMoves = full.cardMoves.filter((m) => !m.revertedAt);
  for (const m of activeMoves.slice(-60)) if (m.purchaseId) ids.add(m.purchaseId);
  if (hint.purchaseId) {
    ids.add(hint.purchaseId);
    const used = full.purchases.find((p) => p.id === hint.purchaseId)?.rewardUsedId;
    const unlocker = used ? full.rewards.find((r) => r.id === used)?.unlockedByPurchase : null;
    if (unlocker) ids.add(unlocker);
  }
  for (const p of full.purchases) if (hint.keys?.includes(p.idempotencyKey)) ids.add(p.id);
  // level window: every active purchase inside it is loaded
  if (hint.windowFrom) for (const p of active) if (p.createdAt.getTime() >= hint.windowFrom.getTime()) ids.add(p.id);
  const purchases = full.purchases.filter((p) => ids.has(p.id));

  const ledger = new Set<(typeof full.ledger)[number]>();
  const latest = (pred: (e: (typeof full.ledger)[number]) => boolean) =>
    full.ledger.filter(pred).reduce<(typeof full.ledger)[number] | null>((m, e) => (!m || e.createdAt.getTime() >= m.createdAt.getTime() ? e : m), null);
  const lastExpire = latest((e) => e.type === 'expire');
  if (lastExpire) {
    ledger.add(lastExpire);
    const after = full.ledger.filter((e) => e.amount > 0 && e.createdAt.getTime() > lastExpire.createdAt.getTime()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (after) ledger.add(after);
  }
  const credit = latest((e) => (e.type === 'welcome' || e.type === 'manual_adjust') && e.amount > 0);
  if (credit) ledger.add(credit);
  const welcome = full.ledger.find((e) => e.type === 'welcome');
  if (welcome) ledger.add(welcome);
  for (const e of full.ledger) {
    if (hint.purchaseId && e.purchaseId === hint.purchaseId) ledger.add(e);
    if (e.idempotencyKey && hint.keys?.includes(e.idempotencyKey)) ledger.add(e);
  }
  const keptLedger = full.ledger.filter((e) => ledger.has(e));

  const moveSet = new Set(activeMoves.slice(-60));
  const reset = full.cardMoves.filter((m) => m.reason === 'expiry_reset').at(-1);
  if (reset) moveSet.add(reset);
  for (const m of full.cardMoves) if (hint.purchaseId && m.purchaseId === hint.purchaseId) moveSet.add(m);
  const cardMoves = full.cardMoves.filter((m) => moveSet.has(m));

  const rewardSet = new Set(full.rewards.filter((r) => r.status === 'available'));
  for (const r of [...full.rewards].sort((a, b) => a.unlockedAt.getTime() - b.unlockedAt.getTime()).slice(-keep)) rewardSet.add(r);
  for (const r of full.rewards) {
    if (hint.rewardIds?.includes(r.id)) rewardSet.add(r);
    if (hint.purchaseId && (r.unlockedByPurchase === hint.purchaseId || full.purchases.find((p) => p.id === hint.purchaseId)?.rewardUsedId === r.id)) rewardSet.add(r);
    if (r.usedIdempotencyKey && hint.keys?.includes(r.usedIdempotencyKey)) rewardSet.add(r);
  }
  const rewards = full.rewards.filter((r) => rewardSet.has(r));

  // Folded = totals (as stored in client_stats) − what was loaded.
  const totals = levelTotals(full);
  const part: ClientState = { ...full, purchases, ledger: keptLedger, cardMoves, rewards };
  const loadedLevel = levelTotals({ ...part, folded: undefined });
  return {
    ...part,
    folded: {
      ledgerSum: balanceOf(full) - keptLedger.reduce((s, e) => s + e.amount, 0),
      activeCount: activePurchaseCount(full) - purchases.filter((p) => p.status === 'active').length,
      levelSum: totals.sum - loadedLevel.sum,
      levelCount: totals.count - loadedLevel.count,
      levelSince: full.levelOverride?.setAt ?? null,
    },
  };
}

/** Outcome without object identity noise. */
const norm = (o: Outcome) => JSON.parse(JSON.stringify(o));

function scenario(rules: LoyaltyRules, seed: number, steps: number) {
  const r = rng(seed);
  let now = at('2026-01-05 10:00');
  let s = emptyClientState('c1', now);
  s = applyOutcome(s, registerClient(rules, s, now));
  const purchases: string[] = [];
  let n = 0;
  const checks: Array<() => void> = [];
  for (let i = 0; i < steps; i++) {
    now = new Date(now.getTime() + Math.floor(r() * (r() < 0.15 ? 120 : 6)) * 86_400_000 + 3_600_000);
    const x = r();
    const keep = 1 + Math.floor(r() * 4);
    const windowFrom = rules.levels.windowMonths ? new Date(`${monthsBeforeKey(now, rules.levels.windowMonths, rules.timezone)}T00:00:00+05:00`) : undefined;
    let o: Outcome | null = null;
    const both = (f: (st: ClientState) => Outcome, hint: Parameters<typeof bounded>[2] = {}) => {
      let full: Outcome | Error, part: Outcome | Error;
      try { full = f(s); } catch (e) { full = e as Error; }
      try { part = f(bounded(s, keep, { ...hint, windowFrom })); } catch (e) { part = e as Error; }
      if (full instanceof Error || part instanceof Error) {
        expect(String(part), `step ${i} seed ${seed}`).toBe(String(full));
        return null;
      }
      expect(norm(part), `step ${i} seed ${seed}`).toEqual(norm(full));
      return full;
    };
    if (x < 0.55) {
      const id = `p${++n}`;
      const key = `k${n}`;
      const amount = [60_000, 150_000, 400_000, 1_200_000, 3_000_000][Math.floor(r() * 5)]!;
      const st = bounded(s, keep, { keys: [key], windowFrom });
      const max = maxRedeemable(rules, st, flowers(amount), null, now);
      expect(max).toBe(maxRedeemable(rules, s, flowers(amount), null, now));
      const pts = r() < 0.3 ? max : 0;
      const gift = r() < 0.3 ? s.rewards.find((g) => g.status === 'available' && (g.type !== 'discount_pct' || pts === 0)) : undefined;
      o = both((st2) => applyPurchase(rules, st2, { purchaseId: id, idempotencyKey: key, staffId: 's', lines: flowers(amount), channel: 'store', redeemPoints: pts, useRewardId: gift?.id ?? null }, now), { keys: [key], rewardIds: gift ? [gift.id] : [] });
      if (o) purchases.push(id);
    } else if (x < 0.7 && purchases.length) {
      const id = purchases[Math.floor(r() * purchases.length)]!;
      o = both((st) => reversePurchase(rules, st, { purchaseId: id, reason: 'ошибка', staffId: 's' }, now), { purchaseId: id });
    } else if (x < 0.8) {
      const key = `adj${i}`;
      const amount = Math.floor(r() * 20_000) - 5_000 || 1;
      o = both((st) => manualAdjust(rules, st, { idempotencyKey: key, staffId: 's', amount, reason: 'корректировка' }, now), { keys: [key] });
    } else if (x < 0.85 && balanceOf(s) > 2000) {
      const key = `rd${i}`;
      o = both((st) => redeem(rules, st, { idempotencyKey: key, staffId: 's', points: 1000, orderAmount: 100_000 }, now), { keys: [key] });
    } else {
      o = both((st) => runExpiry(rules, st, now));
    }
    if (o) s = applyOutcome(s, o);
    // derived values
    const b = bounded(s, keep, { windowFrom });
    expect(balanceOf(b)).toBe(balanceOf(s));
    expect(deriveLevel(rules, b, now)).toEqual(deriveLevel(rules, s, now));
    expect(deriveLevel(rules, b, plusDays(now, 40))).toEqual(deriveLevel(rules, s, plusDays(now, 40)));
    expect(expiryInfo(rules, b, now)).toEqual(expiryInfo(rules, s, now));
    expect(cardPosition(rules, b)).toEqual(cardPosition(rules, s));
    expect(levelTotals(b)).toEqual(levelTotals(s));
    expect(activePurchaseCount(b)).toBe(activePurchaseCount(s));
    expect(norm(runExpiry(rules, b, plusDays(now, 95)))).toEqual(norm(runExpiry(rules, s, plusDays(now, 95))));
  }
  return checks;
}

describe('bounded state (ClientState.folded) == full state', () => {
  const families: Array<[string, LoyaltyRules]> = [
    ['default rules', makeRules({ welcomeBonus: 5_000 })],
    ['level down on expiry, count criterion', makeRules({ welcomeBonus: 5_000, levels: { criterion: 'count', tiers: [{ id: 'bee', title: 'Пчёлка', threshold: 0, cashbackPct: 1 }, { id: 'worker', title: 'Труженица', threshold: 3, cashbackPct: 3 }, { id: 'queen', title: 'Королева', threshold: 6, cashbackPct: 5 }] }, expiry: { onExpiry: 'balance_and_level_down' } })],
    ['reset all on expiry', makeRules({ welcomeBonus: 5_000, expiry: { onExpiry: 'reset_all' }, honeycomb: { maxCellsPerDay: 2 } })],
    ['level window 3 months', makeRules({ welcomeBonus: 5_000, levels: { windowMonths: 3 } })],
  ];
  for (const [name, rules] of families) {
    it(`${name}: 40 random histories × 60 commands`, () => {
      for (let seed = 1; seed <= Number(process.env.FOLDED_RUNS ?? 40); seed++) scenario(rules, seed * 7919, 60);
    }, 600_000);
  }
});
