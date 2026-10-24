// Randomized model-based test. A small independent model of the README rules (cells, cashback,
// levels, redeem cap, gifts, reversals, expiry + reminders, manual adjustments, rules versions)
// runs side by side with the Worker. Every response is compared with the model; every 100 ops the
// invariant checker runs and the model is compared with the database. A divergence is reported
// with the seed and a shrunk op sequence (delta debugging on a fresh database, one client).
import { as, clock, newKey, req, runExpiryAll, setRole, sql, wipe } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { checkInvariants, pctOf } from '../lib/invariants.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101, CLOCKER = 900_000_103;
const USER0 = 900_500_000;
const DAY = 86_400_000, TZ = 5 * 3_600_000;
const dayNum = (ms) => Math.floor((ms + TZ) / DAY);
const dayKey = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const keyOfDayNum = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ PRNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ the model
class Model {
  constructor(rules) {
    this.rules = rules; // EditableRulesDTO
    this.offset = 0;
    this.clients = []; // index → client
  }
  now() { return Date.now() + this.offset * DAY; }
  tier(c) {
    const metric = c.purchases.filter((p) => p.status === 'active').reduce((s, p) => s + p.amount, 0);
    let idx = 0;
    this.rules.levels.forEach((l, i) => { if (metric >= l.from) idx = i; });
    return { idx, lvl: this.rules.levels[idx], metric };
  }
  balance(c) { return c.ledger.reduce((s, e) => s + e.amount, 0); }
  anchor(c) {
    let a = c.registeredAt;
    for (const p of c.purchases) if (p.status === 'active' && p.createdAt > a) a = p.createdAt;
    for (const e of c.ledger) if ((e.type === 'manual_adjust' || e.type === 'welcome') && e.amount > 0 && e.createdAt > a) a = e.createdAt;
    return a;
  }
  /** Returns the amount that would burn now (0 if nothing). */
  dueBurn(c, now) {
    const anchor = this.anchor(c);
    const daysLeft = this.rules.expiryDays - (dayNum(now) - dayNum(anchor));
    if (daysLeft > 0) return 0;
    const bal = this.balance(c);
    if (bal <= 0) return 0;
    let last = null;
    for (const e of c.ledger) if (e.type === 'expire' && (!last || e.createdAt >= last.createdAt)) last = e;
    const done = last && last.createdAt > anchor && !c.ledger.some((e) => e.amount > 0 && e.createdAt > last.createdAt);
    return done ? 0 : bal;
  }
  settle(c, now) {
    const burn = this.dueBurn(c, now);
    if (burn > 0) {
      c.ledger.push({ type: 'expire', amount: -burn, purchaseId: null, createdAt: now });
      c.keys.add(`expired:${dayKey(this.anchor(c))}`);
    }
    return burn;
  }
  activeMoves(c) { return c.moves.filter((m) => !m.revertedAt); }
  pos(c) {
    const a = this.activeMoves(c);
    const last = a[a.length - 1];
    if (!last) return { cycle: 1, filled: 0 };
    if (last.cell >= this.rules.cells) return { cycle: last.cycle + 1, filled: 0 };
    return { cycle: last.cycle, filled: last.cell };
  }
  movesToday(c, now) {
    const active = new Set(c.purchases.filter((p) => p.status === 'active').map((p) => p.id));
    return this.activeMoves(c).filter((m) => m.reason === 'purchase' && active.has(m.purchaseId) && dayKey(m.createdAt) === dayKey(now)).length;
  }
  giftOf(code) {
    if (code === 'card') return { type: 'free_card', value: null };
    if (code === 'delivery') return { type: 'free_delivery', value: null };
    if (code === 'mini') return { type: 'custom', value: null };
    return { type: 'discount_pct', value: Number(code.slice(4)) };
  }
  /** Purchase as planned by the route (redeem=true → min(balance, cap)). Pure: returns the plan. */
  plan(c, amount, redeem, giftId, now) {
    const burn = this.dueBurn(c, now);
    const bal = this.balance(c) - burn;
    const reward = giftId ? c.rewards.find((r) => r.id === giftId) : null;
    if (giftId && (!reward || reward.status !== 'available')) return { error: reward ? 409 : 404 };
    const discount = reward?.type === 'discount_pct' ? Math.min(amount, pctOf(amount, reward.value)) : 0;
    const cap = Math.max(0, Math.min(pctOf(amount, this.rules.maxRedeemPct), amount - discount));
    const maxRedeem = reward?.type === 'discount_pct' ? 0 : Math.max(0, Math.min(bal, cap));
    const redeemed = redeem ? maxRedeem : 0;
    const paid = amount - discount - redeemed;
    const { lvl, idx } = this.tier(c);
    const cashback = pctOf(paid, lvl.pct);
    let cellReason = null;
    if (amount < this.rules.minPurchaseForCell) cellReason = 'below_min';
    else if (this.movesToday(c, now) >= this.rules.maxCellsPerDay) cellReason = 'daily_limit';
    const p = this.pos(c);
    const cell = cellReason ? null : p.filled + 1;
    const giftCode = cell ? this.rules.gifts[String(cell)] ?? null : null;
    return { burn, reward, discount, maxRedeem, redeemed, paid, cashback, pct: lvl.pct, levelBefore: idx, cellReason, cell, cycle: p.cycle, giftCode };
  }
  applyPurchase(c, pl, purchaseId, key, amount, giftId, now) {
    this.settle(c, now);
    if (pl.reward) Object.assign(pl.reward, { status: 'used', usedIn: purchaseId });
    if (pl.redeemed) c.ledger.push({ type: 'redeem', amount: -pl.redeemed, purchaseId, createdAt: now });
    if (pl.cashback) c.ledger.push({ type: 'accrual', amount: pl.cashback, purchaseId, createdAt: now });
    const p = { id: purchaseId, key, amount, giftId: giftId ?? null, redeemFlag: pl.redeemed > 0, createdAt: now, status: 'active', cashback: pl.cashback };
    c.purchases.push(p);
    let unlocked = null;
    if (pl.cell) {
      c.moves.push({ purchaseId, cycle: pl.cycle, cell: pl.cell, reason: 'purchase', createdAt: now, revertedAt: null });
      if (pl.giftCode) {
        unlocked = { id: `${pl.cycle}-${pl.cell}-${purchaseId}`, cycle: pl.cycle, cell: pl.cell, ...this.giftOf(pl.giftCode), status: 'available', unlockedBy: purchaseId, usedIn: null, usedKey: null, unlockedAt: now };
        c.rewards.push(unlocked);
      }
    }
    const after = this.tier(c).idx;
    return { unlocked, levelUp: after > pl.levelBefore ? this.rules.levels[after].id : null };
  }
  /** Item 8: may staff reverse this purchase? null, or the refusal (same order as core reversalBlock). */
  reversalBlock(c, p, now) {
    const hours = this.rules.reversalWindowHours ?? 24;
    if (now - p.createdAt > hours * 3_600_000) return 'window';
    if (c.rewards.some((r) => r.unlockedBy === p.id && r.status === 'used')) return 'gift';
    const expiredSince = c.ledger.some((e) => e.type === 'expire' && e.createdAt > p.createdAt);
    let delta = 0;
    for (const e of c.ledger) {
      if (e.purchaseId !== p.id) continue;
      if (e.type === 'redeem' || (e.type === 'accrual' && !expiredSince)) delta -= e.amount;
    }
    const before = this.balance(c), after = before + delta;
    return after < 0 && after < before ? 'spent' : null;
  }
  reverse(c, p, now) {
    const warnings = [];
    const expiredSince = c.ledger.some((e) => e.type === 'expire' && e.createdAt > p.createdAt);
    for (const e of c.ledger.filter((x) => x.purchaseId === p.id && (x.type === 'accrual' || x.type === 'redeem'))) {
      if (e.type === 'accrual' && expiredSince) { warnings.push('expired'); continue; }
      c.ledger.push({ type: 'reversal', amount: -e.amount, purchaseId: p.id, createdAt: now });
    }
    const active = this.activeMoves(c);
    const own = active.find((m) => m.purchaseId === p.id && m.reason === 'purchase');
    if (own) {
      if (active[active.length - 1] === own) {
        const reversedIds = new Set(c.purchases.filter((x) => x.status === 'reversed').map((x) => x.id));
        for (let i = active.length - 1; i >= 0; i--) {
          const m = active[i];
          if (m.reason !== 'purchase') break;
          if (m !== own && !reversedIds.has(m.purchaseId)) break;
          m.revertedAt = now;
        }
      } else warnings.push('card');
    }
    for (const r of c.rewards.filter((x) => x.unlockedBy === p.id)) {
      if (r.status === 'available') r.status = 'revoked';
    }
    if (p.giftId) {
      const used = c.rewards.find((r) => r.id === p.giftId);
      if (used && used.status === 'used') {
        const unlocker = c.purchases.find((x) => x.id === used.unlockedBy);
        const ok = unlocker && unlocker.status === 'active' && unlocker.id !== p.id;
        Object.assign(used, { status: ok ? 'available' : 'revoked', usedIn: null });
        if (!ok) warnings.push('gift-not-returned');
      }
    }
    p.status = 'reversed';
    p.reversedAt = now;
    return warnings;
  }
  view(c, now) {
    const bal = this.balance(c) - this.dueBurn(c, now);
    const p = this.pos(c);
    return { balance: bal, cycle: p.cycle, filled: p.filled, level: this.tier(c).lvl.id, gifts: Object.fromEntries(c.rewards.map((r) => [r.id, r.status]).sort()) };
  }
  /** One daily-job pass for every client (the Worker processes due clients in batches until done). */
  expiryRun(now) {
    let expired = 0, warned = 0;
    for (const c of this.clients) {
      if (!c) continue;
      if (this.settle(c, now) > 0) { expired++; continue; }
      const bal = this.balance(c);
      if (bal <= 0) continue;
      const anchor = this.anchor(c);
      const daysLeft = this.rules.expiryDays - (dayNum(now) - dayNum(anchor));
      if (daysLeft <= 0) continue;
      const pending = [...new Set(this.rules.expiryWarnDays)].filter((d) => daysLeft <= d).map((d) => `expiry_warning:${dayKey(anchor)}:${d}`).filter((k) => !c.keys.has(k));
      if (pending.length) { pending.forEach((k) => c.keys.add(k)); warned++; }
    }
    return { expired, warned };
  }
}

