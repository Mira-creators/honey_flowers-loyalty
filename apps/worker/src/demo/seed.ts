import type { TestDemoClearDTO, TestDemoSeedDTO } from '@honey/contracts';
import {
  applyPurchase,
  availableRewards,
  emptyClientState,
  maxRedeemable,
  redeem,
  registerClient,
  reversePurchase,
  runExpiry,
  type ClientState,
  type LoyaltyRules,
  type PurchaseLine,
} from '@honey/core';
import { ClientSimulation } from '@honey/service';
import type { AppContext } from '../context.js';
import type { D1Repository } from '../db/d1Repository.js';
import { computeClientStats } from '../lib/clientStats.js';
import { byIds, contributionStmts, invalidateBuyersStmt } from '../lib/statsDaily.js';
import { nextCheckOn } from '../lib/expirySchedule.js';
import {
  DAY,
  DEMO_STAFF,
  DEMO_TOTAL,
  demoClientId,
  demoCode,
  demoLedgerId,
  demoPhone,
  demoPlan,
  demoProfile,
  demoPurchaseId,
  demoStaffId,
  demoStaffTelegramId,
  demoTelegramId,
  type ClientPlan,
} from './data.js';

/**
 * TEST_MODE demo data for the briefing: ~250 clients with ~6 months of history.
 *
 * Every client's history is replayed through the REAL engine (ClientSimulation: each
 * command — registration, purchase with gifts / мёд, gift hand-out, reversal, the nightly
 * expiry job at 09:00 Tashkent — runs at its own explicit past `now`), so balances, cells,
 * levels, gifts, burned мёд and the ledger are exactly what the rules produce. The final
 * state is written with the same row statements saveOutcome uses, in ONE batch per chunk
 * (client rows + all facts: atomic, ~2 + 1 round trips per request, far below 50).
 *
 * Deterministic (seeded per client, dates relative to an anchor stored on the first call)
 * and idempotent (existing demo ids are skipped). Rows are marked clients.demo = 1 /
 * staff.demo = 1; demo clients have negative telegram ids and are never messaged.
 */

/** 5 clients ≈ 3 ms of engine CPU (measured ~0.65 ms per client in Node): well inside the 10 ms Workers Free limit. */
export const DEMO_CHUNK = 5;
export const DEMO_CHUNKS = Math.ceil(DEMO_TOTAL / DEMO_CHUNK);
const ANCHOR_KEY = 'demo_seed_anchor';
const NIGHT_JOB_UTC = 'T04:00:00.000Z'; // cron "0 4 * * *" = 09:00 Tashkent

/** Run the nightly job wherever it would have run (next_check_on logic) between the last command and `untilMs`. */
function runNights(sim: ClientSimulation, startMs: number, untilMs: number): void {
  for (let guard = 0; guard < 40; guard++) {
    const cursor = sim.lastNow ?? new Date(startMs);
    const on = nextCheckOn(sim.rules, sim.state, cursor);
    if (on === null) return;
    let runAt = Date.parse(`${on}${NIGHT_JOB_UTC}`);
    while (runAt <= cursor.getTime()) runAt += DAY;
    if (runAt >= untilMs) return;
    sim.run(new Date(runAt), runExpiry);
  }
}

export interface SimulatedClient {
  state: ClientState;
  /** clients.next_check_on as the daily job would store it now. */
  nextCheckOn: string | null;
}

