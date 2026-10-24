// Invariant checker: reads the local D1 directly (read-only SQL through the QA entry) and
// re-derives everything from the raw facts, independently of the engine code.
import { sql } from './api.mjs';

const DAY = 86_400_000;
const TZ_MS = 5 * 3_600_000; // Asia/Tashkent, UTC+5, no DST
export const tashkentDay = (iso) => new Date(Date.parse(iso) + TZ_MS).toISOString().slice(0, 10);
export const addDays = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const pctOf = (amount, pct) => (amount <= 0 || pct <= 0 ? 0 : Number((BigInt(amount) * BigInt(Math.floor(pct * 10_000 + 1e-6))) / 1_000_000n));

async function all(table, order = '') {
  return sql(`SELECT ${table === 'points_ledger' ? 'rowid AS _rowid, ' : ''}* FROM ${table} ${order}`);
}

function group(rows, key = 'client_id') {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Highest tier with threshold <= metric (or the override if higher). */
export function levelOf(tiers, metric, override = null, overrideIndex = null) {
  let idx = 0;
  tiers.forEach((t, i) => { if (metric >= t.threshold) idx = i; });
  if (override) {
    let oi = tiers.findIndex((t) => t.id === override);
    if (oi < 0 && overrideIndex !== null && overrideIndex !== undefined) oi = Math.min(overrideIndex, tiers.length - 1);
    if (oi > idx) idx = oi;
  }
  return { idx, tier: tiers[idx] };
}

/**
 * Check every invariant. Returns a list of violations { client, what, detail }.
 * opts.clients: restrict per-client checks to these ids (whole-table checks always run).
 */
export async function checkInvariants(opts = {}) {
  const v = [];
  const bad = (client, what, detail) => v.push({ client, what, detail });

  const [settings, rulesRows, clients, stats, purchases, ledger, moves, rewards, versions, keys, staff] = await Promise.all([
    all('settings'), all('rules_versions'), all('clients'), all('client_stats'), all('purchases', 'ORDER BY created_at, rowid'),
    all('points_ledger', 'ORDER BY rowid'), all('card_moves', 'ORDER BY id'), all('rewards', 'ORDER BY rowid'),
    all('client_versions', 'ORDER BY client_id, version'), sql('SELECT client_id, key FROM notification_keys'), all('staff'),
  ]);
  const rulesById = new Map(rulesRows.map((r) => [Number(r.id), JSON.parse(r.rules)]));
  const currentVersion = Number(settings.find((s) => s.key === 'rules_version')?.value ?? 1);
  const rules = rulesById.get(currentVersion);
  if (!rules) {
    bad(null, 'rules', `current rules version ${currentVersion} missing`);
    return v;
  }
  // TEST_MODE clock moved BACK (reset): purchases made "in the future" are ignored by the engine's
  // level metric (deriveLevel counts createdAt <= now), so spent/level depend on when the row was written.
  const offset = Number(settings.find((x) => x.key === 'clock_offset_days')?.value ?? 0);
  const nowIso = new Date(Date.now() + offset * 86_400_000).toISOString();
  const maxCellsEver = Math.max(...[...rulesById.values()].map((r) => r.honeycomb.maxCellsPerDay));
  const clientIds = new Set(clients.map((c) => c.id));
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));
  const rewardById = new Map(rewards.map((r) => [r.id, r]));

  // ---------------- orphans (whole tables)
  for (const [t, rows] of [['client_stats', stats], ['purchases', purchases], ['points_ledger', ledger], ['card_moves', moves], ['rewards', rewards], ['client_versions', versions], ['notification_keys', keys]]) {
    for (const r of rows) if (!clientIds.has(r.client_id)) bad(r.client_id, 'orphan', `${t} row of a missing client`);
  }
  for (const e of ledger) if (e.purchase_id && !purchaseById.has(e.purchase_id)) bad(e.client_id, 'orphan', `ledger ${e.id} → missing purchase ${e.purchase_id}`);
  for (const m of moves) if (m.purchase_id && !purchaseById.has(m.purchase_id)) bad(m.client_id, 'orphan', `card move ${m.id} → missing purchase`);
  for (const r of rewards) {
    if (r.unlocked_by_purchase && !purchaseById.has(r.unlocked_by_purchase)) bad(r.client_id, 'orphan', `reward ${r.id} → missing unlocking purchase`);
    if (r.used_in_purchase && !purchaseById.has(r.used_in_purchase)) bad(r.client_id, 'orphan', `reward ${r.id} → missing used_in purchase`);
  }
  for (const p of purchases) {
    if (p.reward_used_id && !rewardById.has(p.reward_used_id)) bad(p.client_id, 'orphan', `purchase ${p.id} used missing reward`);
    if (!rulesById.has(Number(p.rules_version_id))) bad(p.client_id, 'orphan', `purchase ${p.id} → missing rules version`);
  }
  const statsBy = new Map(stats.map((s) => [s.client_id, s]));
  const activeOwners = staff.filter((s) => s.role === 'owner' && Number(s.active) === 1).length;

  // ---------------- per client
  const P = group(purchases), L = group(ledger), M = group(moves), R = group(rewards), V = group(versions);
  for (const c of clients) {
    if (opts.clients && !opts.clients.has(c.id)) continue;
    const ps = P.get(c.id) ?? [], ls = L.get(c.id) ?? [], ms = M.get(c.id) ?? [], rs = R.get(c.id) ?? [], vs = V.get(c.id) ?? [];
    const st = statsBy.get(c.id);
    if (!st) { bad(c.id, 'stats', 'client has no client_stats row'); continue; }

    // versions contiguous 1..n
    vs.forEach((x, i) => { if (Number(x.version) !== i + 1) bad(c.id, 'versions', `client_versions not contiguous at ${i + 1}: ${x.version}`); });

    // ledger: running balance, double spend, expire semantics
    let run = 0;
    let negativeAllowed = false;
    for (const e of ls) {
      const before = run;
      run += Number(e.amount);
      if (e.type === 'redeem' && run < 0) bad(c.id, 'double-spend', `redeem ${e.amount} took the balance below zero (${before} → ${run})`);
      if (e.type === 'expire') {
        if (before <= 0) bad(c.id, 'expiry', `expire entry ${e.amount} on non-positive balance ${before}`);
        if (run !== 0) bad(c.id, 'expiry', `balance after expire is ${run}, expected 0`);
      }
      if ((e.type === 'reversal' && Number(e.amount) < 0) || (e.type === 'manual_adjust' && Number(e.amount) < 0)) negativeAllowed = true;
    }
    const balance = run;
    if (balance < 0 && !negativeAllowed) bad(c.id, 'negative', `balance ${balance} < 0 without a reversal / negative adjustment`);

    // purchases ⇄ ledger ⇄ result
    const active = ps.filter((p) => p.status === 'active');
    for (const p of ps) {
      const res = p.result ? JSON.parse(p.result) : null;
      const own = ls.filter((e) => e.purchase_id === p.id);
      const sum = (t) => own.filter((e) => e.type === t).reduce((s, e) => s + Number(e.amount), 0);
      const accr = sum('accrual'), red = sum('redeem'), rev = sum('reversal');
      const pr = rulesById.get(Number(p.rules_version_id));
      if (!res) { bad(c.id, 'purchase', `purchase ${p.id} has no result`); continue; }
      if (-red !== Number(p.points_redeemed)) bad(c.id, 'purchase', `redeem ledger ${-red} ≠ points_redeemed ${p.points_redeemed}`);
      if (accr !== res.cashback) bad(c.id, 'purchase', `accrual ledger ${accr} ≠ result.cashback ${res.cashback}`);
      if (res.paid !== Number(p.amount) - Number(p.discount_applied) - Number(p.points_redeemed)) bad(c.id, 'purchase', `paid ${res.paid} ≠ amount − discount − redeemed`);
      if (res.cashback !== pctOf(res.cashbackBase, res.cashbackPct)) bad(c.id, 'purchase', `cashback ${res.cashback} ≠ ${res.cashbackPct}% of ${res.cashbackBase}`);
      // the API sells flowers only; demo data also has card / delivery lines (no cashback on them)
      const onlyFlowers = JSON.parse(p.lines ?? '[]').every((l) => l.category === 'flowers');
      if (onlyFlowers ? res.cashbackBase !== res.paid : res.cashbackBase > res.paid) bad(c.id, 'purchase', `cashbackBase ${res.cashbackBase} vs paid ${res.paid} (${onlyFlowers ? 'all lines are flowers' : 'base above paid'})`);
      if (pr) {
        const tier = pr.levels.tiers.find((t) => t.id === res.levelBefore);
        if (!tier) bad(c.id, 'purchase', `levelBefore ${res.levelBefore} not in rules v${p.rules_version_id}`);
        else if (tier.cashbackPct !== res.cashbackPct) bad(c.id, 'purchase', `pct ${res.cashbackPct} ≠ tier ${tier.id} pct ${tier.cashbackPct} of rules v${p.rules_version_id}`);
        const cap = Math.max(0, Math.min(pctOf(Number(p.amount), pr.maxRedeemPct), Number(p.amount) - Number(p.discount_applied)));
        if (Number(p.points_redeemed) > cap) bad(c.id, 'purchase', `redeemed ${p.points_redeemed} > cap ${cap}`);
      }
      if (p.status === 'active' && own.some((e) => e.type === 'reversal')) bad(c.id, 'reversal', `active purchase ${p.id} has reversal entries`);
      if (p.status === 'reversed') {
        const expiredSince = ls.some((e) => e.type === 'expire' && e.created_at > p.created_at && e.created_at <= p.reversed_at);
        const expected = -red - (expiredSince ? 0 : accr);
        if (rev !== expected) bad(c.id, 'reversal', `reversal entries ${rev} ≠ expected ${expected} (purchase ${p.id}, expiredSince=${expiredSince})`);
      }
    }

    // card moves: active sequence must be a valid walk
    const cells = rules.honeycomb.cells;
    const activeMoves = ms.filter((m) => !m.reverted_at);
    let pos = { cycle: 1, filled: 0 };
    for (const m of activeMoves) {
      const cur = pos.filled >= cells ? { cycle: pos.cycle + 1, filled: 0 } : pos;
      if (m.reason === 'purchase') {
        if (Number(m.cycle) !== cur.cycle || Number(m.cell) !== cur.filled + 1) bad(c.id, 'card', `move ${m.id} (c${m.cycle}/${m.cell}) does not follow c${cur.cycle}/${cur.filled}`);
        pos = { cycle: Number(m.cycle), filled: Number(m.cell) };
      } else {
        pos = { cycle: Number(m.cycle), filled: 0 };
      }
    }
    const perDay = new Map();
    for (const m of activeMoves) {
      if (m.reason !== 'purchase') continue;
      const p = purchaseById.get(m.purchase_id);
      if (!p || p.status !== 'active') continue;
      const d = tashkentDay(m.created_at);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    for (const [d, n] of perDay) if (n > maxCellsEver) bad(c.id, 'card', `${n} cells filled on ${d} (max ${maxCellsEver})`);
    for (const p of active) {
      const res = JSON.parse(p.result);
      const mv = activeMoves.find((m) => m.purchase_id === p.id);
      if (res.cellAdvanced && !mv) bad(c.id, 'card', `active purchase ${p.id} advanced a cell but has no active move`);
      if (!res.cellAdvanced && ms.some((m) => m.purchase_id === p.id)) bad(c.id, 'card', `purchase ${p.id} has a move but result.cellAdvanced=false`);
      if (mv && Number(mv.cell) !== res.cell) bad(c.id, 'card', `purchase ${p.id} cell ${res.cell} ≠ move cell ${mv.cell}`);
    }

    // rewards
    for (const r of rs) {
      const up = purchaseById.get(r.unlocked_by_purchase);
      if (up) {
        const mv = ms.find((m) => m.purchase_id === up.id);
        if (!mv || Number(mv.cell) !== Number(r.cell) || Number(mv.cycle) !== Number(r.cycle)) bad(c.id, 'reward', `reward ${r.id} cell does not match its purchase move`);
        if (up.status === 'reversed' && r.status === 'available') bad(c.id, 'reward', `reward ${r.id} of a reversed purchase is still available`);
      }
      if (r.status === 'used' && !r.used_at) bad(c.id, 'reward', `used reward ${r.id} without used_at`);
      if (r.status !== 'used' && (r.used_in_purchase || r.used_at)) bad(c.id, 'reward', `reward ${r.id} is ${r.status} but has used fields`);
      const usedBy = ps.filter((p) => p.reward_used_id === r.id && p.status === 'active');
      if (usedBy.length > 1) bad(c.id, 'reward', `reward ${r.id} used in ${usedBy.length} active purchases`);
      if (usedBy.length === 1 && (r.status !== 'used' || r.used_in_purchase !== usedBy[0].id)) bad(c.id, 'reward', `reward ${r.id} used in active purchase ${usedBy[0].id} but status=${r.status} used_in=${r.used_in_purchase}`);
      if (r.status === 'used' && r.used_in_purchase && purchaseById.get(r.used_in_purchase)?.status !== 'active') bad(c.id, 'reward', `reward ${r.id} marked used in a reversed purchase`);
    }

    // client_stats == recomputed
    const overrideAt = c.level_override_at;
    const counted = active.filter((p) => !overrideAt || p.created_at >= overrideAt);
    const spent = rules.levels.criterion === 'sum' ? counted.reduce((s, p) => s + Number(p.amount), 0) : counted.length;
    const lvl = levelOf(rules.levels.tiers, spent, c.level_override, c.level_override_index);
    let anchor = c.created_at;
    for (const p of active) if (p.created_at > anchor) anchor = p.created_at;
    for (const e of ls) if ((e.type === 'manual_adjust' || e.type === 'welcome') && Number(e.amount) > 0 && e.created_at > anchor) anchor = e.created_at;
    const last = active.reduce((m, p) => (p.created_at > m ? p.created_at : m), '');
    const expect = {
      balance,
      spent,
      purchases_count: active.length,
      last_purchase_at: last,
      level_id: lvl.tier.id,
      gifts_available: rs.filter((r) => r.status === 'available').length,
      activity_at: anchor,
      expires_on: balance > 0 ? addDays(tashkentDay(anchor), rules.expiry.expiryDays - 1) : '',
      // totals of the bounded state load (migration 0010): exact, whatever the rules
      level_sum: counted.reduce((s, p) => s + Number(p.amount), 0),
      level_count: counted.length,
    };
    // Daily-job schedule (R3): a positive balance always has a check date no later than its burn day.
    if (balance > 0 && rules.expiry.expiryDays > 0) {
      const burn = addDays(tashkentDay(anchor), rules.expiry.expiryDays);
      const due = burn > tashkentDay(nowIso) ? burn : tashkentDay(nowIso); // overdue → due today
      if (!c.next_check_on || c.next_check_on > due) bad(c.id, 'schedule', `next_check_on ${c.next_check_on} but the balance ${balance} burns on ${burn}`);
    }
    const future = active.some((p) => p.created_at > nowIso);
    for (const [k, want] of Object.entries(expect)) {
      if (future && (k === 'spent' || k === 'level_id')) continue;
      const got = typeof want === 'number' ? Number(st[k]) : String(st[k] ?? '');
      if (got !== want) bad(c.id, 'stats', `client_stats.${k} = ${JSON.stringify(got)}, recomputed ${JSON.stringify(want)}`);
    }
  }
  // Daily aggregates (owner stats, console overview) == recomputation from the raw rows.
  for (const x of await checkStatsDaily()) v.push(x);
  return Object.assign(v, { meta: { clients: clients.length, purchases: purchases.length, ledger: ledger.length, rulesVersion: currentVersion, activeOwners } });
}