// ------------------------------------------------------------ op generation
const AMOUNTS = [5_000, 30_000, 49_999, 50_000, 99_999, 100_000, 100_001, 150_000, 250_000, 400_000, 800_000, 1_500_000, 2_500_000, 6_000_000];
const CLOCK = [1, 1, 1, 1, 2, 2, 3, 5, 7, 10, 14, 30, 45, 90];
function randomRules(rnd, cur) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const n = 2 + Math.floor(rnd() * 3);
  const ids = ['bee', 'honey', 'queen', 'royal'];
  const ths = [300_000, 500_000, 1_000_000, 2_000_000, 3_000_000, 6_000_000, 10_000_000].sort(() => rnd() - 0.5).slice(0, n - 1).sort((a, b) => a - b);
  const levels = ids.slice(0, n).map((id, i) => ({ id, name: ['Пчёлка', 'Медовая', 'Королева', 'Царица'][i], pct: pick([0, 0.5, 1, 1.5, 2, 3, 5, 7.25, 10]), from: i === 0 ? 0 : ths[i - 1] }));
  const expiryDays = pick([30, 45, 60, 90, 120]);
  const warn = [...new Set([30, 14, 7, 3, 1].filter(() => rnd() < 0.6))].filter((d) => d < expiryDays).sort((a, b) => b - a);
  const gifts = {};
  for (let i = 0, k = Math.floor(rnd() * 5); i < k; i++) gifts[String(1 + Math.floor(rnd() * 10))] = pick(['card', 'delivery', 'mini', 'disc5', 'disc10', 'disc15', 'disc50']);
  return {
    ...cur, levels, minPurchaseForCell: pick([0, 50_000, 100_000, 150_000, 300_000]), maxCellsPerDay: pick([1, 1, 2, 3]), maxRedeemPct: pick([0, 25, 33.33, 50, 100]),
    expiryDays, expiryWarnDays: warn, welcomeBonus: pick([0, 0, 1_000, 5_000]), gifts,
    reversalWindowHours: pick([24, 24, 48, 168, 720]),
  };
}

