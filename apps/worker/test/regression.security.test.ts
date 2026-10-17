import type { HistoryItemDTO, MeDTO, StaffClientLookupDTO, StaffDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { D1Repository } from '../src/db/d1Repository.js';
import type { Env } from '../src/env.js';
import {
  buy,
  call,
  contactUpdate,
  execCtx,
  json,
  key,
  makeStaff,
  messageUpdate,
  mockTelegram,
  moveClock,
  register,
  repo,
  resetDb,
  setRole,
  T,
  TEST_KEY,
  testEnv,
  tmaHeader,
  webhook,
} from './helpers.js';

/**
 * Regression tests for the Worker audit findings W1–W13 (apps/worker). Every test
 * here reproduced a real bug before the fix; keep them green.
 */

const REAL_CLIENT = 5551234; // a real Telegram user (registered through the bot)
const REAL_OWNER = 4440001;
const STRANGER = T + 1; // browser tester / anyone with curl
const FLORIST = T + 1001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

async function callEnv(env: Env, path: string, opts: { headers?: Record<string, string>; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const { ctx, flush } = execCtx();
  const res = await app.request(
    path,
    { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
    env,
    ctx,
  );
  await flush();
  return res;
}

describe('W1: X-Test-User cannot impersonate real Telegram users', () => {
  it('needs X-Test-Key = TEST_KEY and an id >= 900 000 000; real ids are rejected', async () => {
    await webhook(contactUpdate(REAL_CLIENT, '+998 90 555 12 34'));
    // Real client id with the right key: refused.
    const r1 = await call('/api/me', { user: REAL_CLIENT });
    expect(r1.status).toBe(401);
    // Tester id without the key / with a wrong key: refused.
    expect((await call('/api/me', { user: STRANGER, headers: { 'x-test-key': '' } })).status).toBe(401);
    expect((await call('/api/me', { user: STRANGER, headers: { 'x-test-key': 'nope' } })).status).toBe(401);
    // Tester id with the key: ok.
    expect((await call('/api/me', { user: STRANGER })).status).toBe(200);
    // TEST_KEY unset on the server: browser testing is off entirely.
    const noKey = { ...testEnv, TEST_KEY: undefined } as Env;
    expect((await callEnv(noKey, '/api/me', { headers: { 'x-test-user': String(STRANGER), 'x-test-key': TEST_KEY } })).status).toBe(401);
    // Real users keep working through initData, incl. role switching in TEST_MODE.
    expect((await call('/api/me', { headers: await tmaHeader(REAL_CLIENT) })).status).toBe(200);
    await call('/api/test/role', { headers: await tmaHeader(REAL_CLIENT), body: { role: 'owner' } });
    expect((await json<MeDTO>(call('/api/me', { headers: await tmaHeader(REAL_CLIENT) }))).role).toBe('owner');
  });

  it('a tester cannot take a staff member phone, and never binds a staff row', async () => {
    await call('/setup?key=test-setup-key&owner=%2B998901110000');
    const res = await call('/api/test/register', { user: STRANGER, body: { phone: '+998901110000', name: 'Stranger' } });
    expect(res.status).toBe(403);
    expect(await repo().findStaffByTelegramId(STRANGER)).toBeNull();
    // The real owner can still register that phone through the bot and becomes owner.
    await webhook(contactUpdate(REAL_OWNER, '+998901110000'));
    expect((await repo().findStaffByTelegramId(REAL_OWNER))?.role).toBe('owner');
  });

  it('X-Test-User is ignored for every TEST_MODE spelling other than "1"/"true"', async () => {
    for (const v of ['0', '0 ', 'false', 'TRUE', ' 1', '']) {
      const r = await callEnv({ ...testEnv, TEST_MODE: v } as Env, '/api/me', { headers: { 'x-test-user': String(STRANGER), 'x-test-key': TEST_KEY } });
      expect(r.status, `TEST_MODE=${JSON.stringify(v)}`).toBe(401);
    }
  });
});

describe('W6/W7: staff management', () => {
  const prodEnv = () => ({ ...testEnv, TEST_MODE: '0' }) as Env;

  it('W6: the last owner cannot demote themselves via POST /api/owner/staff', async () => {
    await makeStaff(REAL_OWNER, 'owner', 'Владелец');
    const h = await tmaHeader(REAL_OWNER);
    const res = await callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: `id:${REAL_OWNER}`, role: 'florist' } });
    expect(res.status).toBe(409);
    expect(await repo().countActiveOwners()).toBe(1);
    // With a second owner the demotion is allowed.
    await makeStaff(REAL_OWNER + 1, 'owner', 'Второй');
    expect((await callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: `id:${REAL_OWNER}`, role: 'florist' } })).status).toBe(201);
  });

  it('W7: a bare 9-digit number is refused as ambiguous; id:… and +998… are explicit', async () => {
    await makeStaff(REAL_OWNER, 'owner', 'Владелец');
    const h = await tmaHeader(REAL_OWNER);
    const amb = await callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: '123456789', role: 'florist' } });
    expect(amb.status).toBe(400);
    expect((await json(amb)).error.message).toMatch(/id:123456789/);
    const byId = await json<StaffDTO>(callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: 'id:123456789', role: 'florist' } }));
    expect(byId.telegramId).toBe(123456789);
    expect((await json<MeDTO>(callEnv(prodEnv(), '/api/me', { headers: await tmaHeader(123456789) }))).role).toBe('florist');
    const byPhone = await json<StaffDTO>(callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: '998901234567', role: 'florist' } }));
    expect(byPhone.telegramId).toBeNull();
    expect((await repo().findStaffById(byPhone.id))?.phone).toBe('+998901234567');
  });

  it('W13: staff pre-added by phone merges into an existing staff row of the same Telegram account (no orphan)', async () => {
    await makeStaff(REAL_OWNER, 'owner', 'Владелец');
    await makeStaff(7001, 'florist', 'Флорист');
    const h = await tmaHeader(REAL_OWNER);
    await callEnv(prodEnv(), '/api/owner/staff', { headers: h, body: { phoneOrTelegramId: '+998 93 777 66 55', role: 'manager' } });
    await webhook(contactUpdate(7001, '+998937776655'));
    const rows = (await repo().listStaff()).filter((s) => s.telegramId === 7001 || s.phone === '+998937776655');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ telegramId: 7001, phone: '+998937776655', role: 'manager', active: true });
  });
});