/** Replay one planned client through the engine. */
export function simulateDemoClient(rules: LoyaltyRules, plan: ClientPlan, anchorMs: number): SimulatedClient {
  const id = demoClientId(plan.i);
  const sim = new ClientSimulation(rules, emptyClientState(id, new Date(plan.registeredAt)));
  sim.run(new Date(plan.registeredAt), registerClient);
  let n = 0;
  for (const p of plan.purchases) {
    runNights(sim, plan.registeredAt, p.at);
    const staffId = demoStaffId(p.staff);
    const lines: PurchaseLine[] = [{ category: 'flowers', amount: p.flowers }];
    if (p.card) lines.push({ category: 'cards', amount: p.card });
    if (p.delivery) lines.push({ category: 'delivery', amount: p.delivery });

    // Gifts: a free card goes with an order that has a card, free delivery with a delivery,
    // the discount on a later order; otherwise the card is sometimes handed out on its own.
    const avail = availableRewards(sim.state);
    const cardGift = avail.find((r) => r.type === 'free_card');
    const deliveryGift = avail.find((r) => r.type === 'free_delivery');
    const discountGift = avail.find((r) => r.type === 'discount_pct');
    let giftId: string | null = null;
    if (p.card && cardGift) giftId = cardGift.id;
    else if (p.delivery && deliveryGift) giftId = deliveryGift.id;
    else if (discountGift && p.useDiscount) giftId = discountGift.id;
    if (!giftId && cardGift && p.handOutCard && !p.card) {
      const at = new Date(Math.max(p.at - 60_000, (sim.lastNow?.getTime() ?? 0) + 1_000));
      sim.run(at, (r, s, now) =>
        redeem(r, s, { idempotencyKey: `gift-use:${cardGift.id}`, staffId, rewardId: cardGift.id, reason: 'подарок выдан' }, now),
      );
    }
    const usesDiscount = giftId !== null && giftId === discountGift?.id;

    const t = new Date(Math.max(p.at, (sim.lastNow?.getTime() ?? 0) + 1_000));
    let redeemPoints = 0;
    if (p.redeemShare > 0 && !(usesDiscount && !rules.allowDiscountWithPoints)) {
      const max = maxRedeemable(rules, sim.state, lines, giftId, t);
      redeemPoints = p.redeemShare >= 1 ? max : Math.floor((max * p.redeemShare) / 1_000) * 1_000;
      if (redeemPoints < 1_000) redeemPoints = 0; // nobody pays with a few hundred мёда
    }
    n += 1;
    const pid = demoPurchaseId(plan.i, n);
    const key = `demo-${plan.i}-${n}`;
    sim.run(t, (r, s, now) =>
      applyPurchase(r, s, { purchaseId: pid, idempotencyKey: key, staffId, lines, channel: p.delivery ? 'delivery' : 'store', redeemPoints, useRewardId: giftId }, now),
    );

    if (p.reversal) {
      const reason = p.reversal.reason;
      const rt = new Date(t.getTime() + (6 + (n % 5) * 7) * 60_000);
      sim.run(rt, (r, s, now) => reversePurchase(r, s, { purchaseId: pid, reason, staffId }, now));
      if (p.reversal.correctedFlowers) {
        n += 1;
        const pid2 = demoPurchaseId(plan.i, n);
        const key2 = `demo-${plan.i}-${n}`;
        const fixed: PurchaseLine[] = lines.map((l) => (l.category === 'flowers' ? { ...l, amount: p.reversal!.correctedFlowers! } : l));
        sim.run(new Date(rt.getTime() + 4 * 60_000), (r, s, now) =>
          applyPurchase(r, s, { purchaseId: pid2, idempotencyKey: key2, staffId, lines: fixed, channel: p.delivery ? 'delivery' : 'store', redeemPoints: 0, useRewardId: null }, now),
        );
      }
    }
  }
  runNights(sim, plan.registeredAt, anchorMs);
  return { state: sim.state, nextCheckOn: nextCheckOn(rules, sim.state, new Date(anchorMs)) };
}

interface Identity {
  code: string;
  phone: string;
}

