/**
 * QA-only Worker entry (never deployed): wraps the real Worker (apps/worker/src/index.ts) to
 *   - count D1 round trips / statements / rows per HTTP request and per cron run,
 *     including work done in ctx.waitUntil (notifications) and while a CSV streams;
 *   - count outgoing fetch() calls (Telegram Bot API) per request (sequential use only);
 *   - expose /__qa/* helpers for the QA harness (read-only SQL, wipe, cron with counters).
 * /__qa/* answers only in TEST_MODE and only with the X-Test-Key header.
 * The product code is imported unchanged; the counting proxy is the same idea as
 * apps/worker/test/d1Counter.ts.
 */
import { applyPurchase, manualAdjust, maxRedeemable, reversePurchase } from '@honey/core';
import { LoyaltyService } from '@honey/service';
import worker from '../apps/worker/src/index.ts';
import { D1Repository } from '../apps/worker/src/db/d1Repository.ts';
import type { Env } from '../apps/worker/src/env.ts';
import { shiftedNow } from '../apps/worker/src/lib/clock.ts';

interface Counter {
  calls: number;
  batches: number;
  stmts: number;
  rowsRead: number;
  rowsWritten: number;
  fetches: number;
  maxBatch: number;
  log: string[];
  status: number;
  ms: number;
  done: boolean;
}

const newCounter = (): Counter => ({ calls: 0, batches: 0, stmts: 0, rowsRead: 0, rowsWritten: 0, fetches: 0, maxBatch: 0, log: [], status: 0, ms: 0, done: false });

/** Per-request counters by X-QA-Req id (bounded). */
const byReq = new Map<string, Counter>();
function remember(id: string, c: Counter) {
  byReq.set(id, c);
  if (byReq.size > 20_000) byReq.delete(byReq.keys().next().value!);
}

function countingDb(db: D1Database, c: Counter): D1Database {
  const meta = (m: { rows_read?: number; rows_written?: number } | undefined) => {
    if (!m) return;
    c.rowsRead += m.rows_read ?? 0;
    c.rowsWritten += m.rows_written ?? 0;
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const bind = s.bind.bind(s);
    const w = Object.create(s) as D1PreparedStatement & Record<string, unknown>;
    (w as any).bind = (...a: unknown[]) => wrap(bind(...a), sql);
    (w as any).__inner = s;
    for (const m of ['run', 'all', 'raw', 'first'] as const) {
      const orig = (s as any)[m].bind(s);
      (w as any)[m] = async (...a: unknown[]) => {
        c.calls++;
        c.stmts++;
        if (c.log.length < 200) c.log.push(sql.replace(/\s+/g, ' ').slice(0, 90));
        const r = await orig(...a);
        if (m !== 'first') meta((r as any)?.meta);
        return r;
      };
    }
    return w;
  };
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
      if (p === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          c.calls++;
          c.batches++;
          c.stmts += stmts.length;
          c.maxBatch = Math.max(c.maxBatch, stmts.length);
          if (c.log.length < 200) c.log.push(`BATCH(${stmts.length})`);
          const r = await t.batch(stmts.map((s) => ((s as any).__inner ?? s) as D1PreparedStatement));
          for (const x of r) meta((x as any).meta);
          return r;
        };
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as D1Database;
}

/** Outgoing fetch counter: attributes calls to the counter of the request that is "current". */
let currentFetchCounter: Counter | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (currentFetchCounter) currentFetchCounter.fetches++;
  return realFetch(input, init);
}) as typeof fetch;

function wrapCtx(ctx: ExecutionContext, pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
      ctx.waitUntil(p);
    },
    passThroughOnException: () => ctx.passThroughOnException(),
    props: (ctx as any).props ?? {},
  } as unknown as ExecutionContext;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