export function generateOps(seed, nOps, nClients) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const hot = Math.max(1, Math.floor(nClients / 10));
  let extra = 0;
  const client = () => (rnd() < 0.5 ? Math.floor(rnd() * hot) : Math.floor(rnd() * (nClients + extra)));
  const ops = [];
  let clockDays = 0;
  for (let i = 0; i < nOps; i++) {
    const x = rnd();
    if (x < 0.5) ops.push({ t: 'buy', c: client(), amount: pick(AMOUNTS), redeem: rnd() < 0.3, gift: rnd() < 0.25 ? Math.floor(rnd() * 4) : null });
    else if (x < 0.53) ops.push({ t: 'replay', c: client(), p: Math.floor(rnd() * 50) });
    else if (x < 0.61) ops.push({ t: 'rev', c: client(), p: Math.floor(rnd() * 50) });
    else if (x < 0.67) ops.push({ t: 'gift', c: client(), g: Math.floor(rnd() * 6) });
    else if (x < 0.73) ops.push({ t: 'adj', c: client(), pts: rnd() < 0.25 ? -(1 + Math.floor(rnd() * 3000)) : 1 + Math.floor(rnd() * 20_000) });
    else if (x < 0.77) ops.push({ t: 'preview', c: client(), amount: pick(AMOUNTS), redeem: rnd() < 0.5 });
    else if (x < 0.81) {
      let n = pick(CLOCK);
      if (clockDays + n > 3_300) n = 1;
      if (clockDays + n > 3_600) continue;
      clockDays += n;
      ops.push({ t: 'clock', n });
    } else if (x < 0.85) ops.push({ t: 'exp' });
    else if (x < 0.865) ops.push({ t: 'rules', seed: Math.floor(rnd() * 2 ** 31) });
    else if (x < 0.875) ops.push({ t: 'reg', c: nClients + extra++ });
    else ops.push({ t: 'buy', c: client(), amount: pick(AMOUNTS), redeem: false, gift: null });
  }
  return ops;
}

