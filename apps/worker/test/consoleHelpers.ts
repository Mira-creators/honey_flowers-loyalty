import type { WebLinkDTO, WebSessionDTO } from '@honey/contracts';
import app from '../src/app.js';
import type { Env } from '../src/env.js';
import { computeClientStats } from '../src/lib/clientStats.js';
import { call, execCtx, json, repo, testEnv } from './helpers.js';

/** Owner console test helpers: login link → session, Bearer requests, fixture rows. */

export async function webLink(owner: number): Promise<WebLinkDTO> {
  const res = await call('/api/owner/web-link', { user: owner, body: {} });
  if (res.status !== 201) throw new Error(`web-link failed: ${res.status} ${await res.text()}`);
  return json<WebLinkDTO>(res);
}

export const tokenOf = (link: WebLinkDTO) => new URL(link.url).hash.replace(/^#t=/, '');

export async function exchange(token: string, env: Env = testEnv): Promise<Response> {
  const { ctx, flush } = execCtx();
  const res = await app.request('/api/web/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }, env, ctx);
  await flush();
  return res;
}

export async function session(owner: number): Promise<string> {
  const res = await exchange(tokenOf(await webLink(owner)));
  if (res.status !== 201) throw new Error(`session failed: ${res.status} ${await res.text()}`);
  return (await json<WebSessionDTO>(res)).session;
}

export async function bearer(path: string, sessionToken: string, opts: { env?: Env; body?: unknown; method?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${sessionToken}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const { ctx, flush } = execCtx();
  const res = await app.request(
    path,
    { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    opts.env ?? testEnv,
    ctx,
  );
  await flush();
  return res;
}

/** Tashkent noon of a day, as stored (UTC ISO). */
export const noon = (day: string) => `${day}T07:00:00.000Z`;

export const db = () => testEnv.DB;

export async function addClient(c: {
  id: string;
  tid: number;
  phone: string;
  name: string;
  createdAt: string;
  birthday?: string | null;
  override?: { id: string; at: string; index: number } | null;
}) {
  await db()
    .prepare(
      `INSERT INTO clients (id, telegram_id, code, phone, name, birthday, language, consent_at, created_at, level_override, level_override_at, level_override_index)
       VALUES (?, ?, ?, ?, ?, ?, 'ru', ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.tid, `HF${String(Math.abs(c.tid) % 1_000_000).padStart(6, '0')}`, c.phone, c.name, c.birthday ?? null, c.createdAt, c.createdAt, c.override?.id ?? null, c.override?.at ?? null, c.override?.index ?? null)
    .run();
}

export async function addPurchase(p: { id: string; client: string; amount: number; at: string; staff?: string | null; reversedAt?: string | null; cashback?: number }) {
  const stmts = [
    db()
      .prepare(
        `INSERT INTO purchases (id, client_id, staff_id, amount, lines, channel, points_redeemed, discount_applied, reward_used_id, idempotency_key,
           rules_version_id, result, status, reversed_reason, reversed_by, reversed_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'store', 0, 0, NULL, ?, 1, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.id,
        p.client,
        p.staff ?? null,
        p.amount,
        JSON.stringify([{ category: 'flowers', amount: p.amount }]),
        `k-${p.id}`,
        p.reversedAt ? 'reversed' : 'active',
        p.reversedAt ? 'ошибка кассы' : null,
        p.reversedAt ? p.staff ?? null : null,
        p.reversedAt ?? null,
        p.at,
      ),
  ];
  if (p.cashback) {
    stmts.push(ledgerStmt({ id: `l-${p.id}`, client: p.client, type: 'accrual', amount: p.cashback, purchase: p.id, at: p.at }));
    if (p.reversedAt) stmts.push(ledgerStmt({ id: `lr-${p.id}`, client: p.client, type: 'reversal', amount: -p.cashback, purchase: p.id, at: p.reversedAt, reason: 'accrual reversed' }));
  }
  await db().batch(stmts);
}

function ledgerStmt(l: { id: string; client: string; type: string; amount: number; at: string; purchase?: string | null; staff?: string | null; reason?: string | null; key?: string | null }) {
  return db()
    .prepare('INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(l.id, l.client, l.type, l.amount, l.purchase ?? null, l.staff ?? null, l.reason ?? null, l.key ?? null, l.at);
}

export async function addLedger(l: Parameters<typeof ledgerStmt>[0]) {
  await ledgerStmt(l).run();
}

export async function addReward(r: { id: string; client: string; cell: number; unlockedAt: string; usedAt?: string | null; status?: string }) {
  await db()
    .prepare(
      `INSERT INTO rewards (id, client_id, cycle, cell, type, value, title, status, unlocked_by_purchase, used_in_purchase, used_idempotency_key, unlocked_at, used_at)
       VALUES (?, ?, 1, ?, 'free_card', NULL, 'Открытка', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(r.id, r.client, r.cell, r.status ?? (r.usedAt ? 'used' : 'available'), r.unlockedAt, r.usedAt ?? null)
    .run();
}

export async function seedRules() {
  await repo().getActiveRules();
}

/**
 * Fixture rows are inserted with raw SQL, so their client_stats summaries (migration 0004) are
 * written here the way saveOutcome does: computed by the engine from each client's full state.
 */
export async function refreshStats(now = new Date()) {
  const r = repo();
  const { rules } = await r.getActiveRules();
  const ids = (await db().prepare('SELECT id FROM clients ORDER BY id').all<{ id: string }>()).results.map((x) => x.id);
  for (let k = 0; k < ids.length; k += 90) {
    const states = await r.loadClientStates(ids.slice(k, k + 90));
    const stmts = [...states].map(([id, v]) => r.statsUpsertStmt(id, computeClientStats(rules, v.state, now), now));
    if (stmts.length) await db().batch(stmts);
  }
  // stats_daily (migration 0007) is maintained by the write paths; raw fixtures rebuild it.
  await r.rebuildDailyStats();
  // The daily job's schedule (clients.next_check_on, migration 0008) is written by every write
  // path too; raw fixtures get it from the set-based recompute (the same SQL as a rules change).
  await db().batch(await r.nextChecksStmts(rules, new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)));
}
