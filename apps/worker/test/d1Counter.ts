import type { Env } from '../src/env.js';
import { testEnv } from './helpers.js';

/** Test helper: counts every D1 round trip (statement .run/.first/.all/.raw and db.batch) and rows read/written. */
export function countingEnv(base: Env = testEnv, extra: Partial<Env> = {}) {
  const c = { calls: 0, batches: 0, stmts: 0, rowsRead: 0, rowsWritten: 0, log: [] as string[] };
  const db = base.DB;
  const addMeta = (m: { rows_read?: number; rows_written?: number } | undefined) => {
    if (!m) return;
    c.rowsRead += m.rows_read ?? 0;
    c.rowsWritten += m.rows_written ?? 0;
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const ob = s.bind.bind(s);
    (s as any).bind = (...a: unknown[]) => wrap(ob(...a), sql);
    for (const m of ['run', 'all', 'raw'] as const) {
      const orig = (s as any)[m].bind(s);
      (s as any)[m] = async (...a: unknown[]) => {
        c.calls++;
        c.stmts++;
        c.log.push(sql.replace(/\s+/g, ' ').slice(0, 70));
        const r = await orig(...a);
        addMeta((r as any)?.meta);
        return r;
      };
    }
    const of = (s as any).first.bind(s);
    (s as any).first = async (...a: unknown[]) => {
      c.calls++;
      c.stmts++;
      c.log.push(sql.replace(/\s+/g, ' ').slice(0, 70));
      // first() hides meta: re-run as all() just to read meta is not worth it; count call only
      return of(...a);
    };
    return s;
  };
  const proxy = new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
      if (p === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          c.calls++;
          c.batches++;
          c.stmts += stmts.length;
          c.log.push(`BATCH(${stmts.length})`);
          const r = await t.batch(stmts);
          for (const x of r) addMeta((x as any).meta);
          return r;
        };
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { env: { ...base, ...extra, DB: proxy } as Env, c };
}