describe('W8/W9/W10/W12: DTO, clock, amounts, session', () => {
  it('W8: expiresOn is the last valid day; the balance is still there on that day', async () => {
    await makeStaff(FLORIST, 'florist');
    const me = await register(STRANGER + 5);
    await buy(FLORIST, me.client!.id, 500_000);
    const before = await json<MeDTO>(call('/api/me', { user: STRANGER + 5 }));
    expect(before.client!.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(before.client!.expiresAt!) - Date.parse(`${before.client!.expiresOn}T00:00:00+05:00`)).toBe(86_400_000);
    await moveClock(89);
    const onLastDay = await json<MeDTO>(call('/api/me', { user: STRANGER + 5 }));
    expect(new Date(onLastDay.now).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' })).toBe(before.client!.expiresOn);
    expect(onLastDay.client!.balance).toBe(5_000);
    await moveClock(1);
    expect((await json<MeDTO>(call('/api/me', { user: STRANGER + 5 }))).client!.balance).toBe(0);
  });

  it('W9: the cumulative clock offset is capped; reset works whatever is stored', async () => {
    expect((await call('/api/test/clock', { user: STRANGER, body: { days: 3650 } })).status).toBe(200);
    expect((await call('/api/test/clock', { user: STRANGER, body: { days: 1 } })).status).toBe(400);
    await repo().setSetting('clock_offset_days', '100000000');
    expect((await call('/api/me', { user: STRANGER })).status).toBe(200);
    const reset = await json<MeDTO>(call('/api/test/clock', { user: STRANGER, body: { reset: true } }));
    expect(reset.clockOffsetDays).toBe(0);
  });

  it('W10: a purchase above rules.maxPurchaseAmount is a 400 (preview and purchase)', async () => {
    await makeStaff(FLORIST, 'florist');
    const me = await register(STRANGER + 6);
    const { rules } = await repo().getActiveRules();
    const body = { clientId: me.client!.id, amount: rules.maxPurchaseAmount + 1, redeem: false };
    const p = await call('/api/staff/purchase/preview', { user: FLORIST, body });
    expect(p.status).toBe(400);
    expect((await json(p)).error.message).toMatch(/не может превышать/);
    expect((await call('/api/staff/purchase', { user: FLORIST, body: { ...body, idempotencyKey: key() } })).status).toBe(400);
    expect((await call('/api/staff/purchase', { user: FLORIST, body: { ...body, amount: rules.maxPurchaseAmount, idempotencyKey: key() } })).status).toBe(201);
  });

  it('W12: stale initData answers 401 with code "expired"', async () => {
    const stale = await call('/api/me', { headers: await tmaHeader(REAL_CLIENT, {}, new Date(Date.now() - 2 * 86_400_000)) });
    expect(stale.status).toBe(401);
    expect(await json(stale)).toEqual({ error: { code: 'expired', message: expect.stringMatching(/заново/) } });
  });

  it('lookup by client id (UUID) returns the client; history carries cashback separately from the signed net', async () => {
    await makeStaff(FLORIST, 'florist');
    const me = await register(STRANGER + 7);
    const id = me.client!.id;
    await buy(FLORIST, id, 2_000_000); // +20 000
    await moveClock(1);
    await buy(FLORIST, id, 100_000, { redeem: true }); // -20 000 redeemed (capped 50% = 50 000 > balance) +cashback on 80 000
    const look = await json<StaffClientLookupDTO>(call(`/api/staff/client?q=${encodeURIComponent(id)}`, { user: FLORIST }));
    expect(look.client?.id).toBe(id);
    const last = look.client!.history.find((h) => h.kind === 'purchase' && h.redeemed)! as HistoryItemDTO;
    expect(last.cashback).toBeGreaterThanOrEqual(0);
    expect(last.points).toBe(last.cashback! - last.redeemed!);
    expect(last.points).toBeLessThan(0);
    expect((await call('/api/staff/client?q=00000000-0000-4000-8000-000000000000', { user: FLORIST })).status).toBe(200);
    expect((await json<StaffClientLookupDTO>(call('/api/staff/client?q=00000000-0000-4000-8000-000000000000', { user: FLORIST }))).client).toBeNull();
  });
});

describe('W11/W13: bot', () => {
  it('W11: commands and contacts in groups are ignored, nothing is sent to the group', async () => {
    await webhook(contactUpdate(REAL_CLIENT, '+998905551234'));
    tg.calls.length = 0;
    const GROUP = -100123456;
    const inGroup = (extra: Record<string, unknown>) => ({
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: GROUP, type: 'supergroup', title: 'Цветы чат' },
        from: { id: REAL_CLIENT, is_bot: false, first_name: 'Амалия' },
        ...extra,
      },
    });
    expect((await webhook(inGroup({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }))).status).toBe(200);
    expect((await webhook(inGroup({ text: '/card', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }))).status).toBe(200);
    expect((await webhook(inGroup({ contact: { phone_number: '+998901112233', first_name: 'X', user_id: REAL_CLIENT } }))).status).toBe(200);
    expect(tg.sent()).toHaveLength(0);
    expect((await repo().findClientByTelegramId(REAL_CLIENT))?.phone).toBe('+998905551234');
  });

  it('W13: a phone race (UNIQUE violation) is answered with the "phone taken" text', async () => {
    // Simulate the race: the pre-check passes, the insert hits the unique index.
    const r = repo();
    const real = r.searchClientsByPhone.bind(r);
    const orig = D1Repository.prototype.searchClientsByPhone;
    D1Repository.prototype.searchClientsByPhone = async function (this: D1Repository, digits: string, limit: number) {
      const res = await real(digits, limit);
      return res.filter((c) => c.telegramId !== REAL_CLIENT); // hide the first registrant from the pre-check
    };
    try {
      await webhook(contactUpdate(REAL_CLIENT, '+998901112233'));
      await webhook(contactUpdate(REAL_CLIENT + 1, '+998901112233'));
    } finally {
      D1Repository.prototype.searchClientsByPhone = orig;
    }
    expect(await r.findClientByTelegramId(REAL_CLIENT + 1)).toBeNull();
    expect(String(tg.sent().at(-1)!.payload.text)).toMatch(/уже привязан/);
  });

  it('contact without user_id (phonebook card) is refused; local and foreign formats normalize', async () => {
    await webhook(messageUpdate(REAL_CLIENT, { contact: { phone_number: '+998905551234', first_name: 'X' } }));
    expect(await repo().findClientByTelegramId(REAL_CLIENT)).toBeNull();
    const cases: Array<[string, string]> = [
      ['998901234501', '+998901234501'],
      ['+998 (90) 123-45-02', '+998901234502'],
      ['8 90 123 45 03', '+998901234503'],
      ['79991234504', '+79991234504'],
    ];
    let id = 7000;
    for (const [raw, want] of cases) {
      await webhook(contactUpdate(++id, raw));
      expect((await repo().findClientByTelegramId(id))?.phone, raw).toBe(want);
    }
  });
});