async function qaRoute(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const testMode = env.TEST_MODE === '1' || env.TEST_MODE === 'true';
  if (!testMode || !env.TEST_KEY || req.headers.get('x-test-key') !== env.TEST_KEY) return json({ error: 'qa endpoints need TEST_MODE and X-Test-Key' }, 404);
  const path = url.pathname.slice('/__qa'.length);
  if (path === '/sql' && req.method === 'POST') {
    const { sql, params = [] } = (await req.json()) as { sql: string; params?: unknown[] };
    if (!/^\s*(SELECT|WITH|PRAGMA\s+(table_info|index_list|foreign_key_check))/i.test(sql)) return json({ error: 'read-only' }, 400);
    try {
      const { results } = await env.DB.prepare(sql).bind(...params).all();
      return json({ rows: results });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }
  if (path === '/wipe' && req.method === 'POST') {
    await new D1Repository(env.DB).wipeAll();
    return json({ ok: true });
  }
  if (path === '/seed' && req.method === 'POST') {
    // Bulk seeding for the scale test: the SAME engine commands and repository as the HTTP routes
    // (LoyaltyService.execute → applyPurchase / reversePurchase / manualAdjust → saveOutcome with
    // client_stats), minus HTTP, auth and notifications — ~7× fewer D1 round trips per operation.
    const { ops } = (await req.json()) as { ops: Array<{ t: 'buy' | 'rev' | 'adj'; clientId: string; amount?: number; redeem?: boolean; purchaseId?: string; points?: number }> };
    const repo = new D1Repository(env.DB);
    const offset = await repo.getClockOffsetDays();
    const svc = new LoyaltyService(repo, { send: async () => undefined }, () => shiftedNow(offset), { maxRetries: 8 });
    const out: Array<{ ok: boolean; purchaseId?: string; error?: string }> = [];
    for (const op of ops) {
      try {
        if (op.t === 'buy') {
          const purchaseId = crypto.randomUUID();
          await svc.execute(op.clientId, ({ rules, state, now }) => {
            const lines = [{ category: 'flowers' as const, amount: op.amount! }];
            const redeemPoints = op.redeem ? maxRedeemable(rules, state, lines, null, now) : 0;
            return applyPurchase(rules, state, { purchaseId, idempotencyKey: `seed-${purchaseId}`, staffId: 'tg:900000101', lines, channel: 'store', redeemPoints, useRewardId: null }, now);
          }, { keys: [`seed-${purchaseId}`] });
          out.push({ ok: true, purchaseId });
        } else if (op.t === 'rev') {
          const res = await svc.execute(op.clientId, ({ rules, state, now }) => reversePurchase(rules, state, { purchaseId: op.purchaseId!, reason: 'Нагрузочный тест', staffId: 'tg:900000101' }, now), { purchaseId: op.purchaseId! });
          out.push({ ok: !res.outcome.replayed });
        } else {
          const k = `seed-adj-${crypto.randomUUID()}`;
          await svc.execute(op.clientId, ({ rules, state, now }) => manualAdjust(rules, state, { idempotencyKey: k, staffId: 'tg:900000100', amount: op.points!, reason: 'Нагрузка' }, now), { keys: [k] });
          out.push({ ok: true });
        }
      } catch (e) {
        out.push({ ok: false, error: String(e).slice(0, 200) });
      }
    }
    return json({ results: out });
  }
  if (path.startsWith('/req/')) {
    const c = byReq.get(decodeURIComponent(path.slice(5)));
    return c ? json(c) : json({ error: 'unknown request id' }, 404);
  }
  if (path === '/cron' && req.method === 'POST') {
    // { hour }: Tashkent hour of the simulated run (the job sends messages only 09:00–21:00); default 10.
    const body = (await req.json().catch(() => ({}))) as { hour?: number };
    const day = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
    const scheduledTime = Date.parse(`${day}T00:00:00+05:00`) + (body.hour ?? 10) * 3_600_000;
    const c = newCounter();
    const pending: Promise<unknown>[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
      origLog(...a);
    };
    const t0 = Date.now();
    currentFetchCounter = c;
    try {
      await worker.scheduled!(
        { cron: '0 * * * *', scheduledTime, noRetry() {} } as ScheduledController,
        { ...env, DB: countingDb(env.DB, c) },
        wrapCtx(ctx, pending),
      );
      await Promise.allSettled(pending);
    } finally {
      currentFetchCounter = null;
      console.log = origLog;
    }
    c.ms = Date.now() - t0;
    c.done = true;
    return json({ counter: c, logs });
  }
  return json({ error: 'unknown qa route' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__qa/')) return qaRoute(req, env, ctx);
    const id = req.headers.get('x-qa-req');
    const c = newCounter();
    const pending: Promise<unknown>[] = [];
    const t0 = Date.now();
    if (id) {
      remember(id, c);
      currentFetchCounter = c;
    }
    let res: Response;
    try {
      res = await worker.fetch!(req as any, { ...env, DB: countingDb(env.DB, c) }, wrapCtx(ctx, pending));
    } finally {
      // fetches after this point (waitUntil) are still attributed while no other request started
    }
    c.status = res.status;
    c.ms = Date.now() - t0;
    if (!id) return res;
    const finish = () => {
      void Promise.allSettled(pending).then(() => {
        c.done = true;
        if (currentFetchCounter === c) currentFetchCounter = null;
      });
    };
    const h = new Headers(res.headers);
    h.set('x-qa-d1-calls', String(c.calls));
    h.set('x-qa-d1-stmts', String(c.stmts));
    if (!res.body) {
      finish();
      return new Response(null, { status: res.status, headers: h });
    }
    // Keep counting while the body streams (CSV export reads D1 chunk by chunk).
    const { readable, writable } = new TransformStream({
      flush() {
        finish();
      },
    });
    void res.body.pipeTo(writable).catch(() => finish());
    return new Response(readable, { status: res.status, headers: h });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return worker.scheduled!(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