// ------------------------------------------------------------ executor
class Runner {
  constructor(model, opts = {}) {
    this.m = model;
    this.div = [];
    this.tainted = new Set();
    this.only = opts.only ?? null; // client index filter (shrinking)
    this.stats = { ops: 0, requests: 0 };
  }
  diverge(i, op, c, what, expected, got) {
    const idx = c?.index ?? null;
    if (idx !== null && this.tainted.has(idx)) return;
    this.div.push({ op: i, opDesc: op, client: idx, what, expected, got });
    if (idx !== null) this.tainted.add(idx);
  }
  async guardMidnight() {
    const tod = (Date.now() + TZ) % DAY;
    if (tod > DAY - 4_000) await sleep(DAY - tod + 300);
  }
  compareView(i, op, c, summary, now) {
    if (!summary) return this.diverge(i, op, c, 'no client summary in response', null, null);
    const v = this.m.view(c, now);
    const got = { balance: summary.balance, cycle: summary.card.cycle, filled: summary.card.filled, level: summary.level.id, gifts: Object.fromEntries(summary.gifts.map((g) => [g.id, g.status]).sort()) };
    if (JSON.stringify(got) !== JSON.stringify(v)) this.diverge(i, op, c, 'client view', v, got);
  }
  async register(index) {
    const user = USER0 + index;
    const now = this.m.now();
    const r = await as(user).post('/api/test/register', { phone: `+99899${String(index).padStart(7, '0')}`, name: `Модель ${index}` });
    this.stats.requests++;
    if (r.status !== 201) throw new Error(`model register ${index}: ${r.status} ${r.text}`);
    const c = { index, user, id: r.body.client.id, registeredAt: now, purchases: [], ledger: [], moves: [], rewards: [], keys: new Set() };
    if (this.m.rules.welcomeBonus > 0) c.ledger.push({ type: 'welcome', amount: this.m.rules.welcomeBonus, purchaseId: null, createdAt: now });
    this.m.clients[index] = c;
    if (r.body.client.balance !== this.m.balance(c)) this.diverge(-1, { t: 'reg', c: index }, c, 'welcome bonus', this.m.balance(c), r.body.client.balance);
    return c;
  }
  async exec(i, op) {
    await this.guardMidnight();
    const m = this.m;
    const c = op.c !== undefined ? m.clients[op.c] : null;
    if (op.c !== undefined && op.t !== 'reg' && !c) return; // client not present (shrinking)
    if (this.only !== null && op.c !== undefined && op.c !== this.only) return;
    this.stats.ops++;
    const f = as(FLORIST);
    const now = m.now();
    switch (op.t) {
      case 'buy': {
        const avail = c.rewards.filter((r) => r.status === 'available');
        const giftId = op.gift !== null && avail.length ? avail[op.gift % avail.length].id : null;
        const pl = m.plan(c, op.amount, op.redeem, giftId, now);
        const key = newKey('m');
        const r = await f.post('/api/staff/purchase', { clientId: c.id, amount: op.amount, redeem: op.redeem, giftId, idempotencyKey: key });
        this.stats.requests++;
        if (pl.error) {
          if (r.status !== pl.error) this.diverge(i, op, c, 'purchase status', pl.error, r.status);
          return;
        }
        if (r.status !== 201) return this.diverge(i, op, c, 'purchase status', 201, `${r.status} ${r.text.slice(0, 200)}`);
        const res = m.applyPurchase(c, pl, r.body.purchaseId, key, op.amount, giftId, now);
        const pv = r.body.preview;
        const want = { redeemed: pl.redeemed, maxRedeem: pl.maxRedeem, discount: pl.discount, paid: pl.paid, cashback: pl.cashback, pct: pl.pct, cell: pl.cell, cellBlockedReason: pl.cellReason, gifts: res.unlocked ? [res.unlocked.id] : [], levelUp: res.levelUp };
        const got = { redeemed: pv.redeemed, maxRedeem: pv.maxRedeem, discount: pv.discount, paid: pv.paid, cashback: pv.cashback, pct: pv.pct, cell: pv.cell, cellBlockedReason: pv.cellBlockedReason, gifts: r.body.giftsUnlocked.map((g) => g.id), levelUp: r.body.levelUp?.id ?? null };
        if (JSON.stringify(want) !== JSON.stringify(got)) this.diverge(i, op, c, 'purchase result', want, got);
        this.compareView(i, op, c, r.body.client, now);
        return;
      }
      case 'preview': {
        const pl = m.plan(c, op.amount, op.redeem, null, now);
        const r = await f.post('/api/staff/purchase/preview', { clientId: c.id, amount: op.amount, redeem: op.redeem });
        this.stats.requests++;
        const want = { redeemed: pl.redeemed, maxRedeem: pl.maxRedeem, paid: pl.paid, cashback: pl.cashback, pct: pl.pct, cell: pl.cell };
        const got = r.status === 200 ? { redeemed: r.body.redeemed, maxRedeem: r.body.maxRedeem, paid: r.body.paid, cashback: r.body.cashback, pct: r.body.pct, cell: r.body.cell } : r.status;
        if (JSON.stringify(want) !== JSON.stringify(got)) this.diverge(i, op, c, 'preview', want, got);
        return;
      }
      case 'replay': {
        if (!c.purchases.length) return;
        const p = c.purchases[op.p % c.purchases.length];
        const r = await f.post('/api/staff/purchase', { clientId: c.id, amount: p.amount, redeem: p.redeemFlag, giftId: p.giftId, idempotencyKey: p.key });
        this.stats.requests++;
        if (r.status !== 200 || !r.body.replayed || r.body.purchaseId !== p.id) return this.diverge(i, op, c, 'replay', { status: 200, replayed: true, id: p.id }, { status: r.status, replayed: r.body?.replayed, id: r.body?.purchaseId, text: r.text.slice(0, 160) });
        this.compareView(i, op, c, r.body.client, now);
        return;
      }
      case 'rev': {
        if (!c.purchases.length) return;
        const p = c.purchases[op.p % c.purchases.length];
        const r = await f.post(`/api/staff/purchase/${p.id}/reverse`, { reason: 'Модельная отмена' });
        this.stats.requests++;
        if (p.status === 'reversed') {
          if (r.status !== 409 || r.body?.error?.code !== 'already_reversed') this.diverge(i, op, c, 'double reversal', 409, r.status);
          return;
        }
        const block = m.reversalBlock(c, p, now);
        const boundary = Math.abs(now - p.createdAt - (m.rules.reversalWindowHours ?? 24) * 3_600_000) < 120_000;
        if (boundary) this.stats.revBoundary = (this.stats.revBoundary ?? 0) + 1;
        if (block || (boundary && r.status === 409)) {
          this.stats.revRefused = (this.stats.revRefused ?? 0) + 1;
          const want = { window: /Отмена возможна только в течение \d+ ч/, gift: /Подарок за эту покупку уже использован/, spent: /Мёд с этой покупки уже потрачен/ }[block ?? 'window'];
          if (r.status !== 409 || !want.test(r.body?.error?.message ?? '')) return this.diverge(i, op, c, `reverse refused (${block ?? 'window'})`, 409, `${r.status} ${r.text.slice(0, 200)}`);
          return;
        }
        if (r.status !== 200) return this.diverge(i, op, c, 'reverse status', 200, `${r.status} ${r.text.slice(0, 200)}`);
        const balBefore = m.balance(c);
        const w = m.reverse(c, p, now);
        if (m.balance(c) < 0 && m.balance(c) < balBefore) this.diverge(i, op, c, 'reversal pushed the balance below zero', balBefore, m.balance(c));
        if (r.body.warnings.length !== w.length) this.diverge(i, op, c, 'reverse warnings', w, r.body.warnings);
        this.compareView(i, op, c, r.body.client, now);
        return;
      }
      case 'gift': {
        if (!c.rewards.length) return;
        const g = c.rewards[op.g % c.rewards.length];
        const r = await f.post(`/api/staff/gift/${encodeURIComponent(g.id)}/use`, {});
        this.stats.requests++;
        const key = `gift-use:${g.id}`;
        if (g.status === 'used' && g.usedKey === key) {
          if (r.status !== 200) this.diverge(i, op, c, 'gift replay', 200, r.status);
          else this.compareView(i, op, c, r.body.client, now);
          return;
        }
        if (g.status !== 'available') {
          if (r.status !== 409) this.diverge(i, op, c, `gift use of a ${g.status} gift`, 409, `${r.status} ${r.text.slice(0, 120)}`);
          return;
        }
        if (r.status !== 200) return this.diverge(i, op, c, 'gift use', 200, `${r.status} ${r.text.slice(0, 200)}`);
        m.settle(c, now);
        Object.assign(g, { status: 'used', usedKey: key });
        this.compareView(i, op, c, r.body.client, now);
        return;
      }
      case 'adj': {
        const r = await as(OWNER).post(`/api/owner/clients/${c.id}/adjust`, { points: op.pts, reason: 'Модель', idempotencyKey: newKey('ma') });
        this.stats.requests++;
        if (r.status !== 200) return this.diverge(i, op, c, 'adjust', 200, `${r.status} ${r.text.slice(0, 200)}`);
        m.settle(c, now);
        c.ledger.push({ type: 'manual_adjust', amount: op.pts, purchaseId: null, createdAt: now });
        this.compareView(i, op, c, r.body.client, now);
        return;
      }
      case 'clock': {
        await clock(op.n);
        m.offset += op.n;
        this.stats.requests++;
        return;
      }
      case 'exp': {
        const want = m.expiryRun(now);
        const got = await runExpiryAll();
        this.stats.requests += got.runs;
        if (this.only === null && (got.expired !== want.expired || got.warned !== want.warned)) this.diverge(i, op, null, 'daily job counts', want, { expired: got.expired, warned: got.warned, runs: got.runs, stuck: got.stuck ?? false });
        if (got.stuck) this.diverge(i, op, null, 'daily job never finishes (more=true forever)', false, got);
        return;
      }
      case 'rules': {
        const cur = (await as(OWNER).get('/api/owner/rules')).body;
        const next = randomRules(mulberry32(op.seed), cur);
        const r = await as(OWNER).put('/api/owner/rules', next);
        this.stats.requests += 2;
        if (r.status !== 200) return this.diverge(i, op, null, 'rules PUT', 200, `${r.status} ${r.text.slice(0, 200)}`);
        m.rules = r.body;
        return;
      }
      case 'reg': {
        if (this.only !== null) return;
        await this.register(op.c);
        return;
      }
    }
  }
  /** Model vs DB for every (untainted) client. */
  async deepCompare(i) {
    const ledger = await sql(`SELECT client_id, COALESCE(SUM(amount),0) AS b, COUNT(*) AS n FROM points_ledger GROUP BY client_id`);
    const purchases = await sql(`SELECT client_id, SUM(status = 'active') AS a, SUM(status = 'reversed') AS r FROM purchases GROUP BY client_id`);
    const rewards = await sql(`SELECT client_id, id, status FROM rewards`);
    const moves = await sql(`SELECT client_id, cycle, cell FROM card_moves WHERE reverted_at IS NULL ORDER BY id`);
    const keys = await sql(`SELECT client_id, key FROM notification_keys`);
    const by = (rows) => rows.reduce((mm, r) => (mm.get(r.client_id) ?? mm.set(r.client_id, []).get(r.client_id)).push(r) && mm, new Map());
    const L = new Map(ledger.map((r) => [r.client_id, r])), P = new Map(purchases.map((r) => [r.client_id, r])), R = by(rewards), M = by(moves), K = by(keys);
    for (const c of this.m.clients) {
      if (!c || this.tainted.has(c.index)) continue;
      const mv = M.get(c.id) ?? [];
      const last = mv[mv.length - 1];
      const got = {
        balance: Number(L.get(c.id)?.b ?? 0), ledgerRows: Number(L.get(c.id)?.n ?? 0),
        active: Number(P.get(c.id)?.a ?? 0), reversed: Number(P.get(c.id)?.r ?? 0),
        lastMove: last ? `${last.cycle}/${last.cell}` : null,
        rewards: Object.fromEntries((R.get(c.id) ?? []).map((r) => [r.id, r.status]).sort()),
        keys: (K.get(c.id) ?? []).map((k) => k.key).sort(),
      };
      const am = this.m.activeMoves(c);
      const lm = am[am.length - 1];
      const want = {
        balance: this.m.balance(c), ledgerRows: c.ledger.length,
        active: c.purchases.filter((p) => p.status === 'active').length, reversed: c.purchases.filter((p) => p.status === 'reversed').length,
        lastMove: lm ? `${lm.cycle}/${lm.cell}` : null,
        rewards: Object.fromEntries(c.rewards.map((r) => [r.id, r.status]).sort()),
        keys: [...c.keys].sort(),
      };
      if (JSON.stringify(got) !== JSON.stringify(want)) this.diverge(i, { t: 'deep-compare' }, c, 'model vs DB', want, got);
    }
  }
}

