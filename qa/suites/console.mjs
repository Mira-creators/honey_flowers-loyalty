// Owner console & the newer owner/test endpoints, end to end against the Worker:
// /health, one-time web link → browser session (Bearer) → console analytics → logout,
// console analytics parameters, import (dry run, chunks, replay, undo, undo refused after a claim),
// owner grant (honey / gift, idempotent), own-card guard (self_operation), client history paging,
// demo data seed + clear. Every refusal must leave the business tables unchanged (fingerprint).
import { as, clock, newKey, req, register, setRole, sql, wipe } from '../lib/api.mjs';
import { area } from '../lib/report.mjs';
import { checkInvariants, fingerprint } from '../lib/invariants.mjs';
import { BOT_TOKEN, SETUP_KEY, TEST_KEY, WEBHOOK_SECRET } from '../lib/worker.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101, MANAGER = 900_000_102;
const CLIENT = 900_400_001, BUYER = 900_400_002, CLAIMER = 900_400_003;
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

export async function run() {
  const s = area('console & web (flows)');
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  await setRole(MANAGER, 'manager');
  const cl = await register(CLIENT, 'Консоль Клиент', '+998901230001');
  const o = as(OWNER), f = as(FLORIST);

  /** A refused request must not change any business table. */
  async function refused(label, fn, want) {
    const before = await fingerprint();
    const r = await fn();
    const after = await fingerprint();
    const ok = (Array.isArray(want) ? want.includes(r.status) : r.status === want) && JSON.stringify(before) === JSON.stringify(after);
    s.check(`${label} → ${want}, nothing changed`, ok, `${r.status} ${r.text.slice(0, 160)}`);
    return r;
  }

  // ---------------------------------------------------------------- /health
  const health = await req(null, 'GET', '/health', { allowNonJsonError: true });
  s.eq('/health: 200, db ok, test mode for everyone (polygon)', [health.status, health.body?.ok, health.body?.db, health.body?.testMode, health.body?.testUsers], [200, true, 'ok', true, 'everyone']);
  s.check('/health: no secrets in the payload', ![BOT_TOKEN, SETUP_KEY, TEST_KEY, WEBHOOK_SECRET].some((x) => x && health.text.includes(x)), health.text.slice(0, 300));
  const hPost = (await req(null, 'POST', '/health', { allowNonJsonError: true })).status;
  s.check('/health: POST → 404/405', hPost === 404 || hPost === 405, hPost);

  // ---------------------------------------------------------------- web link → browser session
  await refused('florist asks for a console link', () => f.post('/api/owner/web-link', {}), 403);
  const link = await o.post('/api/owner/web-link', {});
  const token = /#t=([^&]+)$/.exec(link.body?.url ?? '')?.[1];
  s.check('owner gets a one-time console link (201, console.html#t=…)', link.status === 201 && /\/console\.html#t=/.test(link.body.url) && !!token, link.text.slice(0, 200));
  s.eq('session with a wrong token → 401', (await req(null, 'POST', '/api/web/session', { body: { token: 'x'.repeat(40) } })).status, 401);
  s.eq('session without a token → 400', (await req(null, 'POST', '/api/web/session', { body: {} })).status, 400);
  const sess = await req(null, 'POST', '/api/web/session', { body: { token } });
  s.check('session from the link → 201 with a signed session', sess.status === 201 && typeof sess.body?.session === 'string' && sess.body.session.length > 20, sess.text.slice(0, 200));
  s.eq('the link works only once → 401', (await req(null, 'POST', '/api/web/session', { body: { token } })).status, 401);
  const bearer = (session = sess.body.session) => ({ headers: { authorization: `Bearer ${session}` } });
  const wm = await req(null, 'GET', '/api/web/me', bearer());
  s.eq('GET /api/web/me with the session → owner via webSession', [wm.status, wm.body?.telegramId, wm.body?.via], [200, OWNER, 'webSession']);
  s.eq('console overview with the session → 200', (await req(null, 'GET', '/api/owner/console/overview', bearer())).status, 200);
  s.eq('owner client list with the session → 200', (await req(null, 'GET', '/api/owner/clients', bearer())).status, 200);
  for (const [m, p, b] of [['GET', '/api/staff/recent'], ['GET', '/api/me'], ['POST', '/api/staff/purchase', { clientId: cl.id, amount: 100_000, redeem: false, idempotencyKey: newKey() }]]) {
    await refused(`browser session on ${m} ${p} (cash desk / client API)`, () => req(null, m, p, { ...bearer(), body: b }), 403);
  }
  await refused('browser session asks for a new link', () => req(null, 'POST', '/api/owner/web-link', { ...bearer(), body: {} }), 403);
  const tampered = sess.body.session.slice(0, -2) + (sess.body.session.endsWith('AA') ? 'BB' : 'AA');
  s.eq('tampered session → 401', (await req(null, 'GET', '/api/web/me', bearer(tampered))).status, 401);
  s.eq('logout → 200', (await req(null, 'POST', '/api/web/logout', { ...bearer(), body: {} })).status, 200);
  s.eq('after logout the session is revoked → 401', (await req(null, 'GET', '/api/web/me', bearer())).status, 401);
  s.eq('Telegram owner: GET /api/web/me → 200 (testHeader)', (await o.get('/api/web/me')).body?.via, 'testHeader');
  s.eq('florist: GET /api/web/me → 403', (await f.get('/api/web/me')).status, 403);

  // ---------------------------------------------------------------- console analytics
  const day = today();
  const buys = [];
  for (const amount of [120_000, 80_000, 300_000]) buys.push((await f.post('/api/staff/purchase', { clientId: cl.id, amount, redeem: false, idempotencyKey: newKey('cs') })).body);
  const ov = await o.get(`/api/owner/console/overview?from=${day}&to=${day}`);
  s.eq('overview for today: 3 purchases, revenue 500 000, 1 buyer', [ov.status, ov.body?.current?.purchases, ov.body?.current?.revenue, ov.body?.current?.activeClients], [200, 3, 500_000, 1]);
  for (const sort of ['name', 'registered', 'count', 'total', 'avg', 'last', 'balance', 'level']) {
    for (const dir of ['asc', 'desc']) {
      const r = await o.get(`/api/owner/console/clients?sort=${sort}&dir=${dir}&limit=5`);
      s.check(`console clients sort=${sort} ${dir} → 200`, r.status === 200 && Array.isArray(r.body?.rows), `${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  s.eq('console clients with every filter → 200', (await o.get(`/api/owner/console/clients?from=${day}&to=${day}&level=bee&minCount=1&maxCount=9&minTotal=1&maxTotal=9000000&minAvg=1&maxAvg=900000&activity=active&bmonth=5&regFrom=2020-01-01&regTo=${day}&gift=1&linked=tg&q=Консоль`)).status, 200);
  s.eq('console operations with totals → 200', (await o.get(`/api/owner/console/operations?from=${day}&to=${day}&totals=1&kinds=purchase&minAmount=1&maxAmount=999999999`)).status, 200);
  s.eq('console cohorts → 200', (await o.get('/api/owner/console/cohorts?months=6')).status, 200);
  const ops = await o.get(`/api/owner/console/operations?from=${day}&to=${day}&kinds=purchase&limit=2`);
  const cur = ops.body?.nextCursor;
  if (cur) s.eq('console operations: page 2 via the cursor → 200', (await o.get(`/api/owner/console/operations?from=${day}&to=${day}&kinds=purchase&limit=2&cursor=${encodeURIComponent(cur)}`)).status, 200);
  for (const [label, qs] of [['from after to', `from=${day}&to=2020-01-01`], ['impossible date', 'from=2026-02-30&to=2026-03-01'], ['more than 10 years', 'from=2000-01-01&to=2026-01-01'], ['only from', 'from=2026-01-01'], ['bad format', 'from=01.01.2026&to=02.01.2026']]) {
    s.eq(`console overview: ${label} → 400`, (await o.get(`/api/owner/console/overview?${qs}`)).status, 400);
  }
  for (const [p, qs] of [['clients', 'sort=bogus'], ['clients', 'activity=bogus'], ['clients', 'linked=x'], ['clients', 'cursor=garbage'], ['clients', 'minCount=-1'], ['operations', 'kinds=bogus'], ['operations', 'cursor=garbage']]) {
    s.eq(`console ${p}?${qs} → 400`, (await o.get(`/api/owner/console/${p}?${qs}`)).status, 400);
  }

  // ---------------------------------------------------------------- import
  const opts = { creditBalance: true, levelFromTotal: true, cellsFromCount: true };
  const rows = [
    { line: 2, phone: '+998 90 555 00 01', name: 'Импорт Один', birthday: '1990-05-01', balance: 12_000, total: 2_500_000, count: 4, lastPurchase: '2026-01-15' },
    { line: 3, phone: '90 555 00 02', name: 'Импорт Два', balance: 3_000, total: 100_000, count: 1, lastPurchase: '2026-02-01' },
    { line: 4, phone: '12345', name: 'Плохой номер' },
    { line: 5, phone: '+998905550001', name: 'Дубликат' },
    { line: 6, phone: '+998901230001', name: 'Уже клиент' },
  ];
  const batchId = 'qa-import-0001';
  const fpDry = await fingerprint();
  const dry = await o.post('/api/owner/import', { batchId, fileName: 'база.xlsx', dryRun: true, options: opts, rows });
  s.eq('import dry run → 200: 2 create, 1 update, 2 skipped, 15 000 мёд', [dry.status, dry.body?.summary?.create, dry.body?.summary?.update, dry.body?.summary?.skipped, dry.body?.summary?.honey], [200, 2, 1, 2, 15_000]);
  s.check('import dry run changed nothing', JSON.stringify(fpDry) === JSON.stringify(await fingerprint()), '');
  const imp = await o.post('/api/owner/import', { batchId, fileName: 'база.xlsx', dryRun: false, options: opts, rows });
  s.eq('import → 201: 2 clients created with 15 000 мёд', [imp.status, imp.body?.summary?.create, imp.body?.summary?.honey], [201, 2, 15_000]);
  const again = await o.post('/api/owner/import', { batchId, fileName: 'база.xlsx', dryRun: false, options: opts, rows });
  s.eq('the same chunk again → replay, no second мёд', [again.status, again.body?.summary?.create, again.body?.summary?.replay, again.body?.summary?.honey], [201, 0, 2, 0]);
  const [imported] = await sql(`SELECT COUNT(*) AS n, COALESCE(SUM(s.balance), 0) AS b FROM clients c JOIN client_stats s ON s.client_id = c.id WHERE c.phone IN ('+998905550001', '+998905550002')`);
  s.eq('imported clients in the base with their мёд', [imported.n, imported.b], [2, 15_000]);
  await refused('import: other options mid-file', () => o.post('/api/owner/import', { batchId, dryRun: false, options: { ...opts, creditBalance: false }, rows: rows.slice(0, 1) }), 409);
  await refused('import: florist', () => f.post('/api/owner/import', { batchId: 'qa-import-0009', dryRun: true, options: opts, rows }), 403);
  await refused('import: 101 rows in one request', () => o.post('/api/owner/import', { batchId: 'qa-import-0009', dryRun: true, options: opts, rows: Array.from({ length: 101 }, (_, i) => ({ line: i + 2, phone: `+9989055501${String(i).padStart(2, '0')}` })) }), 400);
  const batches = await o.get('/api/owner/import/batches');
  const b1 = batches.body?.find?.((b) => b.id === batchId);
  s.eq('import batches list: the batch is active with 2 created', [batches.status, b1?.status, b1?.created], [200, 'active', 2]);
  const undo = await o.post(`/api/owner/import/${batchId}/undo`, {});
  s.eq('undo import → undone', [undo.status, undo.body?.status], [200, 'undone']);
  const [gone] = await sql(`SELECT COUNT(*) AS n FROM clients WHERE phone IN ('+998905550001', '+998905550002')`);
  s.eq('undo removed the imported clients', gone.n, 0);
  await refused('undo the same import again', () => o.post(`/api/owner/import/${batchId}/undo`, {}), 409);
  await refused('undo an unknown import', () => o.post('/api/owner/import/nope-nope-nope/undo', {}), 404);
  await refused('import into an undone batch', () => o.post('/api/owner/import', { batchId, dryRun: false, options: opts, rows }), 409);
  // undo is refused once an imported client joined via Telegram
  const b2 = 'qa-import-0002';
  s.eq('second import → 201', (await o.post('/api/owner/import', { batchId: b2, dryRun: false, options: opts, rows: [{ line: 2, phone: '+998905550003', name: 'Займёт карту', balance: 5_000 }] })).status, 201);
  const claimed = await register(CLAIMER, 'Займёт карту', '+998905550003');
  s.eq('the person registers with the imported phone → gets the imported мёд', claimed.balance, 5_000);
  await refused('undo after an imported client joined', () => o.post(`/api/owner/import/${b2}/undo`, {}), 409);

  // ---------------------------------------------------------------- owner grant
  const g1key = newKey('grant');
  const g1 = await o.post(`/api/owner/clients/${cl.id}/grant`, { kind: 'honey', points: 700, reason: 'Извинение за задержку', idempotencyKey: g1key });
  const balBefore = g1.body?.client?.balance - 700;
  s.eq('grant 700 мёд → 201', [g1.status, g1.body?.points, g1.body?.replayed], [201, 700, false]);
  const g1b = await o.post(`/api/owner/clients/${cl.id}/grant`, { kind: 'honey', points: 700, reason: 'Извинение за задержку', idempotencyKey: g1key });
  s.eq('grant replay (same key) → 200 replayed, credited once', [g1b.status, g1b.body?.replayed, g1b.body?.client?.balance], [200, true, balBefore + 700]);
  const g2 = await o.post(`/api/owner/clients/${cl.id}/grant`, { kind: 'gift', giftId: 'delivery', reason: 'Подарок от владельца', idempotencyKey: newKey('grant') });
  s.eq('grant a gift → 201 with an available gift', [g2.status, g2.body?.gift?.status], [201, 'available']);
  for (const [label, body] of [['0 мёд', { kind: 'honey', points: 0, reason: 'Причина' }], ['negative', { kind: 'honey', points: -5, reason: 'Причина' }], ['fraction', { kind: 'honey', points: 1.5, reason: 'Причина' }], ['short reason', { kind: 'honey', points: 5, reason: 'x' }], ['unknown gift', { kind: 'gift', giftId: 'iphone', reason: 'Причина' }], ['unknown kind', { kind: 'cash', points: 5, reason: 'Причина' }]]) {
    await refused(`grant ${label}`, () => o.post(`/api/owner/clients/${cl.id}/grant`, { ...body, idempotencyKey: newKey('grant') }), 400);
  }
  await refused('grant without an idempotency key', () => o.post(`/api/owner/clients/${cl.id}/grant`, { kind: 'honey', points: 5, reason: 'Причина' }), 400);
  await refused('grant to an unknown client', () => o.post('/api/owner/clients/nope/grant', { kind: 'honey', points: 5, reason: 'Причина', idempotencyKey: newKey('grant') }), 404);
  await refused('grant by a florist', () => f.post(`/api/owner/clients/${cl.id}/grant`, { kind: 'honey', points: 5, reason: 'Причина', idempotencyKey: newKey('grant') }), 403);
  await refused('grant by a manager', () => as(MANAGER).post(`/api/owner/clients/${cl.id}/grant`, { kind: 'honey', points: 5, reason: 'Причина', idempotencyKey: newKey('grant') }), 403);

  // ---------------------------------------------------------------- own card (self_operation)
  const fCard = await register(FLORIST, 'Флорист Сама', '+998901230009');
  await setRole(FLORIST, 'florist');
  const self = await refused('florist charges a purchase on her own card', () => f.post('/api/staff/purchase', { clientId: fCard.id, amount: 100_000, redeem: false, idempotencyKey: newKey('self') }), 403);
  s.eq('own card: error code self_operation', self.body?.error?.code, 'self_operation');
  await refused('florist previews on her own card', () => f.post('/api/staff/purchase/preview', { clientId: fCard.id, amount: 100_000, redeem: false }), 403);
  s.eq('the same florist on another client → 201', (await f.post('/api/staff/purchase', { clientId: cl.id, amount: 10_000, redeem: false, idempotencyKey: newKey('ok') })).status, 201);
  const oCard = await register(OWNER, 'Владелец Сам', '+998901230008');
  await setRole(OWNER, 'owner');
  s.eq('owner tester on his own card → allowed in test mode (201)', (await o.post('/api/staff/purchase', { clientId: oCard.id, amount: 10_000, redeem: false, idempotencyKey: newKey('own') })).status, 201);

  // ---------------------------------------------------------------- client history paging
  const buyer = await register(BUYER, 'Много Покупок', '+998901230007');
  for (let i = 0; i < 56; i++) await f.post('/api/staff/purchase', { clientId: buyer.id, amount: 10_000 + i, redeem: false, idempotencyKey: newKey('h') });
  const card = await o.get(`/api/owner/clients/${buyer.id}`);
  s.eq('owner card: newest 50 history items + historyNext', [card.status, card.body?.history?.length, !!card.body?.historyNext], [200, 50, true]);
  const page2 = await o.get(`/api/owner/clients/${buyer.id}/history?cursor=${encodeURIComponent(card.body.historyNext)}`);
  const ids1 = new Set(card.body.history.map((h) => h.id));
  s.eq('history page 2: the rest, no overlap, no next', [page2.status, page2.body?.items?.length >= 6, page2.body?.items?.some((h) => ids1.has(h.id)), page2.body?.next], [200, true, false, null]);
  s.check('history pages are newest first', [...card.body.history, ...page2.body.items].every((h, i, a) => i === 0 || a[i - 1].at >= h.at), '');
  s.eq('history without a cursor = the first page', (await o.get(`/api/owner/clients/${buyer.id}/history`)).body?.items?.[0]?.id, card.body.history[0].id);
  s.eq('history: bad cursor → 400', (await o.get(`/api/owner/clients/${buyer.id}/history?cursor=garbage`)).status, 400);
  s.eq('history: unknown client → 404', (await o.get('/api/owner/clients/nope/history')).status, 404);
  s.eq('history: florist → 403', (await f.get(`/api/owner/clients/${buyer.id}/history`)).status, 403);

  // ---------------------------------------------------------------- demo data
  const [c0] = await sql('SELECT COUNT(*) AS n FROM clients');
  let chunk = 0, last = null, calls = 0;
  while (chunk !== null && calls < 50) {
    const r = await as(OWNER).post('/api/test/demo-seed', { chunk });
    calls++;
    if (r.status !== 200) { last = r; break; }
    last = r;
    chunk = r.body.nextChunk;
  }
  s.eq('demo seed: all chunks 200, finished', [last?.status, last?.body?.finished], [200, true]);
  const [demo] = await sql('SELECT COUNT(*) AS n FROM clients WHERE demo = 1');
  s.eq('demo seed: the full demo set exists', demo.n, last?.body?.total);
  const rerun = await as(OWNER).post('/api/test/demo-seed', { chunk: 0 });
  s.eq('demo seed re-run creates nothing', [rerun.status, rerun.body?.created], [200, 0]);
  s.eq('demo seed: bad chunk → 400', (await as(OWNER).post('/api/test/demo-seed', { chunk: 10_000 })).status, 400);
  const invDemo = await checkInvariants();
  s.check('invariants with demo data (incl. stats_daily)', invDemo.length === 0, invDemo.slice(0, 5));
  const clear = await as(OWNER).post('/api/test/demo-clear', {});
  const [c1] = await sql('SELECT COUNT(*) AS n FROM clients');
  s.eq('demo clear removes exactly the demo clients', [clear.status, clear.body?.clients, c1.n], [200, demo.n, c0.n]);

  const inv = await checkInvariants();
  s.check('invariants after the console flows', inv.length === 0, inv.slice(0, 5));
}