/** Codes / phones that are free (a real client might own one by chance): salted until unique. */
async function resolveIdentities(db: D1Database, indices: number[]): Promise<{ existing: Set<string>; ident: Map<number, Identity> }> {
  const ident = new Map<number, Identity>(indices.map((i) => [i, { code: demoCode(i), phone: demoPhone(i) }]));
  const ownIds = new Set(indices.map(demoClientId));
  const existing = new Set<string>();
  let pending = [...indices];
  for (let round = 0; round < 4 && pending.length; round++) {
    const ids = pending.map(demoClientId);
    const codes = pending.map((i) => ident.get(i)!.code);
    const phones = pending.map((i) => ident.get(i)!.phone);
    const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id, code, phone FROM clients WHERE id IN (${ph(ids.length)}) OR code IN (${ph(codes.length)}) OR phone IN (${ph(phones.length)})`)
      .bind(...ids, ...codes, ...phones)
      .all<{ id: string; code: string; phone: string | null }>();
    const takenCodes = new Set<string>();
    const takenPhones = new Set<string>();
    for (const r of results) {
      if (ownIds.has(r.id)) existing.add(r.id);
      else {
        takenCodes.add(r.code);
        if (r.phone) takenPhones.add(r.phone);
      }
    }
    const next: number[] = [];
    for (const i of pending) {
      if (existing.has(demoClientId(i))) continue;
      const cur = ident.get(i)!;
      if (takenCodes.has(cur.code) || takenPhones.has(cur.phone)) {
        const salt = round + 1;
        ident.set(i, { code: takenCodes.has(cur.code) ? demoCode(i, salt) : cur.code, phone: takenPhones.has(cur.phone) ? demoPhone(i, salt) : cur.phone });
        next.push(i);
      }
    }
    pending = next;
  }
  return { existing, ident };
}

function clientStatements(repo: D1Repository, rules: LoyaltyRules, i: number, ident: Identity, sim: SimulatedClient, anchorIso: string, now: Date): D1PreparedStatement[] {
  const db = repo.db;
  const s = sim.state;
  const id = s.clientId;
  const profile = demoProfile(i);
  const created = s.registeredAt.toISOString();
  const o = s.levelOverride;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO clients (id, telegram_id, code, phone, name, birthday, language, consent_at, level_override, level_override_at,
           level_override_index, created_at, next_check_on, demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        id,
        demoTelegramId(i),
        ident.code,
        ident.phone,
        profile.name,
        profile.birthday,
        profile.language,
        created,
        o?.levelId ?? null,
        o ? o.setAt.toISOString() : null,
        o?.levelIndex ?? null,
        created,
        sim.nextCheckOn,
      ),
    db.prepare('INSERT INTO client_versions (client_id, version) VALUES (?, 1)').bind(id),
  ];
  for (const p of s.purchases) stmts.push(repo.purchaseUpsertStmt(id, p));
  s.ledger.forEach((e, k) => stmts.push(repo.ledgerInsertStmt(id, { ...e, id: demoLedgerId(i, k + 1) })));
  for (const m of s.cardMoves) stmts.push(repo.cardMoveInsertStmt(id, m));
  for (const r of s.rewards) stmts.push(repo.rewardInsertStmt(id, r));
  for (const k of s.sentNotificationKeys) stmts.push(repo.notificationKeyInsertStmt(id, k, anchorIso));
  // Owner's client list summary (migration 0004), computed exactly like saveOutcome does.
  stmts.push(repo.statsUpsertStmt(id, computeClientStats(rules, s, now), now));
  return stmts;
}

/** Anchor instant of the demo timeline: stored on the first call, reused by every chunk. */
async function demoAnchor(app: AppContext): Promise<number> {
  const stored = await app.repo.getSetting(ANCHOR_KEY);
  if (stored && Number.isFinite(Date.parse(stored))) return Date.parse(stored);
  await app.repo.db
    .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .bind(ANCHOR_KEY, app.now().toISOString())
    .run();
  return Date.parse((await app.repo.getSetting(ANCHOR_KEY))!);
}

export async function seedDemoChunk(app: AppContext, chunk: number): Promise<TestDemoSeedDTO> {
  const repo = app.repo;
  const db = repo.db;
  const anchorMs = await demoAnchor(app);
  const anchorIso = new Date(anchorMs).toISOString();
  const { rules } = await repo.getActiveRules(app.now());
  const first = chunk * DEMO_CHUNK + 1;
  const indices = Array.from({ length: Math.max(0, Math.min(DEMO_CHUNK, DEMO_TOTAL - first + 1)) }, (_, k) => first + k);

  let created = 0;
  if (indices.length) {
    const { existing, ident } = await resolveIdentities(db, indices);
    const stmts: D1PreparedStatement[] = DEMO_STAFF.map((st) =>
      db
        .prepare(`INSERT OR IGNORE INTO staff (id, telegram_id, phone, name, role, active, created_at, demo) VALUES (?, ?, NULL, ?, ?, 1, ?, 1)`)
        .bind(demoStaffId(st.j), demoStaffTelegramId(st.j), st.name, st.role, new Date(anchorMs - 200 * DAY).toISOString()),
    );
    const createdIds: string[] = [];
    for (const i of indices) {
      if (existing.has(demoClientId(i))) continue;
      try {
        const sim = simulateDemoClient(rules, demoPlan(i, anchorMs), anchorMs);
        stmts.push(...clientStatements(repo, rules, i, ident.get(i)!, sim, anchorIso, app.now()));
        createdIds.push(demoClientId(i));
        created++;
      } catch (err) {
        // A plan the current rules reject (e.g. after an unusual rules edit) is skipped, not fatal.
        console.error(`demo client ${i} skipped`, err);
      }
    }
    if (created) {
      // stats_daily (migration 0007): demo history counts like real activity, on its past days.
      stmts.push(...contributionStmts(db, 1, byIds, [JSON.stringify(createdIds)]), invalidateBuyersStmt(db));
      await db.batch(stmts);
    }
  }
  const done = Number((await db.prepare('SELECT COUNT(*) AS n FROM clients WHERE demo = 1').first<{ n: number }>())?.n ?? 0);
  const last = chunk >= DEMO_CHUNKS - 1;
  return { chunk, chunks: DEMO_CHUNKS, total: DEMO_TOTAL, done, created, finished: last, nextChunk: last ? null : chunk + 1 };
}

/** Tables with per-client rows that this file knows about (deleted in FK-safe order). */
const CLIENT_TABLES = ['points_ledger', 'card_moves', 'rewards', 'purchases', 'notification_keys', 'notifications_log', 'important_dates', 'client_versions', 'client_stats'];

/** Remove exactly the demo records: demo clients with all their facts, demo staff, the anchor. */
export async function clearDemo(app: AppContext): Promise<TestDemoClearDTO> {
  const db = app.repo.db;
  const counts = await db
    .prepare('SELECT (SELECT COUNT(*) FROM clients WHERE demo = 1) AS clients, (SELECT COUNT(*) FROM staff WHERE demo = 1) AS staff')
    .first<{ clients: number; staff: number }>();
  const demoIds = 'SELECT id FROM clients WHERE demo = 1';
  // Per-client tables added by other features later (e.g. client_stats) are found in the schema.
  try {
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%client_id%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`)
      .all<{ name: string }>();
    for (const { name } of results) {
      if (CLIENT_TABLES.includes(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      try {
        await db.prepare(`DELETE FROM "${name}" WHERE client_id IN (${demoIds})`).run();
      } catch (err) {
        console.error(`demo clear: ${name} skipped`, err);
      }
    }
  } catch (err) {
    console.error('demo clear: schema lookup failed', err);
  }
  await db.batch([
    ...contributionStmts(db, -1, (col) => `${col} IN (${demoIds})`),
    invalidateBuyersStmt(db),
    db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_ledger_delete')`),
    ...CLIENT_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE client_id IN (${demoIds})`)),
    db.prepare('DELETE FROM clients WHERE demo = 1'),
    db.prepare('DELETE FROM staff WHERE demo = 1'),
    db.prepare('DELETE FROM settings WHERE key = ?').bind(ANCHOR_KEY),
    db.prepare(`DELETE FROM maintenance WHERE flag = 'allow_ledger_delete'`),
  ]);
  return { clients: Number(counts?.clients ?? 0), staff: Number(counts?.staff ?? 0) };
}