async function freshStart(nClients, runner, list = null) {
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  await setRole(CLOCKER, 'client');
  const rules = (await as(OWNER).get('/api/owner/rules')).body;
  runner.m.rules = rules;
  for (let k = 0; k < nClients; k++) if (!list || list.includes(k)) await runner.register(k);
}

/** Replays a candidate op list for one client on a fresh DB; true if a divergence shows up. */
async function reproduces(ops, client, nClients) {
  const runner = new Runner(new Model(null), { only: client });
  await freshStart(nClients, runner, [client]);
  for (let i = 0; i < ops.length; i++) {
    await runner.exec(i, ops[i]);
    if (runner.div.length) return runner.div[0];
  }
  await runner.deepCompare(ops.length);
  return runner.div[0] ?? null;
}

/** Delta debugging (ddmin-lite): drop chunks, then single ops, while the failure reproduces. */
async function shrink(ops, client, nClients, budgetMs = 120_000) {
  const t0 = Date.now();
  let cur = ops.filter((o) => o.c === undefined || o.c === client).filter((o) => o.t !== 'reg');
  let last = await reproduces(cur, client, nClients);
  if (!last) return { ops: cur, reproduced: false };
  for (let chunk = Math.ceil(cur.length / 2); chunk >= 1 && Date.now() - t0 < budgetMs; chunk = Math.floor(chunk / 2)) {
    for (let start = 0; start < cur.length && Date.now() - t0 < budgetMs; ) {
      const cand = [...cur.slice(0, start), ...cur.slice(start + chunk)];
      const d = await reproduces(cand, client, nClients);
      if (d) { cur = cand; last = d; } else start += chunk;
    }
  }
  return { ops: cur, reproduced: true, divergence: last };
}

