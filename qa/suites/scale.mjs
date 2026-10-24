// Scale / performance (local approximation of Workers Free: 10 ms CPU, 50 D1 queries / subrequests
// per invocation). Seeds ~2 000 clients and ~20 000 operations through the API, then measures p50/p95
// latency and D1 round trips / statements / rows read per request (QA entry counters), and runs the
// nightly job on the full dataset (batching by CRON_MAX_CLIENTS, everything processed eventually).
import { as, clock, ctx, d1Of, infraErrors, newKey, percentile, qa, req, setRole, sql, wipe } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { checkExpirySettled, checkInvariants } from '../lib/invariants.mjs';
import { telegram } from '../lib/worker.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101;
const U0 = 901_000_000;
const NAMES = ['Анна', 'Дилноза', 'Oʻgʻiloy', 'Сардор', 'Малика', 'G’ulom', 'Нигора', 'Бобур', 'Шахло', 'Тимур', 'Гульнара', 'Азиз'];

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

/** POST with retry on 409 conflict (parallel writers on one client). */
async function write(user, path, body, tries = 4) {
  for (let t = 0; ; t++) {
    const r = await as(user).post(path, body);
    if (r.status !== 409 || t >= tries || r.body?.error?.code !== 'conflict') return r;
  }
}

export async function run({ clients: nClients = 2000, ops: nOps = 20000 } = {}) {
  const s = area('scale');
  const t0 = Date.now();
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');

  // ---------------------------------------------------------------- seed clients
  const ids = new Array(nClients);
  const codes = new Array(nClients);
  const phones = new Array(nClients);
  await pool([...Array(nClients).keys()], 8, async (i) => {
    phones[i] = `+99895${String(i).padStart(7, '0')}`;
    const r = await as(U0 + i).post('/api/test/register', { phone: phones[i], name: `${NAMES[i % NAMES.length]} ${i}` });
    if (r.status !== 201) throw new Error(`seed register ${i}: ${r.status} ${r.text}`);
    ids[i] = r.body.client.id;
    codes[i] = r.body.client.code;
  });
  console.log(`  scale: ${nClients} clients registered in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // ---------------------------------------------------------------- seed operations in 20 phases (+9 days each)
  const heavy = ids[0];
  const purchasesBy = new Map();
  let done = 0, failed = 0;
  const statuses = {};
  const phases = 20;
  const perPhase = Math.ceil(nOps / phases);
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let ph = 0; ph < phases; ph++) {
    if (ph > 0) await clock(9);
    const list = [];
    for (let k = 0; k < perPhase; k++) {
      const x = rand();
      const ci = 1 + Math.floor(Math.pow(rand(), 1.6) * (nClients - 1)); // some clients buy a lot, many rarely
      if (x < 0.05) list.push({ t: 'heavy' });
      else if (x < 0.85) list.push({ t: 'buy', ci, amount: [40_000, 90_000, 120_000, 180_000, 250_000, 400_000, 900_000][Math.floor(rand() * 7)] });
      else if (x < 0.9) list.push({ t: 'buy', ci, amount: 200_000, redeem: true });
      else if (x < 0.95) list.push({ t: 'rev', ci });
      else list.push({ t: 'adj', ci, pts: Math.floor(rand() * 5_000) + 1 });
    }
    // Most operations go through /__qa/seed (same engine + repository, no HTTP/auth/notifications:
    // local D1 is single-threaded, ~15 round trips per HTTP purchase would take an hour); every 25th
    // operation goes through the real HTTP route so the routes are exercised under load too.
    const seedOps = [];
    const httpOps = [];
    for (const [k, o] of list.entries()) {
      const clientId = o.t === 'heavy' ? heavy : ids[o.ci];
      let op;
      if (o.t === 'heavy') op = { t: 'buy', clientId, amount: 150_000, redeem: k % 7 === 0 };
      else if (o.t === 'buy') op = { t: 'buy', clientId, amount: o.amount, redeem: !!o.redeem };
      else if (o.t === 'rev') {
        const ps = purchasesBy.get(clientId);
        if (!ps?.length) continue;
        op = { t: 'rev', clientId, purchaseId: ps.splice(Math.floor(rand() * ps.length), 1)[0] };
      } else op = { t: 'adj', clientId, points: o.pts };
      (k % 25 === 0 ? httpOps : seedOps).push(op);
    }
    const remember = (clientId, purchaseId) => {
      if (!purchaseId) return;
      if (!purchasesBy.has(clientId)) purchasesBy.set(clientId, []);
      purchasesBy.get(clientId).push(purchaseId);
    };
    const batches = [];
    for (let b = 0; b < seedOps.length; b += 100) batches.push(seedOps.slice(b, b + 100));
    await pool(batches, 3, async (batch) => {
      const r = await qa('/seed', { ops: batch });
      r.results.forEach((x, j) => {
        // item 8: reversals outside the 24 h window / of spent мёд / of a used gift are refused by the engine
        const byRule = !x.ok && batch[j].t === 'rev' && /reversed only within|already been used|cashback of this purchase has been spent/.test(String(x.error));
        const key = x.ok ? 201 : byRule ? 'seed-refused-by-rule' : 'seed-error';
        statuses[key] = (statuses[key] ?? 0) + 1;
        if (x.ok) { done++; remember(batch[j].clientId, x.purchaseId); } else if (!byRule) { failed++; if (failed < 5) console.log('  seed error:', x.error); }
      });
    });
    await pool(httpOps, 4, async (op) => {
      let r;
      if (op.t === 'buy') r = await write(FLORIST, '/api/staff/purchase', { clientId: op.clientId, amount: op.amount, redeem: op.redeem, idempotencyKey: newKey('s') });
      else if (op.t === 'rev') r = await write(FLORIST, `/api/staff/purchase/${op.purchaseId}/reverse`, { reason: 'Нагрузочный тест' });
      else r = await write(OWNER, `/api/owner/clients/${op.clientId}/adjust`, { points: op.points, reason: 'Нагрузка' });
      // item 8: a reversal outside the window / of spent мёд / of a used gift is refused by rule, not a failure
      const refused = op.t === 'rev' && r.status === 409 && /отменить нельзя/.test(r.body?.error?.message ?? '');
      const st = refused ? '409-refused-by-rule' : r.status;
      statuses[st] = (statuses[st] ?? 0) + 1;
      if (refused) { /* expected */ } else if (r.status >= 400) failed++;
      else { done++; remember(op.clientId, r.body?.purchaseId); }
    });
    if (ph % 5 === 4) console.log(`  scale: phase ${ph + 1}/${phases} done (${done} ops, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const [cnt] = await sql(`SELECT (SELECT COUNT(*) FROM clients) AS clients, (SELECT COUNT(*) FROM purchases) AS purchases, (SELECT COUNT(*) FROM points_ledger) AS ledger,
    (SELECT COUNT(*) FROM purchases WHERE client_id = ?) AS heavy`, [heavy]);
  console.log(`  scale: seeded ${JSON.stringify(cnt)} in ${((Date.now() - t0) / 1000).toFixed(0)} s, statuses ${JSON.stringify(statuses)}`);
  s.check('seed: no 5xx while seeding', !Object.keys(statuses).some((k) => Number(k) >= 500 && !infraErrors.length), { statuses, infraErrors: infraErrors.length });
  s.check('seed: 4xx only on races / reversed twice (< 2%; reversals refused by the item-8 rule not counted)', failed < nOps * 0.02, { failed, statuses });
  const inv = await checkInvariants();
  s.check(`invariants on the seeded dataset (${cnt.clients} clients, ${cnt.purchases} purchases, ${cnt.ledger} ledger rows)`, inv.length === 0, inv.slice(0, 5));

  // ---------------------------------------------------------------- measurements
  const results = [];
  async function measure(label, n, fn) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = await fn(i);
      const c = await d1Of(r.id);
      rows.push({ ms: r.ms, server: c?.ms ?? 0, calls: c?.calls ?? -1, stmts: c?.stmts ?? -1, rowsRead: c?.rowsRead ?? -1, fetches: c?.fetches ?? 0, status: r.status, bytes: r.bytes?.length ?? 0 });
    }
    const col = (k) => rows.map((x) => x[k]);
    const row = {
      endpoint: label, n, p50: Math.round(percentile(col('ms'), 50)), p95: Math.round(percentile(col('ms'), 95)),
      serverP95: Math.round(percentile(col('server'), 95)), maxD1Calls: Math.max(...col('calls')), maxStmts: Math.max(...col('stmts')),
      maxRowsRead: Math.max(...col('rowsRead')), maxFetches: Math.max(...col('fetches')), statuses: [...new Set(col('status'))].join(','), maxBytes: Math.max(...col('bytes')),
    };
    results.push(row);
    s.check(`${label}: all responses 2xx`, rows.every((x) => x.status < 300), row.statuses);
    s.check(`${label}: ≤ 50 D1 statements and ≤ 50 subrequests (D1 calls + fetch)`, row.maxStmts <= 50 && row.maxD1Calls + row.maxFetches <= 50, row);
    return row;
  }
  const typical = () => ids[1 + Math.floor(Math.random() * (nClients - 1))];
  const userOf = (id) => U0 + ids.indexOf(id);
  telegram.failSend = false; // realistic: messages go out

  await measure('GET /api/me (typical client)', 40, () => as(userOf(typical())).get('/api/me'));
  await measure('GET /api/me (heavy client, ~1k purchases)', 10, () => as(U0).get('/api/me'));
  await measure('GET /api/staff/client?q=<code>', 30, () => as(FLORIST).get('/api/staff/client?q=' + codes[1 + Math.floor(Math.random() * (nClients - 1))]));
  await measure('GET /api/staff/client?q=<full phone>', 30, () => as(FLORIST).get('/api/staff/client?q=' + encodeURIComponent(phones[1 + Math.floor(Math.random() * (nClients - 1))])));
  await measure('GET /api/staff/client?q=<4 digits, many matches>', 20, () => as(FLORIST).get('/api/staff/client?q=' + String(1000 + Math.floor(Math.random() * 999))));
  await measure('POST /api/staff/purchase/preview', 30, () => as(FLORIST).post('/api/staff/purchase/preview', { clientId: typical(), amount: 250_000, redeem: true }));
  const fresh = []; // reversible purchases (item 8: within the window, мёд not spent) for the reversal measurement
  await measure('POST /api/staff/purchase (typical)', 30, async () => {
    const r = await as(FLORIST).post('/api/staff/purchase', { clientId: typical(), amount: 180_000, redeem: false, idempotencyKey: newKey('pm') });
    if (r.status === 201 && r.body.client.balance - r.body.preview.cashback >= 0 && !r.body.giftsUnlocked.length) fresh.push(r.body.purchaseId);
    return r;
  });
  await measure('POST /api/staff/purchase (heavy client)', 10, () => as(FLORIST).post('/api/staff/purchase', { clientId: heavy, amount: 180_000, redeem: true, idempotencyKey: newKey('ph') }));
  const revTargets = fresh.slice(0, 20);
  await measure('POST /api/staff/purchase/:id/reverse', revTargets.length, (i) => as(FLORIST).post(`/api/staff/purchase/${revTargets[i]}/reverse`, { reason: 'Замер' }));
  await measure('POST /api/owner/clients/:id/adjust', 20, () => as(OWNER).post(`/api/owner/clients/${typical()}/adjust`, { points: 500, reason: 'Замер' }));
  await measure('GET /api/staff/recent', 10, () => as(FLORIST).get('/api/staff/recent'));
  await measure('GET /api/owner/stats', 10, () => as(OWNER).get('/api/owner/stats'));
  for (const status of ['', 'active', 'sleeping', 'lost', 'expiring']) {
    for (const sort of ['last_purchase_desc', 'spent_desc', 'balance_desc', 'name', 'created_desc']) {
      await measure(`GET /api/owner/clients status=${status || 'all'} sort=${sort}`, 3, () => as(OWNER).get(`/api/owner/clients?sort=${sort}${status ? '&status=' + status : ''}`));
    }
  }
  await measure('GET /api/owner/clients level=queen sort=spent_desc', 3, () => as(OWNER).get('/api/owner/clients?level=queen&sort=spent_desc'));
  await measure('GET /api/owner/clients q=<name part>', 5, () => as(OWNER).get('/api/owner/clients?q=' + encodeURIComponent('нигора')));
  await measure('GET /api/owner/clients q=<rare name> (scan)', 5, () => as(OWNER).get('/api/owner/clients?q=' + encodeURIComponent('Несуществующая')));
  await measure('GET /api/owner/clients q=<phone digits>', 5, () => as(OWNER).get('/api/owner/clients?q=0001'));
  const page1 = await as(OWNER).get('/api/owner/clients?sort=spent_desc&limit=100');
  await measure('GET /api/owner/clients page 2 (cursor, limit 100)', 5, () => as(OWNER).get(`/api/owner/clients?sort=spent_desc&limit=100&cursor=${page1.body.nextCursor}`));
  await measure('GET /api/owner/clients/:id (typical card)', 20, () => as(OWNER).get(`/api/owner/clients/${typical()}`));
  await measure('GET /api/owner/clients/:id (heavy card)', 5, () => as(OWNER).get(`/api/owner/clients/${heavy}`));
  await measure('GET /api/owner/operations?limit=100', 5, () => as(OWNER).get('/api/owner/operations?limit=100'));
  await measure('GET /api/owner/operations?limit=500', 5, () => as(OWNER).get('/api/owner/operations?limit=500'));
  await measure('GET /api/owner/export/clients.csv', 3, () => as(OWNER).get('/api/owner/export/clients.csv'));
  await measure('GET /api/owner/export/operations.csv (default 90 days)', 3, () => as(OWNER).get('/api/owner/export/operations.csv'));
  await measure('GET /api/owner/export/operations.csv (whole history)', 2, () => as(OWNER).get('/api/owner/export/operations.csv?from=2020-01-01&to=2099-12-31'));
  await measure('POST /api/owner/export/link', 3, () => as(OWNER).post('/api/owner/export/link', { kind: 'clients' }));
  telegram.failSend = true;
  // exports cross the 1 500-row chunk boundary: every row exactly once
  const csvRows = (r) => new TextDecoder().decode(r.bytes).replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).length - 1;
  const cc = await as(OWNER).get('/api/owner/export/clients.csv');
  const [nc] = await sql('SELECT COUNT(*) AS n FROM clients');
  s.eq('clients.csv over several chunks: one line per client', csvRows(cc), nc.n);
  const oc = await as(OWNER).get('/api/owner/export/operations.csv?from=2020-01-01&to=2099-12-31');
  const [no] = await sql(`SELECT (SELECT COUNT(*) FROM purchases) + (SELECT COUNT(*) FROM purchases WHERE status = 'reversed') + (SELECT COUNT(*) FROM points_ledger WHERE purchase_id IS NULL) + (SELECT COUNT(*) FROM rewards WHERE status = 'used' AND used_in_purchase IS NULL) AS n`);
  if (no.n <= 50_000) s.eq('operations.csv over many chunks: one line per operation (no line lost or doubled at chunk borders)', csvRows(oc), no.n);
  else s.eq('operations.csv > 50 000 rows → 400', oc.status, 400);

  console.log('\n  endpoint'.padEnd(64) + 'p50   p95  srv95  D1calls stmts  rowsRead fetch');
  for (const r of results) console.log(`  ${r.endpoint.padEnd(62)}${String(r.p50).padStart(4)} ${String(r.p95).padStart(5)} ${String(r.serverP95).padStart(5)} ${String(r.maxD1Calls).padStart(7)} ${String(r.maxStmts).padStart(5)} ${String(r.maxRowsRead).padStart(9)} ${String(r.maxFetches).padStart(5)}`);
  const heavyReads = results.filter((r) => r.maxRowsRead > 20_000);
  if (heavyReads.length) note('perf', `O(n) reads per request (rows read > 20 000 at ${nClients} clients): ${heavyReads.map((r) => `${r.endpoint} = ${r.maxRowsRead}`).join('; ')}. D1 Free: 5 M rows read per day.`);

  // ---------------------------------------------------------------- hourly job on the whole dataset (R2)
  const [pos] = await sql(`SELECT COUNT(*) AS n FROM client_stats WHERE balance > 0`);
  await clock(100); // everybody is past the 90-day expiry: all due on the same day
  const cron = [];
  telegram.failSend = false;
  const tgBefore = telegram.calls.length;
  // 24 hourly runs of one day (hours 0–23 Tashkent): messages only 09:00–21:00.
  for (let h = 0; h < 24; h++) {
    const r = await qa('/cron', { hour: h });
    const line = r.logs.find((l) => l.startsWith('daily job')) ?? '';
    const m = Object.fromEntries([...line.matchAll(/(\w+)=(\w+)/g)].map((x) => [x[1], x[2]]));
    cron.push({ h, calls: r.counter.calls, stmts: r.counter.stmts, maxBatch: r.counter.maxBatch, fetches: r.counter.fetches, ms: r.counter.ms, checked: Number(m.checked), expired: Number(m.expired), warned: Number(m.warned), failed: Number(m.failed), sent: Number(m.sent), more: m.more === 'true', budget: Number(m.subrequests) });
  }
  const total = cron.reduce((t, x) => ({ checked: t.checked + x.checked, expired: t.expired + x.expired, failed: t.failed + x.failed, sent: t.sent + x.sent }), { checked: 0, expired: 0, failed: 0, sent: 0 });
  const maxCalls = Math.max(...cron.map((x) => x.calls)), maxStmts = Math.max(...cron.map((x) => x.stmts)), maxFetch = Math.max(...cron.map((x) => x.fetches)), maxSub = Math.max(...cron.map((x) => x.calls + x.fetches));
  const runsWithWork = cron.filter((x) => x.checked > 0).length;
  console.log(`  cron: 24 hourly runs, ${runsWithWork} with work, checked ${total.checked}, expired ${total.expired}, sent ${total.sent}, failed ${total.failed}; per run max D1 calls ${maxCalls}, statements ${maxStmts}, fetches ${maxFetch}, subrequests ${maxSub}, ms p95 ${Math.round(percentile(cron.map((x) => x.ms), 95))}`);
  s.check('cron: every hourly run ≤ 45 subrequests (D1 round trips + Telegram fetches)', maxSub <= 45, cron.map((x) => x.calls + x.fetches));
  s.check('cron: the job counts its own subrequests the same way', cron.every((x) => x.budget >= x.calls), cron.map((x) => [x.budget, x.calls]));
  s.check('cron: every run checks ≤ CRON_MAX_CLIENTS (100)', cron.every((x) => x.checked <= 100), cron.map((x) => x.checked));
  s.check('cron: everything due is processed within one day of hourly runs', !cron[cron.length - 1].more && total.checked >= pos.n, { runs: runsWithWork, checked: total.checked, due: pos.n });
  s.check('cron: messages only 09:00–21:00 Tashkent', cron.every((x) => (x.h >= 9 && x.h < 21) || x.fetches === 0), cron.map((x) => [x.h, x.fetches]));
  s.eq('cron: every positive balance burned exactly once', total.expired, pos.n);
  s.eq('cron: no failed clients', total.failed, 0);
  const now = (await as(OWNER).get('/api/me')).body.now;
  const settled = await checkExpirySettled(now);
  s.check('cron: nothing left unburned after one day of runs', settled.length === 0, settled.slice(0, 3));
  // The outbox keeps the rest and drains at ≤ 25 messages per daytime run; nothing is lost.
  let guard = 0;
  for (;;) {
    const [q] = await sql(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`);
    if (!q.n || ++guard > 400) break;
    await qa('/cron', { hour: 10 });
  }
  const ob = await sql(`SELECT status, COUNT(*) AS n FROM outbox GROUP BY status`);
  const obBy = Object.fromEntries(ob.map((r) => [r.status, r.n]));
  const [burnedClients] = await sql(`SELECT COUNT(DISTINCT client_id) AS n FROM outbox`);
  s.check('cron: outbox drained, every queued message sent (or skipped for a client without a chat)', !obBy.pending && !obBy.failed && burnedClients.n >= pos.n, obBy);
  console.log(`  cron: outbox drained after ${guard} more daytime runs; Telegram calls ${telegram.calls.length - tgBefore}`);
  telegram.failSend = true;
  const open = area('open risks');
  open.check('cron: ≤ 50 D1 statements per run (only if D1 counted every statement of a batch as a query)', maxStmts <= 50, { maxStmts, note: 'one batch per run carries all writes' });
  const again = await qa('/cron', { hour: 10 });
  s.check('cron: an extra run after the backlog does nothing', /checked=0/.test(again.logs.join(' ')), again.logs);
  const inv2 = await checkInvariants();
  s.check('invariants after the hourly job on the full dataset', inv2.length === 0, inv2.slice(0, 5));
  note('perf', `Hourly job at ${nClients} clients all due on one day: ${runsWithWork} runs to process them (max ${maxSub} subrequests per run); their ${total.sent + 0} messages of the first day, the rest drained by ${guard} more daytime runs (25 per run ≈ 300 per day: Telegram sends are 1 subrequest each).`);
  return { endpoints: results, cron: { runs: runsWithWork, ...total, maxCalls, maxStmts, maxFetch, maxSubrequests: maxSub, drainRuns: guard }, seeded: cnt, seconds: Math.round((Date.now() - t0) / 1000) };
}
void ctx; void req;
