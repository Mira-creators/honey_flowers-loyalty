import type { EditableRulesDTO } from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, localDateKey } from '@honey/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { runDailyJob } from '../src/cron.js';
import { nextCheckOn } from '../src/lib/expirySchedule.js';
import { buy, call, json, makeStaff, mockTelegram, moveClock, register, repo, resetDb, T, testEnv } from './helpers.js';

/**
 * R3: nightly job starvation. Every write stores the precise next reminder / expiry date
 * (clients.next_check_on) in its own batch; the job reads only next_check_on <= today, earliest
 * first; rules changes and clock moves recompute everybody in SQL.
 */

const OWNER = T + 1;
const FLORIST = T + 2;
const today = () => localDateKey(new Date(), 'Asia/Tashkent');
const plus = (day: string, n: number) => keyFromDayNumber(dayNumberFromKey(day) + n);

async function nextOf(clientId: string): Promise<string | null> {
  return (await testEnv.DB.prepare('SELECT next_check_on AS n FROM clients WHERE id = ?').bind(clientId).first<{ n: string | null }>())!.n;
}

/** The engine's value for every client (loads each state). */
async function engineSchedule(): Promise<Map<string, string | null>> {
  const r = repo();
  const ctx = await createContext(testEnv);
  const { rules } = await r.getActiveRules();
  const ids = await r.allClientIds();
  const out = new Map<string, string | null>();
  for (const id of ids) out.set(id, nextCheckOn(rules, (await r.loadClientState(id)).state, ctx.now()));
  return out;
}

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

describe('next_check_on is computed precisely on every write', () => {
  it('purchase → first reminder date; zero balance → NULL; after the reminder → the next one', async () => {
    const c = (await register(T + 10)).client!;
    expect(await nextOf(c.id)).toBeNull(); // no мёд, mode balance_only: nothing pending
    await buy(FLORIST, c.id, 200_000);
    // default rules: expires on day 90 after the purchase, reminders 14 / 7 / 1 days before
    expect(await nextOf(c.id)).toBe(plus(today(), 90 - 14));
    await moveClock(76);
    expect(await nextOf(c.id)).toBe(plus(today(), 90 - 14)); // the clock move recomputes: now due
    const res = await runDailyJob(await createContext(testEnv));
    expect(res.warned).toBe(1);
    expect(await nextOf(c.id)).toBe(plus(today(), 90 - 7));
  });

  it('a busy day of purchases does not starve the reminders that are due (no more NULL-first queue)', async () => {
    const due: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = (await register(T + 100 + i)).client!;
      await buy(FLORIST, c.id, 200_000);
      due.push(c.id);
    }
    await moveClock(76); // these 5 are due a 14-day reminder today
    // 60 other clients buy today: before the fix each of them was NULL = processed first, 40 per run.
    for (let i = 0; i < 60; i++) {
      const c = (await register(T + 200 + i)).client!;
      await buy(FLORIST, c.id, 150_000);
    }
    const res = await runDailyJob(await createContext(testEnv), 5);
    expect(res).toMatchObject({ checked: 5, warned: 5, more: false });
    for (const id of due) expect(await nextOf(id)).toBe(plus(today(), 90 - 7));
  });

  it('a rules change recomputes everybody in SQL, equal to the engine', async () => {
    for (let i = 0; i < 6; i++) {
      const c = (await register(T + 300 + i)).client!;
      if (i % 3) await buy(FLORIST, c.id, 100_000 * (i + 1));
      if (i === 4) await moveClock(20);
    }
    const before = await engineSchedule();
    for (const [id, v] of before) expect(await nextOf(id), id).toBe(v);
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    const r = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, expiryDays: 60, expiryWarnDays: [10, 3] } });
    expect(r.status).toBe(200);
    const after = await engineSchedule();
    expect([...after.values()].some((v, i) => v !== [...before.values()][i])).toBe(true);
    for (const [id, v] of after) expect(await nextOf(id), id).toBe(v);
  });
});
