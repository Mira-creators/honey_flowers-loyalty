// Production-like mode: the Worker restarted with TEST_MODE=0 (same database). Only signed Telegram
// initData authenticates; /api/test/* is gone; owner protections (last owner, self-removal) apply.
import { ctx, req, wipe } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { tma } from '../lib/tma.mjs';
import { restartWorker, SETUP_KEY, telegram, TEST_KEY, WEBHOOK_SECRET } from '../lib/worker.mjs';

const OWNER = 5_000_001, FLORIST = 5_000_002, CLIENT = 5_000_003, OWNER2 = 5_000_004;

const call = async (user, method, path, body, extraHeaders = {}) =>
  req(null, method, path, { body, headers: { ...(user ? await tma(user) : {}), ...extraHeaders } });

/** TEST_MODE=1 + TEST_USERS (lib/testAccess.ts): only listed users get the test features. */
async function testUsersChecks(s) {
  const r1 = area('test users (R1)');
  const LISTED = CLIENT + 200, STRANGER = CLIENT + 100, BROWSER_OK = 900_000_501, BROWSER_NO = 900_000_502;
  try {
    ctx.base = await restartWorker({ testMode: '1', testUsers: `${LISTED}, ${BROWSER_OK}` });
    const esc = await req(null, 'POST', '/api/test/role', { body: { role: 'owner' }, headers: await tma(STRANGER) });
    const escMe = await req(null, 'GET', '/api/owner/stats', { headers: await tma(STRANGER) });
    r1.check('TEST_USERS set: a real Telegram client cannot make himself owner', esc.status === 404 && escMe.status === 403, `role ${esc.status}, owner stats ${escMe.status}`);
    area('open risks').check('TEST_MODE=1: a real Telegram client cannot make himself owner', !(esc.status === 200 && escMe.status === 200), `role ${esc.status}, owner stats ${escMe.status}`);
    for (const p of ['/api/test/clock', '/api/test/run-expiry', '/api/test/demo-seed', '/api/test/demo-clear', '/api/test/reset-me', '/api/test/register']) {
      r1.eq(`non-listed user: ${p} → 404`, (await req(null, 'POST', p, { body: { days: 30, chunk: 0 }, headers: await tma(STRANGER) })).status, 404);
    }
    r1.eq('non-listed user: /api/me testMode=false (no «🧪 Тест»)', (await req(null, 'GET', '/api/me', { headers: await tma(STRANGER) })).body?.testMode, false);
    const ok = await req(null, 'POST', '/api/test/role', { body: { role: 'owner' }, headers: await tma(LISTED) });
    r1.eq('listed user switches to owner', [ok.status, ok.body?.role, ok.body?.testMode], [200, 'owner', true]);
    r1.eq('browser tester not in TEST_USERS → 401', (await req(BROWSER_NO, 'GET', '/api/me')).status, 401);
    r1.eq('browser tester in TEST_USERS → 200', (await req(BROWSER_OK, 'GET', '/api/me')).status, 200);
    ctx.base = await restartWorker({ testMode: '1', testUsers: '', deployEnv: 'client' });
    const health = await req(null, 'GET', '/health', { allowNonJsonError: true });
    r1.eq('client worker, TEST_USERS empty: /health testMode=false (fail closed)', [health.body?.testMode, health.body?.testUsers], [false, 'off']);
    r1.eq('client worker, TEST_USERS empty: /api/test/role → 404', (await req(null, 'POST', '/api/test/role', { body: { role: 'owner' }, headers: await tma(LISTED) })).status, 404);
    r1.eq('client worker, TEST_USERS empty: X-Test-User → 401', (await req(BROWSER_OK, 'GET', '/api/me')).status, 401);
  } finally {
    ctx.base = await restartWorker({ testMode: '1' });
    await wipe();
  }
  void s;
}

