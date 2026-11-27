// «Склад» QA: a randomized model run through the real routes (receipts UZS/USD/total, assemblies with
// «в минус», sales with/without clients, disassembly, write-offs + approvals, cancels, replays) with the
// stock invariants checked along the way; concurrency (last stems, one bouquet, one key); fuzz of every
// stock route (no 5xx, Russian error contract); role matrix + STOCK_ENABLED=0; the Mini App jsdom smoke.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { as, clock, ctx, newKey, register, req, setRole, wipe } from '../lib/api.mjs';
import { checkInvariants } from '../lib/invariants.mjs';
import { area, note } from '../lib/report.mjs';
import { checkStockInvariants, stockStats } from '../lib/stockInvariants.mjs';
import { restartWorker, ROOT } from '../lib/worker.mjs';

const OWNER = 900_700_001, F1 = 900_700_002, F2 = 900_700_003;
const CLIENTS = [900_700_011, 900_700_012, 900_700_013];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const STOCK_ROUTES = [
  ['GET', '/api/stock/status'], ['GET', '/api/stock/catalog'], ['GET', '/api/stock/templates'], ['GET', '/api/stock/suppliers'], ['GET', '/api/stock/receipts/form'],
  ['POST', '/api/stock/receipts/preview'], ['POST', '/api/stock/receipts'], ['GET', '/api/stock/receipts'], ['POST', '/api/stock/bouquets'], ['GET', '/api/stock/bouquets'],
  ['POST', '/api/stock/bouquets/x/showcase'], ['POST', '/api/stock/bouquets/x/disassemble'], ['POST', '/api/stock/bouquets/x/cancel'], ['POST', '/api/stock/sales/preview'],
  ['POST', '/api/stock/sales'], ['POST', '/api/stock/sales/x/loyalty'], ['POST', '/api/stock/writeoffs'], ['GET', '/api/stock/freshness'], ['POST', '/api/stock/lots/x/priority'],
  ['POST', '/api/stock/templates'], ['GET', '/api/stock/items/x'], ['GET', '/api/stock/bouquets/x'],
];
const OWNER_ROUTES = [
  ['GET', '/api/owner/stock/overview'], ['GET', '/api/owner/stock/config'], ['PUT', '/api/owner/stock/config'], ['POST', '/api/owner/stock/items'], ['PUT', '/api/owner/stock/items/x'],
  ['POST', '/api/owner/stock/catalog/seed'], ['POST', '/api/owner/stock/suppliers'], ['POST', '/api/owner/stock/receipts/x/cancel'], ['GET', '/api/owner/stock/approvals'],
  ['POST', '/api/owner/stock/approvals/x'], ['GET', '/api/owner/stock/balances'], ['GET', '/api/owner/stock/receipts'], ['GET', '/api/owner/stock/bouquets'], ['GET', '/api/owner/stock/writeoffs'],
];

