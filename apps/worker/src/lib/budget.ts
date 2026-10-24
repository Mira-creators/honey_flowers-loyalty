/**
 * Subrequest budget of one invocation (Workers Free: 50 subrequests = D1 round trips + fetch).
 * The daily job wraps env.DB with `countingD1` and asks `left()` before optional work (fallback
 * writes, Telegram sends), so a run never exceeds `limit` (45 by default: 5 spare).
 */
export class SubrequestBudget {
  used = 0;
  constructor(readonly limit = 45) {}
  left(): number {
    return this.limit - this.used;
  }
  spend(n = 1): void {
    this.used += n;
  }
}

/** env.DB proxy that charges every round trip (statement run/all/first/raw, batch) to the budget. */
export function countingD1(db: D1Database, budget: SubrequestBudget): D1Database {
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        if (p === 'bind') return (...a: unknown[]) => wrap(t.bind(...a));
        if (p === 'run' || p === 'all' || p === 'first' || p === 'raw') {
          return (...a: unknown[]) => {
            budget.spend();
            return (t as any)[p](...a);
          };
        }
        if (p === '__inner') return t;
        const v = (t as any)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (p === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          budget.spend();
          return t.batch(stmts.map((s) => ((s as any).__inner ?? s) as D1PreparedStatement));
        };
      }
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