export async function run() {
  const s = area('security (TEST_MODE=0)');
  await wipe();
  // R1: TEST_MODE=1 on the polygon with an empty TEST_USERS = everyone may test (the QA harness relies
  // on it). The client worker and TEST_USERS lists are checked below with restarted workers.
  await testUsersChecks(s);
  await wipe();
  telegram.failSend = false;
  ctx.base = await restartWorker({ testMode: '0', publicUrl: 'https://qa.example' });
  try {
    const health = await req(null, 'GET', '/health', { allowNonJsonError: true });
    s.eq('health: testMode false', health.body?.testMode, false);
    for (const p of ['/api/test/role', '/api/test/clock', '/api/test/run-expiry', '/api/test/reset-me', '/api/test/register']) {
      const r = await req(900_000_001, 'POST', p, { body: { role: 'owner', days: 1 } });
      s.eq(`${p} → 404 without TEST_MODE`, r.status, 404);
    }
    s.eq('X-Test-User + correct X-Test-Key → 401 without TEST_MODE', (await req(900_000_001, 'GET', '/api/me')).status, 401);
    s.eq('QA helper endpoints are off without TEST_MODE', (await fetch(ctx.base + '/__qa/wipe', { method: 'POST', headers: { 'x-test-key': TEST_KEY } })).status, 404);
    const cors = await fetch(ctx.base + '/api/me', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    s.check('no CORS for localhost without TEST_MODE', !cors.headers.get('access-control-allow-origin'), cors.headers.get('access-control-allow-origin'));

    // setup: first owner
    s.eq('setup wrong key → 403', (await req(null, 'GET', '/setup?key=nope')).status, 403);
    const setup = await req(null, 'GET', `/setup?key=${SETUP_KEY}&owner=id:${OWNER}`);
    s.check('setup with owner=id:… → 200, owner created', setup.status === 200 && setup.body.steps.find((x) => x.step === 'addOwner')?.ok, setup.text.slice(0, 300));
    const typo = await req(null, 'GET', `/setup?key=${SETUP_KEY}&owner=${encodeURIComponent('+12345')}`, { allow5xx: true });
    const staff0 = (await call(OWNER, 'GET', '/api/owner/staff')).body ?? [];
    s.check('setup owner=+12345 (typo in a phone) does NOT make Telegram user 12345 an owner', !staff0.some((x) => x.telegramId === 12_345), `${typo.status} ${JSON.stringify(staff0.map((x) => [x.telegramId, x.role]))}`);

    // roles with real signatures
    s.eq('owner (signed initData) → owner stats 200', (await call(OWNER, 'GET', '/api/owner/stats')).status, 200);
    const meOwner = (await call(OWNER, 'GET', '/api/me')).body;
    s.eq('owner role from the staff table', meOwner?.role, 'owner');
    s.eq('owner adds a florist by Telegram id', (await call(OWNER, 'POST', '/api/owner/staff', { phoneOrTelegramId: `id:${FLORIST}`, role: 'florist' })).status, 201);
    s.eq('florist → owner endpoint 403', (await call(FLORIST, 'GET', '/api/owner/stats')).status, 403);
    s.eq('florist → staff endpoint 200', (await call(FLORIST, 'GET', '/api/staff/recent')).status, 200);
    // client registers through the bot (own contact)
    const contact = (from, phone, userId = from) => req(null, 'POST', '/telegram/webhook', {
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'Клиентка' }, contact: { phone_number: phone, first_name: 'Клиентка', user_id: userId } } },
      allowNonJsonError: true,
    });
    s.eq('bot: contact of ANOTHER user is not accepted', [(await contact(CLIENT, '+998901112299', 42)).status, (await call(CLIENT, 'GET', '/api/me')).body?.registered], [200, false]);
    s.eq('bot: own contact registers the client', [(await contact(CLIENT, '+998901112299')).status, (await call(CLIENT, 'GET', '/api/me')).body?.registered], [200, true]);
    s.eq('client → staff endpoint 403', (await call(CLIENT, 'GET', '/api/staff/recent')).status, 403);
    s.eq('client → owner endpoint 403', (await call(CLIENT, 'GET', '/api/owner/clients')).status, 403);
    s.eq('X-Test-User header cannot override a signed user', (await req(900_000_100, 'GET', '/api/me', { headers: await tma(CLIENT) })).body?.telegramId, CLIENT);

    // forged / stale initData
    const now = Math.floor(Date.now() / 1000);
    s.eq('initData signed with another bot token → 401', (await req(null, 'GET', '/api/me', { headers: await tma(OWNER, { token: '1:other' }) })).status, 401);
    const expired = await req(null, 'GET', '/api/me', { headers: await tma(OWNER, { authDate: now - 2 * 86_400 }) });
    s.eq('initData older than 24 h → 401 expired', [expired.status, expired.body?.error?.code], [401, 'expired']);
    const good = (await tma(OWNER)).authorization;
    s.eq('initData with user id changed after signing → 401', (await req(null, 'GET', '/api/me', { headers: { authorization: good.replace(String(OWNER), String(OWNER2)) } })).status, 401);
    s.eq('initData hash in upper case still valid (hex)', (await req(null, 'GET', '/api/me', { headers: { authorization: good.replace(/hash=([0-9a-f]+)/, (m, h) => 'hash=' + h.toUpperCase()) } })).status, 200);

    // owner protections
    const list = (await call(OWNER, 'GET', '/api/owner/staff')).body;
    const me = list.find((x) => x.telegramId === OWNER);
    const del = await call(OWNER, 'DELETE', `/api/owner/staff/${me.id}`);
    s.eq('owner cannot remove himself (last owner) → 409', del.status, 409);
    s.eq('last owner cannot demote himself → 409', (await call(OWNER, 'POST', '/api/owner/staff', { phoneOrTelegramId: `id:${OWNER}`, role: 'florist' })).status, 409);
    const add2 = await call(OWNER, 'POST', '/api/owner/staff', { phoneOrTelegramId: `id:${OWNER2}`, role: 'owner' });
    s.eq('second owner added', add2.status, 201);
    const delSelf2 = await call(OWNER, 'DELETE', `/api/owner/staff/${me.id}`);
    s.eq('owner cannot remove himself even when another owner exists → 409', delSelf2.status, 409);
    s.eq('owner 2 removes owner 1 → 200', (await call(OWNER2, 'DELETE', `/api/owner/staff/${me.id}`)).status, 200);
    s.eq('removed owner loses owner access → 403', (await call(OWNER, 'GET', '/api/owner/stats')).status, 403);
    s.eq('owner 2 cannot remove himself now (last owner) → 409', (await call(OWNER2, 'DELETE', `/api/owner/staff/${add2.body.id}`)).status, 409);
  } finally {
    telegram.failSend = true;
    ctx.base = await restartWorker({ testMode: '1' });
    await wipe();
  }
}