export async function run({ seed = Math.floor(Math.random() * 1e9), ops = 400 } = {}) {
  const s = area('stock: model run');
  await wipe();
  await clock('reset'); // earlier suites leave the shared test clock moved; stock dates must be «now»
  await setRole(OWNER, 'owner');
  await setRole(F1, 'florist');
  await setRole(F2, 'florist');
  const clientIds = [];
  for (const c of CLIENTS) clientIds.push((await register(c)).id);
  s.eq('seed the starter catalog', (await as(OWNER).post('/api/owner/stock/catalog/seed', {})).status, 201);
  const cat = (await as(F1).get('/api/stock/catalog')).body;
  const tracked = cat.items.filter((i) => i.trackStock && i.kind !== 'service');
  const flowers = tracked.filter((i) => i.kind !== 'supply');
  const dlv = cat.items.find((i) => i.kind === 'service');
  const rng = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rng() * xs.length)];
  const statuses = new Map();
  const tally = (k, st) => { const key = `${k} ${st}`; statuses.set(key, (statuses.get(key) ?? 0) + 1); };
  const done = { receipts: [], bouquets: [], writeoffs: [], requests: [] };
  let invChecks = 0;
  const violations = [];
  for (let i = 0; i < ops; i++) {
    const r = rng();
    const who = rng() < 0.5 ? F1 : F2;
    let res;
    let kind;
    if (r < 0.14) {
      kind = 'receipt';
      const usd = rng() < 0.3;
      const total = rng() < 0.35;
      const lines = [...new Set(Array.from({ length: 1 + Math.floor(rng() * 6) }, () => pick(tracked)))].map((it) => {
        const pack = it.unit.pack && rng() < 0.6;
        const l = { itemId: it.id, qty: pack ? 1 + Math.floor(rng() * 3) : 5 + Math.floor(rng() * 40), unit: pack ? 'pack' : 'base' };
        if (!total || rng() < 0.2) Object.assign(l, { price: usd ? Math.round(rng() * 150) / 100 + 0.2 : 1_000 + Math.floor(rng() * 25) * 1_000, per: 'unit' });
        return l;
      });
      const body = { idempotencyKey: newKey('qr'), currency: usd ? 'USD' : 'UZS', fxRate: usd ? 12_850 : undefined, priceMode: total ? 'total' : 'lines', total: total ? (usd ? 200 + Math.floor(rng() * 300) : 500_000 + Math.floor(rng() * 4_000_000)) : undefined, extraCost: rng() < 0.3 ? 30_000 : 0, lines, confirm: true };
      res = await as(rng() < 0.7 ? OWNER : who).post('/api/stock/receipts', body);
      if (res.status === 201) done.receipts.push(res.body.receiptId);
      done.requests.push({ user: OWNER, path: '/api/stock/receipts', body });
    } else if (r < 0.5) {
      kind = 'assembly';
      const lines = [...new Set(Array.from({ length: 1 + Math.floor(rng() * 4) }, () => pick(flowers)))].map((it) => ({ itemId: it.id, qty: 1 + Math.floor(rng() * 15) }));
      const body = { idempotencyKey: newKey('qb'), kind: rng() < 0.35 ? 'showcase' : 'order', lines, ...(rng() < 0.3 ? { allowShort: true, shortComment: 'приход не внесён' } : {}) };
      res = await as(who).post('/api/stock/bouquets', body);
      if (res.status === 201) done.bouquets.push({ id: res.body.bouquet.id, by: who });
      done.requests.push({ user: who, path: '/api/stock/bouquets', body, first: res.status });
    } else if (r < 0.68 && done.bouquets.length) {
      kind = 'sale';
      const b = pick(done.bouquets);
      const withClient = rng() < 0.6;
      const body = { idempotencyKey: newKey('qs'), bouquets: [{ id: b.id }], paymentMethod: 'card', clientId: withClient ? pick(clientIds) : null, redeem: withClient && rng() < 0.3, ...(rng() < 0.25 ? { services: [{ itemId: dlv.id, price: 30_000 }], channel: 'delivery' } : {}) };
      res = await as(who).post('/api/stock/sales', body);
      done.requests.push({ user: who, path: '/api/stock/sales', body, first: res.status });
    } else if (r < 0.76 && done.bouquets.length) {
      kind = 'disassembly';
      const b = pick(done.bouquets);
      res = await as(who).post(`/api/stock/bouquets/${b.id}/disassemble`, { idempotencyKey: newKey('qd'), good: [] });
    } else if (r < 0.88) {
      kind = 'writeoff';
      const it = pick(tracked);
      res = await as(who).post('/api/stock/writeoffs', { idempotencyKey: newKey('qw'), lines: [{ itemId: it.id, qty: 1 + Math.floor(rng() * 12), reason: pick(['wilt', 'damage', 'supplier']) }] });
      if (res.status === 201 && res.body.approval === 'pending') done.writeoffs.push(res.body.docId);
    } else if (r < 0.93 && done.writeoffs.length) {
      kind = 'approval';
      const id = done.writeoffs.splice(Math.floor(rng() * done.writeoffs.length), 1)[0];
      res = await as(OWNER).post(`/api/owner/stock/approvals/${id}`, rng() < 0.5 ? { decision: 'approve' } : { decision: 'reject', reason: 'пересчитали' });
    } else if (r < 0.96 && done.receipts.length) {
      kind = 'receipt cancel';
      res = await as(OWNER).post(`/api/owner/stock/receipts/${pick(done.receipts)}/cancel`, {});
    } else if (r < 0.98 && done.bouquets.length) {
      kind = 'assembly cancel';
      const b = pick(done.bouquets);
      res = await as(b.by).post(`/api/stock/bouquets/${b.id}/cancel`, {});
    } else if (done.requests.length) {
      kind = 'replay';
      const p = pick(done.requests);
      res = await req(p.user, 'POST', p.path, { body: p.body });
      if (p.first === 201 && res.status !== 200) violations.push({ what: 'replay', detail: `${p.path} first 201, replay ${res.status}` });
    } else continue;
    tally(kind, res.status);
    if (i % 50 === 49) {
      invChecks++;
      violations.push(...(await checkStockInvariants()));
    }
  }
  violations.push(...(await checkStockInvariants()));
  s.check(`model run (seed ${seed}, ${ops} ops, ${invChecks + 1} invariant checks): stock invariants hold`, violations.length === 0, violations.slice(0, 6));
  const loyalty = await checkInvariants();
  s.check('loyalty invariants still hold after stock sales', loyalty.length === 0, loyalty.slice(0, 5));
  const stats = await stockStats();
  note('stock', `model run: ${JSON.stringify(stats)}; statuses ${JSON.stringify(Object.fromEntries(statuses))}`);

  // ---------------------------------------------------------------- concurrency
  const c = area('stock: concurrency');
  const euw = tracked.find((i) => i.sku === 'EUW') ?? tracked[0];
  const have = (await as(F1).get(`/api/stock/items/${euw.id}`)).body.qty;
  if (have > 0) await as(OWNER).post('/api/stock/writeoffs', { idempotencyKey: newKey('qw'), lines: [{ itemId: euw.id, qty: have, reason: 'other' }], note: 'обнуление для теста' });
  await as(OWNER).post('/api/stock/receipts', { idempotencyKey: newKey('qr'), currency: 'UZS', priceMode: 'lines', confirm: true, lines: [{ itemId: euw.id, qty: 10, unit: 'base', price: 15_000, per: 'unit' }] });
  const last = await Promise.all(Array.from({ length: 8 }, (_, k) => as(k % 2 ? F1 : F2).post('/api/stock/bouquets', { idempotencyKey: newKey('qc'), kind: 'showcase', lines: [{ itemId: euw.id, qty: 3 }] })));
  c.eq('8 parallel bouquets of 3 on the last 10 stems: 3 succeed, 5 get stock_short', [last.filter((x) => x.status === 201).length, last.filter((x) => x.body?.error?.code === 'stock_short').length], [3, 5]);
  const one = last.find((x) => x.status === 201).body.bouquet.id;
  const sells = await Promise.all(Array.from({ length: 5 }, () => as(F1).post('/api/stock/sales', { idempotencyKey: newKey('qs'), bouquets: [{ id: one }], paymentMethod: 'cash' })));
  c.eq('5 parallel sales of one bouquet: exactly one', [sells.filter((x) => x.status === 201).length, sells.filter((x) => x.body?.error?.code === 'bouquet_state').length], [1, 4]);
  const key = newKey('qk');
  const body = { idempotencyKey: key, kind: 'order', lines: [{ itemId: pick(flowers).id, qty: 1 }], allowShort: true, shortComment: 'тест ключа' };
  const same = await Promise.all(Array.from({ length: 10 }, () => as(F1).post('/api/stock/bouquets', body)));
  const ids = new Set(same.filter((x) => x.status < 300).map((x) => x.body.bouquet.id));
  c.eq('same key ×10 in parallel: one bouquet, the rest replay or «ещё проводится»', [ids.size, same.every((x) => [200, 201, 409].includes(x.status))], [1, true]);
  const v2 = await checkStockInvariants();
  c.check('invariants after the concurrency checks', v2.length === 0, v2.slice(0, 5));

  // ---------------------------------------------------------------- fuzz
  const f = area('stock: fuzz');
  const junk = [null, 0, -1, 1.5, 1e20, '12', '', 'x'.repeat(5000), [], {}, true, '<script>alert(1)</script>', "'; DROP TABLE stock_moves; --", '=HYPERLINK("x")'];
  const fr = mulberry32(seed + 1);
  const fj = () => junk[Math.floor(fr() * junk.length)];
  let sent = 0;
  const posts = [...STOCK_ROUTES, ...OWNER_ROUTES].filter(([m]) => m !== 'GET');
  for (let i = 0; i < 500; i++) {
    const [m, p] = posts[Math.floor(fr() * posts.length)];
    const realPath = p.replace('/x', `/${fr() < 0.5 ? one : fj()}`).replace(/\/(null|undefined|)$/, '/x');
    const shapes = [
      () => fj(),
      () => ({ idempotencyKey: fr() < 0.5 ? newKey('fz') : fj(), lines: [{ itemId: fr() < 0.5 ? pick(tracked).id : fj(), qty: fj(), price: fj(), unit: fj(), per: fj(), reason: fj() }], currency: fj(), priceMode: fj(), total: fj(), fxRate: fj() }),
      () => ({ idempotencyKey: newKey('fz'), lines: Array.from({ length: 70 }, () => ({ itemId: pick(tracked).id, qty: 1 })), bouquets: [{ id: fj() }], clientId: fj(), decision: fj() }),
      () => ({ idempotencyKey: newKey('fz'), bouquets: [{ id: one, price: fj() }], services: [{ itemId: fj(), price: fj() }], paymentMethod: fj(), on: fj(), good: [{ itemId: fj(), qty: fj() }] }),
    ];
    const bodyF = shapes[Math.floor(fr() * shapes.length)]();
    const user = fr() < 0.8 ? OWNER : F1;
    const r2 = await req(user, m, realPath, { rawBody: typeof bodyF === 'string' && fr() < 0.3 ? bodyF : undefined, body: typeof bodyF === 'string' && fr() < 0.3 ? undefined : bodyF ?? {}, headers: { 'content-type': 'application/json' } });
    if (r2.status >= 500) f.check(`${m} ${realPath} → ${r2.status}`, false, r2.text.slice(0, 200));
    sent++;
  }
  f.check(`${sent} junk requests to stock routes: no 5xx (contract checked globally)`, true);
  const v3 = await checkStockInvariants();
  f.check('invariants after fuzz', v3.length === 0, v3.slice(0, 5));

  // ---------------------------------------------------------------- roles + flag
  const rl = area('stock: roles');
  const CL = CLIENTS[0];
  let wrong = [];
  for (const [m, p] of [...STOCK_ROUTES, ...OWNER_ROUTES]) {
    const r3 = await req(CL, m, p, { body: m === 'GET' ? undefined : {} });
    if (r3.status !== 403) wrong.push(`client ${m} ${p} → ${r3.status}`);
  }
  for (const [m, p] of OWNER_ROUTES) {
    const r3 = await req(F1, m, p, { body: m === 'GET' ? undefined : {} });
    if (r3.status !== 403) wrong.push(`florist ${m} ${p} → ${r3.status}`);
  }
  rl.check(`client 403 on all ${STOCK_ROUTES.length + OWNER_ROUTES.length} stock routes, florist 403 on ${OWNER_ROUTES.length} owner-only`, wrong.length === 0, wrong.slice(0, 6));
  try {
    ctx.base = await restartWorker({ testMode: '1', stockEnabled: '0' });
    wrong = [];
    for (const [m, p] of [...STOCK_ROUTES, ...OWNER_ROUTES]) {
      const r4 = await req(OWNER, m, p, { body: m === 'GET' ? undefined : {} });
      if (r4.status !== 404) wrong.push(`${m} ${p} → ${r4.status}`);
    }
    rl.check('STOCK_ENABLED=0: every stock route is 404', wrong.length === 0, wrong.slice(0, 6));
  } finally {
    ctx.base = await restartWorker({ testMode: '1' });
  }

  // ---------------------------------------------------------------- Mini App
  const ma = area('stock: mini app');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'apps', 'miniapp', 'test', 'e2e-stock.js')], { cwd: path.join(ROOT, 'apps', 'miniapp'), env: { ...process.env, E2E_BASE: ctx.base, E2E_TEST_KEY: ctx.key } });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    const t = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.on('close', (status) => { clearTimeout(t); resolve({ status, o }); });
  });
  const m2 = /(\d+)\/(\d+) passed/.exec(out.o);
  ma.check(`stock jsdom smoke: ${m2 ? `${m2[1]}/${m2[2]}` : 'no result'}`, out.status === 0 && !!m2, out.o.split('\n').filter((l) => /FAIL|CRASH/.test(l)).join(' | ').slice(0, 600));
  const v4 = await checkStockInvariants();
  ma.check('invariants after the Mini App run', v4.length === 0, v4.slice(0, 5));
  return { seed, ops, ...stats };
}
