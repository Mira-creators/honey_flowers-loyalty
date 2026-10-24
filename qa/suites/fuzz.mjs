// Fuzz / bad input on every endpoint (enumerated from apps/worker/src/routes/*.ts + app.ts).
// Expectation for anything invalid: 4xx with { error: { code, message } } (Russian message), never 5xx,
// no stack trace, and NO state change (fingerprint of all business tables before == after).
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { as, clock, d1Of, newKey, register, req, setRole, sql, wipe, ctx } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { checkInvariants, fingerprint } from '../lib/invariants.mjs';
import { BOT_TOKEN, ROOT, SETUP_KEY, WEBHOOK_SECRET } from '../lib/worker.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101, CLIENT = 900_300_001, NOBODY = 900_300_999;

// ------------------------------------------------------------ route enumeration
const MOUNTS = { clientRoutes: '/api', staffRoutes: '/api/staff', ownerRoutes: '/api/owner', ownerClientRoutes: '/api/owner', testRoutes: '/api/test', ownerConsoleRoutes: '/api/owner', webRoutes: '/api/web', ownerGrantRoutes: '/api/owner', demoRoutes: '/api/test' };
export function enumerateRoutes() {
  const dir = path.join(ROOT, 'apps', 'worker', 'src', 'routes');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(\w+Routes)\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
      const base = MOUNTS[m[1]];
      if (!base) continue;
      out.push({ method: m[2].toUpperCase(), path: (base + (m[3] === '/' ? '' : m[3])).replace(/\/+$/, '') });
    }
  }
  const app = fs.readFileSync(path.join(ROOT, 'apps', 'worker', 'src', 'app.ts'), 'utf8');
  for (const m of app.matchAll(/app\.(get|post)\('(\/(?:health|setup|telegram\/webhook|api\/web\/session))'/g)) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}