export async function run({ seed, ops: nOps = 3000, clients: nClients = 200 } = {}) {
  const s = area('model (randomized)');
  seed = seed ?? Math.floor(Math.random() * 2 ** 31);
  console.log(`  model: seed=${seed} ops=${nOps} clients=${nClients}`);
  const ops = generateOps(seed, nOps, nClients);
  const runner = new Runner(new Model(null));
  await freshStart(nClients, runner);
  const invariantFailures = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      await runner.exec(i, ops[i]);
    } catch (e) {
      runner.diverge(i, ops[i], null, 'exception', null, String(e.stack || e).slice(0, 300));
    }
    if ((i + 1) % 100 === 0 || i === ops.length - 1) {
      const v = await checkInvariants();
      if (v.length) invariantFailures.push({ afterOp: i, violations: v.slice(0, 5) });
      await runner.deepCompare(i);
    }
  }
  s.check(`seed ${seed}: invariants hold every 100 ops`, invariantFailures.length === 0, invariantFailures.slice(0, 3));
  s.check(`seed ${seed}: Worker agrees with the model (${runner.stats.ops} ops, ${runner.stats.requests} requests)`, runner.div.length === 0, runner.div.slice(0, 5));
  const out = { seed, ops: nOps, clients: nClients, executed: runner.stats, divergences: runner.div.slice(0, 20), invariantFailures: invariantFailures.slice(0, 5) };
  // shrink the first client-level divergence
  const first = runner.div.find((d) => d.client !== null);
  if (first) {
    console.log(`  model: shrinking divergence "${first.what}" of client #${first.client} at op ${first.op}…`);
    const sh = await shrink(ops.slice(0, first.op + 1), first.client, nClients);
    out.shrunk = sh;
    note('repro', `model seed=${seed}: "${first.what}" on client #${first.client}; minimal sequence (${sh.ops.length} ops, reproduced=${sh.reproduced}): ${JSON.stringify(sh.ops)}`);
  }
  return out;
}