// ---------------------------------------------------------------- stats_daily (migration 0007)

const STATS_COLS = ['purchases', 'revenue', 'first_purchases', 'buyers', 'last_buyers', 'prev_buyers', 'new_clients', 'imported_clients',
  'honey_accrued', 'honey_redeemed', 'honey_expired', 'honey_imported', 'gifts_unlocked', 'gifts_used', 'reversals', 'reversed_amount'];

/**
 * Recompute the daily aggregates from the raw rows in JS (independently of the Worker's SQL) and
 * compare with stats_daily. Returns violations like checkInvariants.
 */
export async function checkStatsDaily() {
  const [clients, imports, purchases, ledger, rewards, table] = await Promise.all([
    sql('SELECT id, created_at FROM clients'), sql('SELECT client_id FROM client_imports'),
    sql('SELECT client_id, amount, status, created_at, reversed_at FROM purchases'),
    sql('SELECT type, amount, idempotency_key, created_at FROM points_ledger'),
    sql('SELECT status, unlocked_at, used_at FROM rewards'), sql('SELECT * FROM stats_daily'),
  ]);
  const want = new Map();
  const add = (day, col, n = 1) => {
    for (const d of [day, '*']) {
      if (!want.has(d)) want.set(d, Object.fromEntries(STATS_COLS.map((c) => [c, 0])));
      want.get(d)[col] += n;
    }
  };
  const imported = new Set(imports.map((r) => r.client_id));
  for (const c of clients) add(tashkentDay(c.created_at), imported.has(c.id) ? 'imported_clients' : 'new_clients');
  const byClient = new Map();
  for (const p of purchases) {
    if (p.status === 'active') {
      add(tashkentDay(p.created_at), 'purchases');
      add(tashkentDay(p.created_at), 'revenue', Number(p.amount));
      if (!byClient.has(p.client_id)) byClient.set(p.client_id, []);
      byClient.get(p.client_id).push(p.created_at);
    } else {
      add(tashkentDay(p.reversed_at), 'reversals');
      add(tashkentDay(p.reversed_at), 'reversed_amount', Number(p.amount));
    }
  }
  for (const ats of byClient.values()) {
    ats.sort();
    for (const d of new Set(ats.map(tashkentDay))) add(d, 'buyers');
    for (const at of ats) if (at === ats[0]) add(tashkentDay(at), 'first_purchases');
    add(tashkentDay(ats[ats.length - 1]), 'last_buyers');
    if (ats.length >= 2) add(tashkentDay(ats[ats.length - 2]), 'prev_buyers');
  }
  for (const e of ledger) {
    const a = Number(e.amount), day = tashkentDay(e.created_at), imp = String(e.idempotency_key ?? '').startsWith('import:');
    if (e.type === 'accrual' || e.type === 'welcome') add(day, 'honey_accrued', a);
    else if (e.type === 'redeem') add(day, 'honey_redeemed', -a);
    else if (e.type === 'expire') add(day, 'honey_expired', -a);
    else if (e.type === 'reversal') a < 0 ? add(day, 'honey_accrued', a) : add(day, 'honey_redeemed', -a);
    else if (e.type === 'manual_adjust') a > 0 ? add(day, imp ? 'honey_imported' : 'honey_accrued', a) : add(day, 'honey_redeemed', -a);
  }
  for (const r of rewards) {
    if (r.status !== 'revoked') add(tashkentDay(r.unlocked_at), 'gifts_unlocked');
    if (r.status === 'used') add(tashkentDay(r.used_at), 'gifts_used');
  }
  const v = [];
  const got = new Map(table.map((r) => [r.day, r]));
  for (const day of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(day), g = got.get(day);
    for (const c of STATS_COLS) {
      const a = Number(g?.[c] ?? 0), b = Number(w?.[c] ?? 0);
      if (a !== b) v.push({ client: null, what: 'stats_daily', detail: `${day}.${c} = ${a}, recomputed ${b}` });
    }
  }
  return v;
}