// ------------------------------------------------------------ values
const BIG = 'я'.repeat(10_000);
const VALUES = [
  ['missing', undefined], ['null', null], ['true', true], ['false', false], ['0', 0], ['-1', -1], ['1.5', 1.5], ['-0.0001', -0.0001],
  ['1e21', 1e21], ['2^53+1', 9007199254740993], ['-2^53', -9007199254740992], ['empty string', ''], ['space', ' '], ['"100"', '100'],
  ['"1e309"', '1e309'], ['"NaN"', 'NaN'], ['10k string', BIG], ['sqli', "' OR 1=1; DROP TABLE clients; --"], ['rtl', '‮تست‬'],
  ['emoji', '🌸💥👩‍👩‍👧'], ['nul', 'a\u0000b'], ['array', []], ['object', {}], ['array2', [1, 2]], ['mongo', { $gt: '' }], ['html', '<script>alert(1)</script>'],
];
// Raw JSON number tokens that JSON.stringify cannot produce.
const RAW_NUMBERS = ['1e309', '-1e309', 'NaN', 'Infinity', '-Infinity', '1e-400', '0x10', '01', '1_000', '+1', '.5', '1.', '9'.repeat(400)];
const RAW_BODIES = [
  ['empty', ''], ['space', ' '], ['{', '{'], ['}', '}'], ['broken', '{"a":}'], ['null', 'null'], ['true', 'true'], ['[]', '[]'], ['"x"', '"x"'], ['123', '123'],
  ['proto', '{"__proto__":{"role":"owner"},"constructor":{"prototype":{"x":1}}}'], ['bom', '﻿{}'], ['trailing', '{} {}'], ['comment', '{/*x*/}'],
  ['deep', '['.repeat(50_000) + ']'.repeat(50_000)], ['deepobj', '{"a":'.repeat(20_000) + '1' + '}'.repeat(20_000)],
  ['1MB', JSON.stringify({ pad: 'x'.repeat(1_000_000) })], ['invalid utf8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
];
const PATH_IDS = [
  ['nonexistent', 'does-not-exist'], ['uuid', '00000000-0000-0000-0000-000000000000'], ['10k', 'x'.repeat(10_000)], ['sqli', encodeURIComponent("' OR '1'='1")],
  ['emoji', encodeURIComponent('🌸')], ['nul', '%00'], ['traversal', '..%2F..%2Fsetup'], ['rtl', encodeURIComponent('‮')], ['percent', '%E0%A4%A'],
];

export async function run() {
  const z = area('fuzz');
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  const cl = await register(CLIENT, 'Фазз Клиент', '+998901110000');
  // a gift + purchases to have real ids
  let giftId = null, purchaseId = null;
  for (let d = 0; d < 3; d++) {
    const r = await as(FLORIST).post('/api/staff/purchase', { clientId: cl.id, amount: 150_000, redeem: false, idempotencyKey: newKey('fz') });
    purchaseId = purchaseId ?? r.body.purchaseId;
    giftId = r.body.giftsUnlocked[0]?.id ?? giftId;
    await clock(1);
  }
  const staff = await as(OWNER).post('/api/owner/staff', { phoneOrTelegramId: '+998 91 000 00 01', role: 'florist' });
  const staffId = staff.body.id;
  const rules = (await as(OWNER).get('/api/owner/rules')).body;

  const routes = enumerateRoutes();
  const key = (r) => `${r.method} ${r.path}`;
  const expected = [
    'GET /api/me', 'POST /api/me/lang', 'GET /api/staff/client', 'POST /api/staff/purchase/preview', 'POST /api/staff/purchase', 'POST /api/staff/purchase/:id/reverse',
    'POST /api/staff/gift/:id/use', 'GET /api/staff/recent', 'GET /api/owner/stats', 'GET /api/owner/rules', 'PUT /api/owner/rules', 'GET /api/owner/staff', 'POST /api/owner/staff',
    'DELETE /api/owner/staff/:id', 'GET /api/owner/operations', 'GET /api/owner/clients', 'GET /api/owner/clients/:id', 'POST /api/owner/clients/:id/adjust',
    'PUT /api/owner/clients/:id/note', 'GET /api/owner/export/clients.csv', 'GET /api/owner/export/operations.csv', 'POST /api/owner/export/link', 'POST /api/test/role',
    'POST /api/test/clock', 'POST /api/test/run-expiry', 'POST /api/test/reset-me', 'POST /api/test/register', 'GET /health', 'GET /setup', 'POST /telegram/webhook',
    // owner console, browser session, import, owner grant, history pages, demo data
    'POST /api/owner/web-link', 'POST /api/web/session', 'GET /api/web/me', 'POST /api/web/logout', 'GET /api/owner/console/overview', 'GET /api/owner/console/clients',
    'GET /api/owner/console/operations', 'GET /api/owner/console/cohorts', 'POST /api/owner/import', 'GET /api/owner/import/batches', 'POST /api/owner/import/:id/undo',
    'GET /api/owner/clients/:id/history', 'POST /api/owner/clients/:id/grant', 'POST /api/test/demo-seed', 'POST /api/test/demo-clear',
  ];
  const found = routes.map(key);
  z.check('route enumeration found every known endpoint', expected.every((e) => found.includes(e)), expected.filter((e) => !found.includes(e)));
  z.check('no unknown (untested) endpoints', found.every((e) => expected.includes(e)), found.filter((e) => !expected.includes(e)));

  // who may call what + a valid body template
  const caller = (p) => (p === '/api/web/session' ? null : p.startsWith('/api/owner') || p.startsWith('/api/web') ? OWNER : p.startsWith('/api/staff') ? FLORIST : p.startsWith('/api/test') ? NOBODY : CLIENT);
  const fill = (p, id) => p.replace(':id', id);
  const ids = { '/api/staff/purchase/:id/reverse': purchaseId, '/api/staff/gift/:id/use': giftId, '/api/owner/staff/:id': staffId, '/api/owner/clients/:id': cl.id, '/api/owner/clients/:id/adjust': cl.id, '/api/owner/clients/:id/note': cl.id, '/api/owner/clients/:id/history': cl.id, '/api/owner/clients/:id/grant': cl.id, '/api/owner/import/:id/undo': 'qa-no-such-batch' };
  const templates = {
    'POST /api/me/lang': { lang: 'ru' },
    'POST /api/staff/purchase/preview': { clientId: cl.id, amount: 100_000, redeem: false, giftId: null, channel: 'store' },
    'POST /api/staff/purchase': { clientId: cl.id, amount: 100_000, redeem: false, giftId: null, channel: 'store', idempotencyKey: 'fuzz-key-00000001' },
    'POST /api/staff/purchase/:id/reverse': { reason: 'Причина отмены' },
    'POST /api/staff/gift/:id/use': {},
    'PUT /api/owner/rules': rules,
    'POST /api/owner/staff': { phoneOrTelegramId: '+998 91 000 00 02', role: 'florist', name: 'Новый' },
    'POST /api/owner/clients/:id/adjust': { points: 100, reason: 'Причина', idempotencyKey: 'fuzz-adjust-0001' },
    'PUT /api/owner/clients/:id/note': { note: 'Заметка' },
    'POST /api/owner/export/link': { kind: 'operations', from: '2026-01-01', to: '2026-12-31' },
    'POST /api/test/role': { role: 'client' },
    'POST /api/test/clock': { days: 0 },
    'POST /api/test/register': { phone: '+998 90 999 88 77', name: 'Фазз' },
    'POST /api/owner/clients/:id/grant': { kind: 'honey', points: 100, reason: 'Причина', idempotencyKey: 'fuzz-grant-0001' },
    // dryRun: an accepted mutation must not create clients
    'POST /api/owner/import': { batchId: 'fuzz-import-0001', fileName: 'f.csv', dryRun: true, options: { creditBalance: true, levelFromTotal: false, cellsFromCount: false }, rows: [{ line: 2, phone: '+998905550101', name: 'Фазз', balance: 100 }], skipped: 0 },
    'POST /api/web/session': { token: 'fuzz-token-0000000000000000' },
    'POST /api/owner/web-link': {},
  };
  const queries = {
    'GET /api/staff/client': { q: 'HF1234' },
    'GET /api/owner/operations': { limit: '10' },
    'GET /api/owner/clients': { q: 'а', level: 'bee', status: 'active', sort: 'name', limit: '5' },
    'GET /api/owner/export/operations.csv': { from: '2026-01-01', to: '2026-01-31' },
    'GET /setup': { key: SETUP_KEY },
    'GET /api/owner/console/overview': { from: '2026-01-01', to: '2026-01-31' },
    'GET /api/owner/console/clients': { sort: 'total', dir: 'asc', limit: '5', minCount: '1', activity: 'active', bmonth: '3', q: 'а' },
    'GET /api/owner/console/operations': { from: '2026-01-01', to: '2026-01-31', kinds: 'purchase,redeem', limit: '5', minAmount: '1', totals: '1' },
    'GET /api/owner/console/cohorts': { months: '6' },
    'GET /api/owner/clients/:id/history': { cursor: '' },
  };

  let sent = 0;
  const accepted = [];
  let fp = await fingerprint();
  /** Send one fuzz request; when it is rejected the DB must not have changed. */
  async function probe(label, user, method, p, opts = {}) {
    const r = await req(user, method, p, { ...opts, allowNonJsonError: opts.allowNonJsonError ?? !p.startsWith('/api/') });
    sent++;
    await d1Of(r.id); // background work (notifications log) of this request must be finished
    if (!opts.allow5xx) z.check(`${label}: no 5xx`, r.status < 500 && r.status !== 0, `${r.status} ${r.text.slice(0, 200)}`);
    const after = await fingerprint();
    if (r.status >= 400) {
      const same = JSON.stringify(after) === JSON.stringify(fp);
      z.check(`${label}: rejected (${r.status}) without state change`, same, same ? '' : diff(fp, after));
    } else accepted.push(`${label} → ${r.status}`);
    fp = after;
    return r;
  }
  const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${String(a[k]).slice(0, 60)} → ${String(b[k]).slice(0, 60)}`).join('; ');

  // ---------------- 1. authentication on every /api route
  const tmaFor = async (fields, token = BOT_TOKEN) => {
    const params = new URLSearchParams(fields);
    const enc = new TextEncoder();
    const k1 = await webcrypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = new Uint8Array(await webcrypto.subtle.sign('HMAC', k1, enc.encode(token)));
    const k2 = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    params.set('hash', Buffer.from(await webcrypto.subtle.sign('HMAC', k2, enc.encode(dcs))).toString('hex'));
    return params.toString();
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 5_000_001, first_name: 'Подделка' });
  const badAuth = [
    ['no auth', {}],
    ['wrong X-Test-Key', { 'x-test-user': String(OWNER), 'x-test-key': 'wrong' }],
    ['X-Test-Key missing', { 'x-test-user': String(OWNER) }],
    ['X-Test-User < 900000000 (real id)', { 'x-test-user': '123456', 'x-test-key': ctx.key }],
    ['X-Test-User not a number', { 'x-test-user': 'abc', 'x-test-key': ctx.key }],
    ['X-Test-User float', { 'x-test-user': '900000000.5', 'x-test-key': ctx.key }],
    ['tma garbage', { authorization: 'tma garbage' }],
    ['tma no hash', { authorization: 'tma user=%7B%22id%22%3A1%7D&auth_date=' + nowSec }],
    ['tma bad hash', { authorization: `tma auth_date=${nowSec}&user=${encodeURIComponent(user)}&hash=${'0'.repeat(64)}` }],
    ['tma signed with another token', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec), user }, '999:other')) }],
    ['tma expired (2 days)', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec - 2 * 86_400), user })) }],
    ['tma future auth_date', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec + 3_600), user })) }],
    ['tma valid signature, user not JSON', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec), user: '{oops' })) }],
    ['tma valid signature, no user', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec) })) }],
    ['tma valid signature, user.id string', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec), user: '{"id":"1"}' })) }],
    ['tma tampered user (re-ordered fields)', { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec), user })).replace('5000001', '5000002') }],
    ['Bearer token', { authorization: 'Bearer abc' }],
  ];
  for (const r of routes.filter((x) => x.path.startsWith('/api/'))) {
    const p = fill(r.path, ids[r.path] ?? 'x');
    for (const [label, headers] of badAuth) {
      const res = await probe(`${r.method} ${r.path} [${label}]`, null, r.method, p, { headers, body: templates[`${r.method} ${r.path}`] });
      z.check(`${r.method} ${r.path} [${label}] → 401`, res.status === 401, `${res.status}`);
    }
  }
  const okTma = await req(null, 'GET', '/api/me', { headers: { authorization: 'tma ' + (await tmaFor({ auth_date: String(nowSec), user })) } });
  z.eq('tma with a valid signature → 200 (control)', okTma.status, 200);

  // ---------------- 2. wrong role
  for (const r of routes.filter((x) => x.path.startsWith('/api/staff') || x.path.startsWith('/api/owner'))) {
    const p = fill(r.path, ids[r.path] ?? 'x');
    const users = r.path.startsWith('/api/owner') ? [CLIENT, FLORIST] : [CLIENT];
    for (const u of users) {
      const res = await probe(`${r.method} ${r.path} as ${u === CLIENT ? 'client' : 'florist'}`, u, r.method, p, { body: templates[`${r.method} ${r.path}`] });
      z.check(`${r.method} ${r.path} as ${u === CLIENT ? 'client' : 'florist'} → 403`, res.status === 403, `${res.status}`);
    }
  }

  // ---------------- 3. wrong methods
  for (const r of routes) {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      if (routes.some((x) => x.path === r.path && x.method === m)) continue;
      const p = fill(r.path, ids[r.path] ?? 'x');
      const res = await probe(`${m} ${r.path} (wrong method)`, caller(r.path), m, p, { body: m === 'GET' || m === 'DELETE' ? undefined : {}, headers: r.path === '/telegram/webhook' ? { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET } : {} });
      z.check(`${m} ${r.path} (wrong method) → 4xx`, res.status >= 400 && res.status < 500, `${res.status}`);
    }
  }

  // ---------------- 4. bodies: raw garbage + per-field mutations
  for (const [k, tpl] of Object.entries(templates)) {
    const [method, rp] = k.split(' ');
    const p = fill(rp, ids[rp] ?? 'x');
    const u = caller(rp);
    for (const [label, raw] of RAW_BODIES) {
      const res = await probe(`${k} raw body ${label}`, u, method, p, { rawBody: raw, headers: { 'content-type': 'application/json' } });
      if (Object.keys(tpl).length) z.check(`${k} raw body ${label} → 4xx`, res.status >= 400 && res.status < 500, `${res.status} ${res.text.slice(0, 120)}`);
    }
    for (const field of Object.keys(tpl)) {
      for (const [label, val] of VALUES) {
        const body = structuredClone(tpl);
        if (val === undefined) delete body[field];
        else body[field] = val;
        if (k === 'POST /api/staff/purchase') body.idempotencyKey = field === 'idempotencyKey' ? body.idempotencyKey : newKey('fz');
        if ((k === 'POST /api/owner/clients/:id/adjust' || k === 'POST /api/owner/clients/:id/grant') && field !== 'idempotencyKey') body.idempotencyKey = newKey('fz');
        const res = await probe(`${k} ${field}=${label}`, u, method, p, { body });
        if (k === 'PUT /api/owner/rules' && res.status === 200) templates[k].version = res.body.version;
      }
      if (typeof tpl[field] === 'number' || typeof tpl[field] === 'boolean') {
        for (const tok of RAW_NUMBERS) {
          const body = { ...tpl, ...(k === 'POST /api/staff/purchase' ? { idempotencyKey: newKey('fz') } : {}) };
          const raw = JSON.stringify({ ...body, [field]: '__RAW__' }).replace('"__RAW__"', tok);
          const res = await probe(`${k} ${field}=${tok} (raw)`, u, method, p, { rawBody: raw, headers: { 'content-type': 'application/json' } });
          if (tok !== '1e-400') z.check(`${k} ${field}=${tok.slice(0, 12)} (raw) → 4xx`, res.status >= 400 && res.status < 500, `${res.status}`);
        }
      }
    }
  }
  // rules editor: nested fields
  Object.assign(rules, (await as(OWNER).get('/api/owner/rules')).body);
  const rulesMut = [
    ['levels empty', { levels: [] }], ['levels 6', { levels: Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, name: 'x', pct: 1, from: i * 10 })) }],
    ['first level from 100', { levels: [{ id: 'a', name: 'a', pct: 1, from: 100 }] }], ['thresholds not ascending', { levels: [{ id: 'a', name: 'a', pct: 1, from: 0 }, { id: 'b', name: 'b', pct: 2, from: 0 }] }],
    ['duplicate level ids', { levels: [{ id: 'a', name: 'a', pct: 1, from: 0 }, { id: 'a', name: 'b', pct: 2, from: 5 }] }], ['pct 101', { levels: [{ id: 'a', name: 'a', pct: 101, from: 0 }] }],
    ['pct 3 decimals', { levels: [{ id: 'a', name: 'a', pct: 1.234, from: 0 }] }], ['pct -1', { levels: [{ id: 'a', name: 'a', pct: -1, from: 0 }] }], ['level id cyrillic', { levels: [{ id: 'пчела', name: 'a', pct: 1, from: 0 }] }],
    ['gift cell 0', { gifts: { 0: 'card' } }], ['gift cell 11', { gifts: { 11: 'card' } }], ['gift cell "05" + "5"', { gifts: { '05': 'card', 5: 'mini' } }], ['gift disc0', { gifts: { 3: 'disc0' } }], ['gift disc100', { gifts: { 3: 'disc100' } }],
    ['gift unknown code', { gifts: { 3: 'iphone' } }], ['gifts array', { gifts: ['card'] }], ['cells 12', { cells: 12 }], ['expiryDays 0', { expiryDays: 0 }], ['warn ≥ expiry', { expiryDays: 10, expiryWarnDays: [10] }],
    ['warn duplicate', { expiryWarnDays: [7, 7] }], ['warn 6 items', { expiryWarnDays: [1, 2, 3, 4, 5, 6] }], ['maxCellsPerDay 0', { maxCellsPerDay: 0 }], ['maxRedeemPct 100.5', { maxRedeemPct: 100.5 }], ['maxRedeemPct 33.333', { maxRedeemPct: 33.333 }],
    ['welcomeBonus -1', { welcomeBonus: -1 }], ['version 0', { version: 0 }], ['version string', { version: String(rules.version) }], ['level name 41', { levels: [{ id: 'a', name: 'я'.repeat(41), pct: 1, from: 0 }] }],
  ];
  for (const [label, patch] of rulesMut) {
    const res = await probe(`PUT /api/owner/rules ${label}`, OWNER, 'PUT', '/api/owner/rules', { body: { ...rules, ...patch } });
    z.check(`PUT /api/owner/rules ${label} → 400/409`, res.status === 400 || res.status === 409, `${res.status} ${res.text.slice(0, 160)}`);
  }

  // ---------------- 5. query strings
  for (const [k, tpl] of Object.entries(queries)) {
    const [method, p] = k.split(' ');
    for (const field of Object.keys(tpl)) {
      for (const [label, val] of [...VALUES.filter(([, v]) => typeof v === 'string' || v === undefined), ['1e309', '1e309'], ['-5', '-5'], ['repeat', '__REPEAT__']]) {
        const qs = new URLSearchParams(tpl);
        if (val === undefined) qs.delete(field);
        else if (val === '__REPEAT__') qs.append(field, tpl[field]);
        else qs.set(field, val);
        await probe(`${k}?${field}=${label}`, caller(p), method, `${fill(p, ids[p] ?? 'x')}?${qs}`, { allowNonJsonError: !p.startsWith('/api/') });
      }
    }
  }
  for (const t of ['', 'x', 'g'.repeat(5000), "' OR 1=1 --", '%00']) {
    const res = await probe(`export token=${t.slice(0, 10)}`, null, 'GET', `/api/owner/export/clients.csv?token=${encodeURIComponent(t)}`, { allowNonJsonError: true });
    z.check(`export with bad token "${t.slice(0, 10)}" → 401/410`, res.status === 410 || res.status === 401, `${res.status}`);
  }
  for (const f of ['staff.csv', 'clients.csv.bak', '..%2F..%2Fsetup']) {
    const link = await as(OWNER).post('/api/owner/export/link', { kind: 'clients' });
    const tok = new URL(link.body.url).searchParams.get('token');
    fp = await fingerprint();
    const res = await probe(`export /${f}?token=valid`, null, 'GET', `/api/owner/export/${f}?token=${tok}`, { allowNonJsonError: true });
    z.check(`export /${f} with a valid token → 4xx`, res.status >= 400 && res.status < 500, `${res.status}`);
  }

  // ---------------- 6. path params
  for (const r of routes.filter((x) => x.path.includes(':id'))) {
    for (const [label, val] of PATH_IDS) {
      const res = await probe(`${r.method} ${r.path} id=${label}`, caller(r.path), r.method, fill(r.path, val), { body: templates[`${r.method} ${r.path}`] });
      z.check(`${r.method} ${r.path} id=${label} → 4xx`, res.status >= 400 && res.status < 500, `${res.status} ${res.text.slice(0, 100)}`);
    }
  }

  // ---------------- 7. headers: names and lengths
  for (const [label, name] of [['long name', encodeURIComponent('Я'.repeat(1_000))], ['bad %', '%E0%A4%A'], ['emoji', encodeURIComponent('🌸')], ['rtl', encodeURIComponent('‮admin')]]) {
    const res = await probe(`GET /api/me with X-Test-Name ${label}`, 900_300_500, 'GET', '/api/me', { name, headers: { 'x-test-name': name } });
    z.check(`X-Test-Name ${label} → 200`, res.status === 200, `${res.status}`);
  }

  // ---------------- 8. webhook and setup
  const wh = (body, secret = WEBHOOK_SECRET, raw) => probe(`webhook ${typeof body === 'string' ? body.slice(0, 20) : JSON.stringify(body).slice(0, 40)}`, null, 'POST', '/telegram/webhook', { headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, ...(raw !== undefined ? { rawBody: raw } : { body }), allowNonJsonError: true });
  z.eq('webhook without secret → 401', (await wh({ update_id: 1 }, null)).status, 401);
  z.eq('webhook wrong secret → 401', (await wh({ update_id: 1 }, 'nope')).status, 401);
  for (const raw of ['', '{', 'null', '[]', '{"update_id":"x"}', '{"update_id":1,"message":null}', '{"update_id":2,"message":{"text":"/start"}}', '{"update_id":3,"message":{"chat":{"id":1,"type":"private"},"from":{"id":1,"is_bot":false,"first_name":"x"},"date":1,"message_id":1,"contact":{"phone_number":"' + 'ф'.repeat(5000) + '","first_name":"x","user_id":1}}}', '{"update_id":4,"message":{"chat":{"id":2,"type":"private"},"from":{"id":2,"is_bot":false,"first_name":"x"},"date":1,"message_id":1,"contact":{"phone_number":"+998901110000","first_name":"x","user_id":2}}}', '{"update_id":5,"callback_query":{"id":"1","from":{"id":3,"is_bot":false,"first_name":"x"},"data":"lang:xx","chat_instance":"1"}}']) {
    const res = await wh(null, WEBHOOK_SECRET, raw);
    z.check(`webhook body ${raw.slice(0, 30)} → no 5xx`, res.status < 500, `${res.status} ${res.text.slice(0, 120)}`);
  }
  z.eq('setup wrong key → 403', (await probe('setup wrong key', null, 'GET', '/setup?key=nope')).status, 403);
  for (const o of ['901234567', 'id:abc', 'id:0', '+1', "'; DROP TABLE staff; --", 'id:' + '9'.repeat(30)]) {
    const res = await probe(`setup owner=${o.slice(0, 12)}`, null, 'GET', `/setup?key=${SETUP_KEY}&owner=${encodeURIComponent(o)}`, { allow5xx: true });
    z.check(`setup owner=${o.slice(0, 12)} → not 5xx and no owner created`, res.status < 500 || res.status === 502, `${res.status} ${res.text.slice(0, 200)}`);
  }
  const owners = await sql(`SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'`);
  z.eq('setup with bad owner values created no owner', owners[0].n, 0);

  // ---------------- 8b. staff target parsing: non-numeric "ids" must not become some other Telegram id
  for (const v of ['@ivan_2002', 'abc123', 'id:12a', '1e+21']) {
    const res = await probe(`POST /api/owner/staff phoneOrTelegramId=${v}`, OWNER, 'POST', '/api/owner/staff', { body: { phoneOrTelegramId: v, role: 'florist' } });
    z.check(`staff add "${v}" → 400 (not read as a Telegram id)`, res.status === 400, `${res.status} ${res.text.slice(0, 160)}`);
  }
  const big = await probe('POST /api/owner/staff phoneOrTelegramId=1e21 (number)', OWNER, 'POST', '/api/owner/staff', { rawBody: '{"phoneOrTelegramId":1e21,"role":"florist"}', headers: { 'content-type': 'application/json' } });
  z.check('staff add 1e21 (JSON number) → 400', big.status === 400, `${big.status} ${big.text.slice(0, 160)}`);

  // ---------------- 9. clock and test endpoints edge values
  const offset = (await as(NOBODY).get('/api/me')).body.clockOffsetDays;
  for (const days of [-(offset + 1), 3651 - offset, 1e9, 0.5]) {
    const res = await probe(`clock days=${days}`, NOBODY, 'POST', '/api/test/clock', { body: { days } });
    z.check(`clock days=${days} → 400`, res.status === 400, `${res.status}`);
  }

  console.log(`  fuzz: ${sent} requests, ${accepted.length} accepted (2xx)`);
  const suspicious = accepted.filter((a) => !a.includes('?') && /(amount|points|days|limit|version)=(1\.5|-0\.0001|"100"|true|false|1e21|2\^53\+1)/.test(a));
  z.check('no invalid numeric value was accepted', suspicious.length === 0, suspicious.slice(0, 10));
  const v = await checkInvariants();
  z.check('invariants after fuzzing', v.length === 0, v.slice(0, 5));
  if (accepted.length) note('info', `fuzz: ${accepted.length} mutated requests were accepted (2xx), e.g. ${accepted.filter((a) => !a.includes('wrong method')).slice(0, 6).join(' | ')}`);
  return { requests: sent, accepted: accepted.length, acceptedList: accepted };
}
