import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, key, makeStaff, mockTelegram, register, resetDb, T, testEnv } from './helpers.js';

/**
 * L3: under contention (several staff on one client at once) the service re-runs a conflicting
 * command with full-jitter exponential backoff (5 retries), so staff rarely see «повторите» (409).
 */
const FLORISTS = [T + 2, T + 3, T + 4, T + 5];
let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  for (const f of FLORISTS) await makeStaff(f, 'florist');
});
afterEach(() => tg.restore());

describe('L3: fewer 409 under contention', () => {
  it('20 parallel purchases on one client: (almost) all succeed, none lost, none doubled', async () => {
    const c = (await register(T + 50)).client!;
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call('/api/staff/purchase', { user: FLORISTS[i % 4]!, body: { clientId: c.id, amount: 50_000 + i, redeem: false, idempotencyKey: key() } })),
    );
    const ok = rs.filter((r) => r.status === 201).length;
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(ok).toBeGreaterThanOrEqual(19);
    const n = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE client_id = ?').bind(c.id).first<{ n: number }>();
    expect(n!.n).toBe(ok);
  });
});
