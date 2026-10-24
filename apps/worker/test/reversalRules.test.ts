import type { EditableRulesDTO, MeDTO, OperationDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buy, call, json, makeStaff, mockTelegram, moveClock, register, resetDb, T, testEnv } from './helpers.js';

/**
 * Item 8 (owner decision): «Отменить покупку» is a staff-only correction of a mistake at the till.
 * Refused (409, Russian) after reversalWindowHours (default 24), when the purchase's мёд was spent,
 * or when its gift was used; a reversal never leaves a negative balance or a gift earned twice.
 */

const OWNER = T + 1;
const FLORIST = T + 2;
const CLIENT = T + 10;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

const reverse = (purchaseId: string, user = FLORIST) => call(`/api/staff/purchase/${purchaseId}/reverse`, { user, body: { reason: 'ошибка кассы' } });
const balance = async () => (await json<MeDTO>(call('/api/me', { user: CLIENT }))).client!.balance;
const recent = () => json<OperationDTO[]>(call('/api/staff/recent', { user: FLORIST }));

describe('reversal rules', () => {
  it('only staff; within the window it works (redemption is returned too)', async () => {
    const c = (await register(CLIENT)).client!;
    const p = await buy(FLORIST, c.id, 500_000);
    expect((await reverse(p.purchaseId, CLIENT)).status).toBe(403); // a client cannot reverse
    const ops = await recent();
    expect(ops.find((o) => o.purchaseId === p.purchaseId)).toMatchObject({ reversible: true });
    expect((await reverse(p.purchaseId)).status).toBe(200);
    expect(await balance()).toBe(0);
  });

  it('refused after the window (409, «в течение 24 ч»), button hidden with the reason', async () => {
    const c = (await register(CLIENT)).client!;
    const p = await buy(FLORIST, c.id, 500_000);
    await moveClock(1); // 24 h and a few ms later
    const r = await reverse(p.purchaseId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.message).toMatch(/Отмена возможна только в течение 24 ч после покупки/);
    expect(await balance()).toBe(5000);
    const op = (await recent()).find((o) => o.purchaseId === p.purchaseId)!;
    expect(op.reversible).toBe(false);
    expect(op.reverseBlocked).toMatch(/24 ч/);
  });

  it('refused when its мёд was spent: never a negative balance («Скорректировать мёд»)', async () => {
    const c = (await register(CLIENT)).client!;
    const p1 = await buy(FLORIST, c.id, 1_000_000); // +10 000
    const p2 = await buy(FLORIST, c.id, 100_000, { redeem: true }); // pays 10 000 with мёд, earns 900
    expect(await balance()).toBe(900);
    const r = await reverse(p1.purchaseId); // would leave 900 − 10 000 < 0
    expect(r.status).toBe(409);
    expect((await json(r)).error.message).toMatch(/Мёд с этой покупки уже потрачен — отменить нельзя.*Скорректировать мёд/);
    expect(await balance()).toBe(900);
    expect((await recent()).find((o) => o.purchaseId === p1.purchaseId)).toMatchObject({ reversible: false });
    // the redemption itself may be reversed: it returns мёд
    expect((await reverse(p2.purchaseId)).status).toBe(200);
    expect(await balance()).toBe(10_000);
    expect((await reverse(p1.purchaseId)).status).toBe(200); // now its мёд is back: allowed
    expect(await balance()).toBe(0);
  });

  it('refused when the gift of the purchase was used (no gift earned twice)', async () => {
    const c = (await register(CLIENT)).client!;
    // same day: allow 2 cells per day so three purchases reach the cell-3 gift within the window
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    expect((await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, maxCellsPerDay: 5 } })).status).toBe(200);
    await buy(FLORIST, c.id, 150_000);
    await buy(FLORIST, c.id, 150_000);
    const p3 = await buy(FLORIST, c.id, 150_000);
    const gift = p3.giftsUnlocked[0]!;
    expect((await call(`/api/staff/gift/${gift.id}/use`, { user: FLORIST, body: {} })).status).toBe(200);
    const r = await reverse(p3.purchaseId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.message).toMatch(/Подарок за эту покупку уже использован — отменить нельзя/);
    expect((await recent()).find((o) => o.purchaseId === p3.purchaseId)).toMatchObject({ reversible: false });
    const st = await testEnv.DB.prepare(`SELECT status FROM purchases WHERE id = ?`).bind(p3.purchaseId).first<{ status: string }>();
    expect(st!.status).toBe('active');
  });

  it('the window is an owner rule (1..720 h), stored as a new rules version', async () => {
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    expect(rules.reversalWindowHours).toBe(24);
    for (const bad of [0, 721, 1.5]) {
      const r = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, reversalWindowHours: bad } });
      expect(r.status, String(bad)).toBe(400);
    }
    const ok = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, reversalWindowHours: 2 } }));
    expect(ok.reversalWindowHours).toBe(2);
    const c = (await register(CLIENT)).client!;
    const p = await buy(FLORIST, c.id, 300_000);
    await moveClock(1);
    expect((await json(await reverse(p.purchaseId))).error.message).toMatch(/в течение 2 ч/);
  });
});