describe('role matrix with TEST_MODE=0', () => {
  it('a client gets 403 on every staff/owner route and 404 on every test route', async () => {
    await webhook(contactUpdate(REAL_CLIENT, '+998905551234'));
    const h = await tmaHeader(REAL_CLIENT);
    const env = { ...testEnv, TEST_MODE: '0' } as Env;
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/api/staff/client?q=1234', undefined],
      ['POST', '/api/staff/purchase/preview', { clientId: 'x', amount: 1 }],
      ['POST', '/api/staff/purchase', { clientId: 'x', amount: 1, idempotencyKey: 'abcdefgh' }],
      ['POST', '/api/staff/purchase/x/reverse', { reason: 'xxxx' }],
      ['POST', '/api/staff/gift/x/use', {}],
      ['GET', '/api/staff/recent', undefined],
      ['GET', '/api/owner/stats', undefined],
      ['GET', '/api/owner/rules', undefined],
      ['PUT', '/api/owner/rules', {}],
      ['GET', '/api/owner/staff', undefined],
      ['POST', '/api/owner/staff', {}],
      ['DELETE', '/api/owner/staff/x', undefined],
      ['GET', '/api/owner/operations', undefined],
      ['POST', '/api/test/role', { role: 'owner' }],
      ['POST', '/api/test/clock', { days: 1 }],
      ['POST', '/api/test/run-expiry', {}],
      ['POST', '/api/test/reset-me', {}],
      ['POST', '/api/test/register', { phone: '+998901234567', name: 'x' }],
    ];
    for (const [method, path, body] of routes) {
      const r = await callEnv(env, path, { headers: h, method, body });
      expect(r.status, `${method} ${path}`).toBe(path.includes('/api/test/') ? 404 : 403);
    }
    await setRole(STRANGER, 'owner'); // test_roles rows are ignored outside TEST_MODE
    expect((await callEnv(env, '/api/me', { headers: { 'x-test-user': String(STRANGER), 'x-test-key': TEST_KEY } })).status).toBe(401);
  });
});
