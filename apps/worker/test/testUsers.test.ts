import type { MeDTO, WebSessionDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import type { Env } from '../src/env.js';
import { isClientDeployment, parseTestUsers, testPolicy } from '../src/lib/testAccess.js';
import { exchange, tokenOf } from './consoleHelpers.js';
import { contactUpdate, execCtx, json, mockTelegram, repo, resetDb, T, TEST_KEY, testEnv, tmaHeader, webhook } from './helpers.js';

/**
 * R1: TEST_MODE privilege escalation. With TEST_MODE=1 any Telegram user could POST /api/test/role
 * {role:'owner'}. Now the test features belong to TEST_USERS only (lib/testAccess.ts); the client
 * worker fails closed when TEST_USERS is empty.
 */

const OWNER_TG = 4_440_001; // listed by id
const PHONE_TESTER_TG = 4_440_002; // listed by phone (shared through the bot)
const PHONE = '+998901112233';
const STRANGER_TG = 5_551_234; // a real Telegram user, not listed
const BROWSER_OK = T + 77; // browser tester listed by id
const BROWSER_NO = T + 78;

const listed = (extra: Partial<Env> = {}) => ({ ...testEnv, TEST_MODE: '1', TEST_USERS: `${OWNER_TG}, ${PHONE}, ${BROWSER_OK}`, ...extra }) as Env;
const clientWorker = (extra: Partial<Env> = {}) =>
  ({ ...testEnv, TEST_MODE: '1', TEST_USERS: '', DEPLOY_ENV: 'client', ENV_NAME: 'honeyflowers (main)', ...extra }) as Env;

async function req(env: Env, path: string, opts: { headers?: Record<string, string>; body?: unknown; method?: string } = {}) {
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
const browser = (id: number) => ({ 'x-test-user': String(id), 'x-test-key': TEST_KEY });

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

describe('TEST_USERS policy (lib/testAccess.ts)', () => {
  it('parses ids and +998 phones, ignores junk', () => {
    const p = parseTestUsers(' 123456789, +998 90 111-22-33 ; id:42, abc, +1');
    expect([...p.ids].sort((a, b) => a - b)).toEqual([42, 123456789]);
    expect([...p.phones]).toEqual(['+998901112233']);
    expect(p.invalid).toEqual(['abc', '+1']);
  });

  it('modes: off without TEST_MODE, listed with TEST_USERS, everyone on the polygon, off on the client worker', () => {
    expect(testPolicy({ ...testEnv, TEST_MODE: '0', TEST_USERS: '1' } as Env).mode).toBe('off');
    expect(testPolicy(listed()).mode).toBe('listed');
    expect(testPolicy({ ...testEnv, TEST_MODE: '1', TEST_USERS: '', DEPLOY_ENV: 'dev' } as Env).mode).toBe('everyone');
    expect(testPolicy(clientWorker()).mode).toBe('off');
    // the client worker is recognised by DEPLOY_ENV or by the ENV_NAME select-env writes
    expect(isClientDeployment({ ...testEnv, DEPLOY_ENV: undefined, ENV_NAME: 'honeyflowers (main)' } as Env)).toBe(true);
    expect(isClientDeployment({ ...testEnv, DEPLOY_ENV: 'dev', ENV_NAME: 'honey-loyalty (dev)' } as Env)).toBe(false);
    // a TEST_USERS typo never opens the features to everyone
    const typo = testPolicy({ ...testEnv, TEST_MODE: '1', TEST_USERS: 'oops' } as Env);
    expect(typo.mode).toBe('listed');
    expect(typo.ids.size + typo.phones.size).toBe(0);
  });
});

describe('TEST_MODE=1 with TEST_USERS: everyone else behaves as in production', () => {
  it('a real Telegram user who is not listed cannot switch to owner, has no test panel, no clock', async () => {
    const env = listed();
    const h = await tmaHeader(STRANGER_TG);
    const role = await req(env, '/api/test/role', { headers: h, body: { role: 'owner' } });
    expect(role.status).toBe(404);
    for (const p of ['/api/test/clock', '/api/test/run-expiry', '/api/test/demo-seed', '/api/test/demo-clear', '/api/test/reset-me', '/api/test/register']) {
      expect((await req(env, p, { headers: h, body: { days: 30, chunk: 0, phone: '+998901234500', name: 'x' } })).status, p).toBe(404);
    }
    const me = await json<MeDTO>(req(env, '/api/me', { headers: h }));
    expect(me.role).toBe('client');
    expect(me.testMode).toBe(false); // the Mini App hides «🧪 Тест»
    expect((await req(env, '/api/owner/stats', { headers: h })).status).toBe(403);
  });

  it('a test role stored earlier (when everyone could test) is ignored for a non-listed user', async () => {
    await repo().setTestRole(STRANGER_TG, 'owner', new Date());
    const h = await tmaHeader(STRANGER_TG);
    expect((await json<MeDTO>(req(listed(), '/api/me', { headers: h }))).role).toBe('client');
    expect((await req(listed(), '/api/owner/stats', { headers: h })).status).toBe(403);
    // the same row still works on the polygon where everyone is a tester
    expect((await json<MeDTO>(req({ ...testEnv, TEST_USERS: '' } as Env, '/api/me', { headers: h }))).role).toBe('owner');
  });

  it('a listed Telegram id gets the test panel and can switch roles', async () => {
    const h = await tmaHeader(OWNER_TG);
    const r = await req(listed(), '/api/test/role', { headers: h, body: { role: 'owner' } });
    expect(r.status).toBe(200);
    const me = await json<MeDTO>(r);
    expect(me.role).toBe('owner');
    expect(me.testMode).toBe(true);
    expect((await req(listed(), '/api/owner/stats', { headers: h })).status).toBe(200);
  });

  it('a phone in TEST_USERS counts once the person shared it with the bot', async () => {
    const h = await tmaHeader(PHONE_TESTER_TG);
    expect((await req(listed(), '/api/test/role', { headers: h, body: { role: 'florist' } })).status).toBe(404);
    // shares the contact in the bot (Telegram vouches for the number)
    expect((await webhook(contactUpdate(PHONE_TESTER_TG, PHONE))).status).toBe(200);
    expect((await repo().findClientByTelegramId(PHONE_TESTER_TG))?.phone).toBe(PHONE);
    const r = await req(listed(), '/api/test/role', { headers: h, body: { role: 'florist' } });
    expect(r.status).toBe(200);
    expect((await json<MeDTO>(r)).testMode).toBe(true);
  });

  it('X-Test-Key browser login needs the tester id in TEST_USERS', async () => {
    const no = await req(listed(), '/api/me', { headers: browser(BROWSER_NO) });
    expect(no.status).toBe(401);
    expect((await json(no)).error.message).toMatch(/TEST_USERS/);
    const ok = await req(listed(), '/api/me', { headers: browser(BROWSER_OK) });
    expect(ok.status).toBe(200);
    expect((await json<MeDTO>(ok)).testMode).toBe(true);
  });

  it('own-card exemption and «remove the last owner» are tester-only', async () => {
    // A real owner (not a tester) cannot deactivate himself even though TEST_MODE=1.
    const member = await repo().upsertStaff({ telegramId: STRANGER_TG, phone: null, name: 'Хозяйка', role: 'owner' }, new Date());
    const h = await tmaHeader(STRANGER_TG);
    const del = await req(listed(), `/api/owner/staff/${member.id}`, { headers: h, method: 'DELETE' });
    expect(del.status).toBe(409);
  });

  it('owner console: a stored test role does not make a non-listed user an owner', async () => {
    await repo().setTestRole(STRANGER_TG, 'owner', new Date());
    // A web link can only be created by an owner; forge the token row directly to probe the exchange.
    const { createLinkToken } = await import('../src/console/webAuth.js');
    const { token } = await createLinkToken(testEnv.DB, STRANGER_TG, Date.now());
    const res = await exchange(token, listed());
    expect(res.status).toBe(403);
    // a listed owner-by-test-role gets the session
    await repo().setTestRole(OWNER_TG, 'owner', new Date());
    const link = await createLinkToken(testEnv.DB, OWNER_TG, Date.now());
    const ok = await exchange(link.token, listed());
    expect(ok.status).toBe(201);
    expect((await json<WebSessionDTO>(ok)).session).toBeTruthy();
    void tokenOf;
  });
});

describe('client worker (branch main) with TEST_MODE=1 and empty TEST_USERS: fail closed', () => {
  it('no test routes, no browser login, no test clock, /health says testMode=false', async () => {
    const env = clientWorker();
    const h = await tmaHeader(STRANGER_TG);
    expect((await req(env, '/api/test/role', { headers: h, body: { role: 'owner' } })).status).toBe(404);
    expect((await req(env, '/api/me', { headers: browser(BROWSER_OK) })).status).toBe(401);
    await repo().setClockOffsetDays(30);
    const me = await json<MeDTO>(req(env, '/api/me', { headers: h }));
    expect(me.testMode).toBe(false);
    expect(me.clockOffsetDays).toBe(0);
    expect(Math.abs(Date.parse(me.now) - Date.now())).toBeLessThan(60_000);
    const health = await json(req(env, '/health'));
    expect(health.testMode).toBe(false);
    expect(health.testUsers).toBe('off');
  });

  it('TEST_USERS set on the client worker → only they test', async () => {
    const env = clientWorker({ TEST_USERS: String(OWNER_TG) });
    expect((await req(env, '/api/test/role', { headers: await tmaHeader(OWNER_TG), body: { role: 'owner' } })).status).toBe(200);
    expect((await req(env, '/api/test/role', { headers: await tmaHeader(STRANGER_TG), body: { role: 'owner' } })).status).toBe(404);
    expect((await json(req(env, '/health'))).testUsers).toBe('listed');
  });
});