/** After the daily job ran to completion: nobody keeps a positive balance past its expiry day. */
export async function checkExpirySettled(nowIso) {
  const today = tashkentDay(nowIso);
  const rows = await sql(`SELECT s.client_id, s.balance, s.expires_on FROM client_stats s WHERE s.balance > 0 AND s.expires_on <> '' AND s.expires_on < ?`, [today]);
  return rows.map((r) => ({ client: r.client_id, what: 'expiry', detail: `balance ${r.balance} still positive, last valid day ${r.expires_on} < today ${today}` }));
}

/** Cheap fingerprint of all business tables (for "no state change on rejected requests"). */
export async function fingerprint() {
  const [r] = await sql(`SELECT
    (SELECT COUNT(*) FROM clients) AS clients, (SELECT COUNT(*) FROM purchases) AS purchases,
    (SELECT COUNT(*) FROM purchases WHERE status = 'reversed') AS reversed,
    (SELECT COUNT(*) FROM points_ledger) AS ledger, (SELECT COALESCE(SUM(amount), 0) FROM points_ledger) AS points,
    (SELECT COUNT(*) FROM card_moves) AS moves, (SELECT COUNT(*) FROM card_moves WHERE reverted_at IS NOT NULL) AS reverted,
    (SELECT COUNT(*) FROM rewards) AS rewards, (SELECT COUNT(*) FROM rewards WHERE status = 'used') AS used,
    (SELECT COUNT(*) FROM client_versions) AS versions, (SELECT COUNT(*) FROM staff) AS staff,
    (SELECT COUNT(*) FROM staff WHERE active = 1) AS staff_active, (SELECT COUNT(*) FROM rules_versions) AS rules,
    (SELECT COUNT(*) FROM export_links) AS links, (SELECT group_concat(COALESCE(note, ''), '|') FROM clients) AS notes,
    (SELECT group_concat(phone || ':' || COALESCE(name, '') || ':' || language, '|') FROM clients) AS profiles,
    (SELECT value FROM settings WHERE key = 'clock_offset_days') AS clock,
    (SELECT COUNT(*) FROM notifications_log) AS notifications`);
  return r;
}
