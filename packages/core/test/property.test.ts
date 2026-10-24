/**
 * Randomized property test of the engine: random command sequences
 * (purchases with random amounts / points / gifts across random days,
 * reversals of random purchases, replays, standalone redeems, expiry runs,
 * rules switches) with invariants checked after every command.
 *
 * Deterministic: fixed seeds. PROPERTY_RUNS=2000 runs more sequences per
 * family locally (default 500 keeps `npm test` fast). On a violation the
 * SHORTEST failing sequence per invariant is printed.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  applyPurchase,
  balanceFromLedger,
  cardPosition,
  defaultRules,
  deriveLevel,
  emptyClientState,
  expiryInfo,
  localDateKey,
  LoyaltyError,
  maxRedeemable,
  parseRules,
  percentOf,
  redeem,
  registerClient,
  reversePurchase,
  runExpiry,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
  type PurchaseInput,
  type PurchaseLine,
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

const base = defaultRules;
const R1 = parseRules({ ...base, version: 1, welcomeBonus: 5_000 });
const R2 = parseRules({
  ...base,
  version: 2,
  welcomeBonus: 5_000,
  allowDiscountWithPoints: true,
  maxRedeemPct: 100,
  honeycomb: {
    ...base.honeycomb,
    minPurchaseForCell: 50_000,
    maxCellsPerDay: 2,
    rewards: [
      { cell: 2, type: 'free_card', title: 'card' },
      { cell: 5, type: 'discount_pct', value: 15, title: 'disc15' },
      { cell: 10, type: 'discount_pct', value: 10, title: 'disc10' },
    ],
  },
  expiry: { ...base.expiry, onExpiry: 'balance_and_level_down' },
});
const R3 = parseRules({
  ...base,
  version: 3,
  welcomeBonus: 5_000,
  levels: {
    criterion: 'count',
    windowMonths: 2,
    tiers: [
      { id: 'bee', title: 'b', cashbackPct: 1.5, threshold: 0 },
      { id: 'honey', title: 'h', cashbackPct: 3, threshold: 3 },
      { id: 'queen', title: 'q', cashbackPct: 5, threshold: 8 },
    ],
  },
  expiry: { ...base.expiry, onExpiry: 'reset_all' },
});
const R4 = parseRules({
  ...base,
  version: 4,
  welcomeBonus: 5_000,
  honeycomb: {
    ...base.honeycomb,
    cells: 4,
    afterLastCell: 'new_card',
    rewards: [{ cell: 4, type: 'discount_pct', value: 20, title: 'disc20' }],
    nextCardRewards: [{ cell: 2, type: 'custom', title: 'mini' }],
  },
});
// Family B: no expiry within the horizon, so "reverse everything" must restore.
const RB = parseRules({ ...R1, version: 1, expiry: { ...R1.expiry, expiryDays: 3650, expiryWarnDays: [1] } });
const RB2 = parseRules({ ...R2, version: 2, expiry: { ...R2.expiry, expiryDays: 3650, expiryWarnDays: [1] } });

const START = new Date('2026-11-01T04:00:00Z'); // 09:00 Tashkent
const STEPS_MS = [0, 60_000, 30 * 60_000, 5 * 3_600_000, 86_400_000, 3 * 86_400_000, 20 * 86_400_000, 60 * 86_400_000, 85 * 86_400_000, 95 * 86_400_000];

interface Violation {
  inv: string;
  detail: string;
  ops: string[];
}

function isInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

function netSpent(s: ClientState): number {
  // points spent net of refunds of redeemed points
  let spent = 0;
  for (const e of s.ledger) {
    if (e.type === 'redeem') spent += -e.amount;
    if (e.type === 'reversal' && e.amount > 0) spent -= e.amount;
  }
  return spent;
}

function runSequence(seed: number, family: 'A' | 'B', maxOps: number): Violation[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const sets = family === 'A' ? [R1, R2, R3, R4] : [RB, RB2];
  let rules: LoyaltyRules = pick(sets);
  let now = new Date(START.getTime() + Math.floor(rnd() * 86_400_000));
  let state = emptyClientState('c', now);
  const ops: string[] = [];
  const out: Violation[] = [];
  const seen = new Set<string>();
  const fail = (inv: string, detail: string) => {
    if (seen.has(inv)) return;
    seen.add(inv);
    out.push({ inv, detail, ops: [...ops] });
  };
  const inputs: PurchaseInput[] = [];
  let seq = 0;
  const tz = rules.timezone;

  const commit = (o: Outcome) => {
    state = applyOutcome(state, o);
  };

  const o0 = registerClient(rules, state, now);
  commit(o0);
  ops.push(`register(rules v${rules.version}, welcome ${rules.welcomeBonus}) @${now.toISOString()}`);

  const nOps = 1 + Math.floor(rnd() * maxOps);
  for (let i = 0; i < nOps; i++) {
    now = new Date(now.getTime() + pick(STEPS_MS) + Math.floor(rnd() * 3_600_000));
    const balBefore = balanceFromLedger(state.ledger);
    const r = rnd();
    let o: Outcome | null = null;
    let opDesc = '';
    try {
      if (r < 0.45) {
        // purchase
        seq++;
        const amount = pick([1_000, 50_000, 99_999, 100_000, 150_000, 300_000, 1_000_000, 2_500_000, 1 + Math.floor(rnd() * 3_000_000)]);
        let lines: PurchaseLine[] = [{ category: 'flowers', amount }];
        const lr = rnd();
        if (lr < 0.1) lines = [{ category: 'flowers', amount }, { category: 'delivery', amount: 35_000 }];
        else if (lr < 0.2) lines = [{ category: 'flowers', amount }, { category: 'cards', amount: 15_000 }];
        const avail = state.rewards.filter((x) => x.status === 'available');
        const gift = avail.length && rnd() < 0.35 ? pick(avail) : null;
        const max = maxRedeemable(rules, state, lines, gift?.id ?? null, now);
        const mode = rnd();
        let redeemPoints = 0;
        let usedMax = false;
        if (mode < 0.3) {
          redeemPoints = max;
          usedMax = true;
        } else if (mode < 0.45 && max > 0) redeemPoints = 1 + Math.floor(rnd() * max);
        if (gift?.type === 'discount_pct' && !rules.allowDiscountWithPoints) redeemPoints = 0;
        const input: PurchaseInput = {
          purchaseId: `p${seq}`,
          idempotencyKey: `k${seq}`,
          staffId: 's',
          lines,
          channel: 'store',
          redeemPoints,
          useRewardId: gift?.id ?? null,
        };
        opDesc = `buy p${seq} ${JSON.stringify(lines.map((l) => `${l.category}:${l.amount}`))} redeem=${redeemPoints}${usedMax ? '(=maxRedeemable)' : ''} gift=${gift ? `${gift.id}/${gift.type}` : '-'} @${now.toISOString()}`;
        try {
          o = applyPurchase(rules, state, input, now);
          inputs.push(input);
        } catch (e) {
          if (e instanceof LoyaltyError && usedMax && (e.code === 'INSUFFICIENT_BALANCE' || e.code === 'REDEEM_CAP_EXCEEDED')) {
            ops.push(opDesc + '  -> THREW ' + e.code);
            fail('I8 maxRedeemable value rejected by applyPurchase', `${e.code}: ${e.message}`);
            continue;
          }
          throw e;
        }
      } else if (r < 0.6) {
        if (!state.purchases.length) continue;
        const p = pick(state.purchases);
        opDesc = `reverse ${p.id} (status ${p.status}) @${now.toISOString()}`;
        o = reversePurchase(rules, state, { purchaseId: p.id, reason: 'audit', staffId: 's' }, now);
      } else if (r < 0.72 && family === 'A') {
        opDesc = `runExpiry @${now.toISOString()}`;
        o = runExpiry(rules, state, now);
      } else if (r < 0.8) {
        if (!inputs.length) continue;
        const inp = pick(inputs);
        opDesc = `replay key ${inp.idempotencyKey} @${now.toISOString()}`;
        o = applyPurchase(rules, state, { ...inp, purchaseId: `replay${seq}` }, now);
        if (!o.replayed || o.ledger.length || o.cardMoves.length || o.events.length) {
          ops.push(opDesc);
          fail('I7 idempotent replay changed something', JSON.stringify({ replayed: o.replayed, ledger: o.ledger.length }));
        }
      } else if (r < 0.88) {
        seq++;
        const avail = state.rewards.filter((x) => x.status === 'available');
        const bal = balanceFromLedger(state.ledger);
        if (rnd() < 0.5 && avail.length) {
          const g = pick(avail);
          opDesc = `handout gift ${g.id} @${now.toISOString()}`;
          o = redeem(rules, state, { idempotencyKey: `r${seq}`, staffId: 's', rewardId: g.id }, now);
        } else if (bal > 0) {
          const pts = 1 + Math.floor(rnd() * Math.min(bal, 50_000));
          opDesc = `standalone redeem ${pts} (order 200000) @${now.toISOString()}`;
          o = redeem(rules, state, { idempotencyKey: `r${seq}`, staffId: 's', points: pts, orderAmount: 200_000 }, now);
        } else continue;
      } else if (family === 'A' || r < 0.95) {
        rules = pick(sets);
        opDesc = `switch rules -> v${rules.version}`;
        ops.push(opDesc);
        continue;
      } else continue;
    } catch (e) {
      if (e instanceof LoyaltyError) {
        ops.push(`${opDesc}  -> LoyaltyError ${e.code}`);
        continue;
      }
      ops.push(opDesc);
      fail('I10 unexpected exception', String(e));
      continue;
    }
    if (!o) continue;
    ops.push(opDesc + (o.warnings.length ? `  [warnings: ${o.warnings.join(' | ')}]` : ''));
    commit(o);

    // ---------------- invariants
    const bal = balanceFromLedger(state.ledger);
    for (const e of state.ledger) {
      if (!isInt(e.amount) || e.amount === 0) fail('I1 ledger amount not a non-zero safe integer', JSON.stringify(e));
    }
    if (bal < 0 && balBefore >= 0 && o.warnings.length === 0) fail('I2a balance went negative without a warning', `balance ${bal}`);
    if (bal < 0 && netSpent(state) <= 0) {
      fail('I2b negative balance although the client never spent points (net)', `balance ${bal}; ledger ${state.ledger.map((e) => `${e.type}:${e.amount}`).join(',')}`);
    }
    const pos = cardPosition(rules, state);
    if (pos.cycle < 1 || pos.filled < 0 || pos.filled >= rules.honeycomb.cells) fail('I3 card position out of range', JSON.stringify(pos));
    const activeIds = new Set(state.purchases.filter((p) => p.status === 'active').map((p) => p.id));
    // A step of a reversed purchase may stay on the card only while a later
    // active purchase (or an expiry reset) sits after it; it never forms the tail.
    const activeMoves = state.cardMoves.filter((m) => !m.revertedAt);
    for (let i = activeMoves.length - 1; i >= 0; i--) {
      const m = activeMoves[i]!;
      if (m.reason !== 'purchase') break;
      if (!activeIds.has(m.purchaseId!)) {
        fail('I4 tail card move belongs to a reversed purchase (phantom cell)', `move ${m.purchaseId} cycle ${m.cycle} cell ${m.cell}; card now ${JSON.stringify(pos)}`);
      }
      break;
    }
    for (const g of state.rewards) {
      if (g.status === 'available' && g.unlockedByPurchase && !activeIds.has(g.unlockedByPurchase)) {
        fail('I5 available gift whose unlocking purchase is reversed', `${g.id} ${g.type}`);
      }
    }
    const live = new Map<string, number>();
    for (const g of state.rewards) {
      if (g.status !== 'revoked' && g.unlockedByPurchase && activeIds.has(g.unlockedByPurchase)) {
        const k = `${g.cycle}-${g.cell}`;
        live.set(k, (live.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of live) if (n > 1) fail('I13 same card cell unlocked twice by active purchases', `${k} x${n}`);
    const cellKeys = new Set<string>();
    for (const m of state.cardMoves) {
      if (m.revertedAt || m.reason !== 'purchase') continue;
      const k = `${m.cycle}-${m.cell}`;
      if (cellKeys.has(k)) fail('I15 two active purchase moves on the same (cycle, cell) — violates D1 card_moves_cell_uq', k);
      cellKeys.add(k);
    }

    if (o.purchase && !o.replayed && o.purchase.result && o.purchase.status === 'active' && o.purchase.createdAt.getTime() === now.getTime()) {
      const res = o.purchase.result;
      for (const [k, v] of Object.entries(res)) if (k !== 'cashbackPct' && typeof v === 'number' && !isInt(v)) fail('I6 non-integer money in summary', `${k}=${v}`);
      if (res.paid !== res.amount - res.discountApplied - res.pointsRedeemed) fail('I6 paid != amount - discount - redeem', JSON.stringify(res));
      if (res.paid < 0) fail('I6 paid < 0', JSON.stringify(res));
      if (res.cashbackBase > res.paid || res.cashbackBase < 0) fail('I6 cashback base outside [0, paid]', JSON.stringify(res));
      if (res.cashback !== percentOf(res.cashbackBase, res.cashbackPct)) fail('I6 cashback != floor(base*pct)', JSON.stringify(res));
      if (res.balanceAfter !== bal) fail('I6 summary.balanceAfter != ledger sum', `${res.balanceAfter} vs ${bal}`);
      const lvl = deriveLevel(rules, state, now).tier.id;
      if (res.levelAfter !== lvl) fail('I11 summary.levelAfter != derived level after commit', `${res.levelAfter} vs ${lvl}`);
    }
    // daily cap on active moves
    const perDay = new Map<string, number>();
    for (const m of state.cardMoves) {
      if (m.revertedAt || m.reason !== 'purchase' || !activeIds.has(m.purchaseId!)) continue;
      const k = localDateKey(m.createdAt, tz);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const cap = Math.max(...sets.map((x) => x.honeycomb.maxCellsPerDay));
    for (const [k, n] of perDay) if (n > cap) fail('I12 more card moves by active purchases on a local day than maxCellsPerDay', `${k}: ${n}`);

    if (opDesc.startsWith('runExpiry') && bal > 0) {
      const info = expiryInfo(rules, state, now);
      if (info.daysLeft <= 0) fail('I9 positive balance is overdue right after the expiry job ran', `balance ${bal}, daysLeft ${info.daysLeft}, anchor ${info.anchorKey}`);
    }
  }

  if (family === 'B') {
    // Reverse every purchase at the same instant (no expiry in this family).
    const welcome = state.ledger.filter((e) => e.type === 'welcome').reduce((s, e) => s + e.amount, 0);
    const standalone = state.ledger.filter((e) => e.type === 'redeem' && e.purchaseId === null).reduce((s, e) => s + e.amount, 0);
    const order = [...state.purchases.filter((p) => p.status === 'active')].sort(() => rnd() - 0.5);
    // Cleanup ignores the reversal window (engine mechanics); a reversal the business rules refuse
    // (a gift of the purchase was used / its мёд spent) ends the cleanup: the I14 checks need all.
    const noWindow = { ...rules, reversalWindowHours: Number.MAX_SAFE_INTEGER };
    let blocked = false;
    for (const p of order) {
      ops.push(`reverse ${p.id} (final cleanup) @${now.toISOString()}`);
      try {
        commit(reversePurchase(noWindow, state, { purchaseId: p.id, reason: 'cleanup', staffId: 's' }, now));
      } catch (e) {
        if (e instanceof LoyaltyError && e.code.startsWith('REVERSAL_')) {
          blocked = true;
          break;
        }
        throw e;
      }
    }
    if (blocked) return out;
    const bal = balanceFromLedger(state.ledger);
    if (bal !== welcome + standalone) fail('I14a reversing every purchase does not restore the balance', `balance ${bal}, expected ${welcome + standalone}`);
    const pos = cardPosition(rules, state);
    if (pos.filled !== 0 || pos.cycle !== 1) fail('I14b reversing every purchase does not empty the card', JSON.stringify(pos));
    const avail = state.rewards.filter((g) => g.status === 'available');
    if (avail.length) fail('I14c gifts still available after every purchase was reversed', avail.map((g) => g.id).join(','));
  }
  return out;
}

const RUNS = Number(process.env.PROPERTY_RUNS) > 0 ? Number(process.env.PROPERTY_RUNS) : 500;

describe('property test', () => {
  it(`${RUNS} random sequences per family keep all invariants`, () => {
    const best = new Map<string, Violation & { seed: number; family: string }>();
    const counts = new Map<string, number>();
    for (const family of ['A', 'B'] as const) {
      for (let seed = 1; seed <= RUNS; seed++) {
        for (const v of runSequence(seed * 7919 + (family === 'A' ? 0 : 1), family, 25)) {
          counts.set(v.inv, (counts.get(v.inv) ?? 0) + 1);
          const prev = best.get(v.inv);
          if (!prev || v.ops.length < prev.ops.length) best.set(v.inv, { ...v, seed, family });
        }
      }
    }
    const lines: string[] = [];
    for (const [inv, v] of [...best.entries()].sort()) {
      lines.push(`\n=== ${inv}  (sequences violating: ${counts.get(inv)}/${RUNS}, family ${v.family}, seed ${v.seed})\n  detail: ${v.detail}`);
      v.ops.forEach((op, i) => lines.push(`  ${i + 1}. ${op}`));
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n') || 'no violations');
    expect([...best.keys()].sort()).toEqual([]);
  });
});
