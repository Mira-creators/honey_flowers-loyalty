// Owner's client base: status filters, sorts, search, cursor paging stability, CSV exports.
import { as, clock, ctx, newKey, req, runExpiryAll, setRole, sql, wipe } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { checkInvariants } from '../lib/invariants.mjs';
import { parseCsv } from '../lib/csv.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101;
let userSeq = 900_100_000;

async function reg(name, phone) {
  const user = ++userSeq;
  const r = await as(user).post('/api/test/register', { phone: phone ?? `+99897${String(user).slice(-7)}`, name });
  if (r.status !== 201) throw new Error(`register ${name}: ${r.status} ${r.text}`);
  return { user, id: r.body.client.id, code: r.body.client.code, name: r.body.client.name };
}

async function buy(clientId, amount) {
  const r = await as(FLORIST).post('/api/staff/purchase', { clientId, amount, redeem: false, idempotencyKey: newKey('cl') });
  if (r.status !== 201) throw new Error(`buy: ${r.status} ${r.text}`);
  return r.body;
}

async function listAll(params, limit = 100) {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 200; i++) {
    const qs = new URLSearchParams({ ...params, limit: String(limit), ...(cursor ? { cursor } : {}) });
    const r = await as(OWNER).get('/api/owner/clients?' + qs);
    if (r.status !== 200) throw new Error(`list ${qs}: ${r.status} ${r.text}`);
    items.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return items;
}

const utf8cmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export const SPECIAL_NAMES = [
  'Дилноза', 'Oʻgʻiloy', 'G’ulom', 'Anvar; "Big" boss', 'Строка1\nСтрока2', 'Гуль 🌸 Emoji', '=HYPERLINK("http://evil.example","x")',
  '+SUM(1;2)', '@cmd', "O'Reilly", 'שלום ‮טקסט', 'Ёлка Ёжикова', 'a'.repeat(60),
];

export async function run() {
  const s = area('clients list & export');
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');

  // ---------------------------------------------------------------- status timeline
  const lost = await reg('Потерянный Клиент');
  const expg = await reg('Сгорающий Клиент');
  const sleep = await reg('Спящий Клиент');
  const act = await reg('Активный Клиент');
  const never = await reg('Без Покупок');
  await buy(lost.id, 300_000); // day 0  → T-95
  await clock(10);
  await buy(expg.id, 400_000); // day 10 → T-85
  await clock(20);
  await buy(sleep.id, 500_000); // day 30 → T-65
  await clock(65);
  await buy(act.id, 600_000); // day 95 = T
  await runExpiryAll();
  const ids = (items) => items.map((i) => i.id).sort();
  const expect = {
    active: [act.id, sleep.id, expg.id],
    sleeping: [sleep.id, expg.id],
    lost: [lost.id, never.id],
    expiring: [expg.id],
  };
  for (const [st, want] of Object.entries(expect)) {
    const got = await listAll({ status: st });
    s.eq(`filter status=${st}`, ids(got), [...want].sort());
  }
  const lostRow = (await listAll({ status: 'lost' })).find((i) => i.id === lost.id);
  s.eq('lost client: burned by the daily job (balance 0, expiresOn null)', [lostRow.balance, lostRow.expiresOn], [0, null]);
  const lvl = await listAll({ level: 'bee' });
  s.eq('filter level=bee → all 5', lvl.length, 5);
  s.eq('filter level=queen → none', (await listAll({ level: 'queen' })).length, 0);
  s.eq('filter status=bogus → 400', (await as(OWNER).get('/api/owner/clients?status=bogus')).status, 400);
  s.eq('sort=bogus → 400', (await as(OWNER).get('/api/owner/clients?sort=bogus')).status, 400);
  for (const l of ['0', '101', '-1', 'abc', '1e309', '2.5']) s.eq(`limit=${l} → 400`, (await as(OWNER).get('/api/owner/clients?limit=' + l)).status, 400);
  s.eq('limit=100 → 200', (await as(OWNER).get('/api/owner/clients?limit=100')).status, 200);

  // ---------------------------------------------------------------- special names, search
  const special = [];
  for (const [i, name] of SPECIAL_NAMES.entries()) {
    const c = await reg(name);
    special.push(c);
    if (i % 2 === 0) await buy(c.id, 100_000 + i * 1_000);
  }
  await as(OWNER).put(`/api/owner/clients/${special[0].id}/note`, { note: 'Заметка; с "кавычками"\nи переносом 🌸 ʻ’' });
  for (const [q, want] of [['дилноза', 'Дилноза'], ['ДИЛНОЗА', 'Дилноза'], ['ноза', 'Дилноза'], ['oʻgʻiloy', 'Oʻgʻiloy'], ['g’ulom', 'G’ulom'], ['ёлка', 'Ёлка Ёжикова'], ['🌸', 'Гуль 🌸 Emoji'], ['big', 'Anvar; "Big" boss'], ['; "', 'Anvar; "Big" boss']]) {
    const r = await as(OWNER).get('/api/owner/clients?q=' + encodeURIComponent(q));
    s.check(`search "${q}" finds ${want}`, r.status === 200 && r.body.items.some((i) => i.name === want), `${r.status} ${r.body?.items?.map((i) => i.name)}`);
  }
  const code = special[1].code;
  const byCode = await as(OWNER).get('/api/owner/clients?q=' + code.toLowerCase());
  s.eq('search by code (case-insensitive) → exactly that client', byCode.body.items.map((i) => i.id), [special[1].id]);
  const phone = (await sql('SELECT phone FROM clients WHERE id = ?', [special[2].id]))[0].phone;
  const byPhone = await as(OWNER).get('/api/owner/clients?q=' + encodeURIComponent(phone.slice(-7, -2)));
  s.check('search by 5 phone digits', byPhone.body.items.some((i) => i.id === special[2].id), byPhone.text.slice(0, 200));
  s.eq('search "12" (digits < 4) → 400', (await as(OWNER).get('/api/owner/clients?q=12')).status, 400);
  s.eq("search SQL-ish \"' OR 1=1 --\" → 200, no rows", (await as(OWNER).get('/api/owner/clients?q=' + encodeURIComponent("' OR 1=1 --"))).body.items.length, 0);
  s.eq('search 61 chars → 400', (await as(OWNER).get('/api/owner/clients?q=' + 'я'.repeat(61))).status, 400);

  // ---------------------------------------------------------------- more clients for paging
  await clock(1);
  const bulk = [];
  for (let i = 0; i < 60; i++) {
    const c = await reg(`Клиент ${String(i).padStart(3, '0')} ${['Анна', 'Борис', 'Вера'][i % 3]}`);
    bulk.push(c);
    if (i % 4 !== 3) await buy(c.id, 50_000 + ((i * 7919) % 40) * 25_000);
  }
  const statsRows = await sql(`SELECT c.id, COALESCE(c.name,'') AS name, c.created_at, s.balance, s.spent, s.last_purchase_at FROM clients c JOIN client_stats s ON s.client_id = c.id`);
  const total = statsRows.length;
  const cmpFor = {
    last_purchase_desc: (a, b) => (b.last_purchase_at > a.last_purchase_at ? 1 : b.last_purchase_at < a.last_purchase_at ? -1 : b.id > a.id ? 1 : -1),
    spent_desc: (a, b) => b.spent - a.spent || (b.id > a.id ? 1 : -1),
    balance_desc: (a, b) => b.balance - a.balance || (b.id > a.id ? 1 : -1),
    name: (a, b) => utf8cmp(a.name, b.name) || (a.id > b.id ? 1 : -1),
    created_desc: (a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : b.id > a.id ? 1 : -1),
  };
  for (const [sort, cmp] of Object.entries(cmpFor)) {
    const want = [...statsRows].sort(cmp).map((r) => r.id);
    for (const limit of [7, 100]) {
      const got = (await listAll({ sort }, limit)).map((i) => i.id);
      s.check(`sort=${sort} limit=${limit}: complete, no duplicates, correct order`, JSON.stringify(got) === JSON.stringify(want), `got ${got.length}/${total}, first diff at ${got.findIndex((g, i) => g !== want[i])}`);
    }
  }
  // cursor from another sort / garbage
  const p1 = await as(OWNER).get('/api/owner/clients?sort=spent_desc&limit=5');
  s.eq('cursor of another sort → 400', (await as(OWNER).get(`/api/owner/clients?sort=name&cursor=${p1.body.nextCursor}`)).status, 400);
  for (const bad of ['%%%', 'abc', Buffer.from('{"s":"name","v":1,"i":"x"}').toString('base64url'), Buffer.from('null').toString('base64url'), 'A'.repeat(400)]) {
    s.eq(`garbage cursor ${bad.slice(0, 12)} → 400`, (await as(OWNER).get(`/api/owner/clients?sort=name&cursor=${encodeURIComponent(bad)}`)).status, 400);
  }

  // stability: purchases between pages
  for (const sort of ['last_purchase_desc', 'spent_desc', 'balance_desc']) {
    const seen = [];
    let cursor = null;
    let page = 0;
    let mover = null, movedEarly = null;
    do {
      const r = await as(OWNER).get(`/api/owner/clients?sort=${sort}&limit=10${cursor ? '&cursor=' + cursor : ''}`);
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor;
      page++;
      if (page === 1) {
        // a client that would come on a LATER page buys a lot → jumps to the top
        const pending = [...statsRows].sort(cmpFor[sort]).map((x) => x.id).filter((x) => !seen.includes(x));
        mover = pending[pending.length - 1];
        await buy(mover, 9_000_000);
        // a client already shown buys too → must not appear twice
        movedEarly = seen[3];
        await buy(movedEarly, 8_000_000);
      }
    } while (cursor);
    const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
    const others = statsRows.map((r) => r.id).filter((x) => x !== mover);
    const missing = others.filter((x) => !seen.includes(x));
    s.check(`paging ${sort} with purchases between pages: no duplicates`, dup.length === 0, dup);
    s.check(`paging ${sort} with purchases between pages: nobody else skipped`, missing.length === 0, missing);
    if (!seen.includes(mover)) note('info', `Paging ${sort}: the client who bought between page loads and moved above the cursor is not shown in that pass (keyset paging, documented in README).`);
    await clock(1);
  }

  // ---------------------------------------------------------------- CSV: clients
  const csvR = await as(OWNER).get('/api/owner/export/clients.csv');
  s.check('clients.csv: 200 text/csv attachment', csvR.status === 200 && /text\/csv/.test(csvR.headers.get('content-type')) && /attachment; filename="honey-clients-\d{4}-\d{2}-\d{2}\.csv"/.test(csvR.headers.get('content-disposition') || ''), `${csvR.status} ${csvR.headers.get('content-disposition')}`);
  const b = csvR.bytes;
  s.check('clients.csv: UTF-8 BOM', b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, [...b.slice(0, 3)]);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b).replace(/^﻿/, '');
  const { rows, errors } = parseCsv(text);
  s.check('clients.csv: valid RFC 4180 with ";" and CRLF', errors.length === 0, errors.slice(0, 3));
  s.eq('clients.csv: header', rows[0], ['Код', 'Имя', 'Телефон', 'Уровень', 'Мёд', 'Мёд действует до', 'Сумма покупок', 'Покупок', 'Последняя покупка', 'Подарков доступно', 'Регистрация', 'Язык', 'Заметка']);
  const dbClients = await sql(`SELECT c.code, c.name, c.phone, c.note, s.balance, s.spent, s.purchases_count FROM clients c JOIN client_stats s ON s.client_id = c.id`);
  s.eq('clients.csv: one row per client, 13 columns each', [rows.length - 1, rows.slice(1).every((r) => r.length === 13)], [dbClients.length, true]);
  const byCodeRow = new Map(rows.slice(1).map((r) => [r[0], r]));
  let mismatches = 0;
  for (const c of dbClients) {
    const r = byCodeRow.get(c.code);
    const csvName = r?.[1].replace(/^'(?=[=+\-@\t\r])/, '');
    if (!r || csvName !== (c.name ?? '') || r[2] !== (c.phone ?? '') || Number(r[4]) !== c.balance || Number(r[6]) !== c.spent || Number(r[7]) !== c.purchases_count || r[12] !== (c.note ?? '')) {
      mismatches++;
      if (mismatches < 4) s.check(`clients.csv row for ${c.code} matches DB`, false, { csv: r, db: c });
    }
  }
  s.eq('clients.csv: every row equals the DB (names with ; " newline emoji Cyrillic ʻ ’ RTL)', mismatches, 0);
  const formula = rows.slice(1).filter((r) => r.some((cell) => /^[=+\-@]/.test(cell) && !/^[+-]?\d+$/.test(cell)));
  s.check('clients.csv: no cell starts with = + - @ (CSV formula injection)', formula.length === 0, formula.map((r) => r[1]).slice(0, 4));

  // ---------------------------------------------------------------- CSV: operations
  const now = (await as(OWNER).get('/api/me')).body.now;
  const opsR = await as(OWNER).get('/api/owner/export/operations.csv?from=2020-01-01&to=2099-12-31');
  const ops = parseCsv(new TextDecoder().decode(opsR.bytes).replace(/^﻿/, ''));
  const [cnt] = await sql(`SELECT
      (SELECT COUNT(*) FROM purchases) + (SELECT COUNT(*) FROM purchases WHERE status = 'reversed')
    + (SELECT COUNT(*) FROM points_ledger WHERE purchase_id IS NULL)
    + (SELECT COUNT(*) FROM rewards WHERE status = 'used' AND used_in_purchase IS NULL) AS n`);
  s.check('operations.csv (whole range): one row per operation, valid CSV', opsR.status === 200 && ops.errors.length === 0 && ops.rows.length - 1 === cnt.n, `${opsR.status} rows ${ops.rows.length - 1} vs ${cnt.n} ${ops.errors.slice(0, 2)}`);
  const def = await as(OWNER).get('/api/owner/export/operations.csv');
  const defRows = parseCsv(new TextDecoder().decode(def.bytes).replace(/^﻿/, '')).rows.length - 1;
  const since = new Date(Date.parse(now) - 89 * 86_400_000);
  s.check('operations.csv default = last 90 days (fewer rows than the whole range)', def.status === 200 && defRows < cnt.n && defRows > 0, `${defRows} of ${cnt.n}, since ${since.toISOString()}`);
  for (const [qs, want] of [['from=2026-13-01', 400], ['from=2026-1-1', 400], ['from=2027-01-02&to=2027-01-01', 400], ['from=abc', 400], ['to=9999-12-31&from=9999-12-01', 200], ['from=0000-01-01&to=0001-01-01', 200]]) {
    s.eq(`operations.csv ?${qs} → ${want}`, (await as(OWNER).get('/api/owner/export/operations.csv?' + qs)).status, want);
  }
  const feb = await as(OWNER).get('/api/owner/export/operations.csv?from=2026-02-31&to=2026-03-01');
  s.eq('L2: impossible date 2026-02-31 → 400 with a Russian message', [feb.status, /[А-Яа-я]/.test(feb.body?.error?.message ?? '')], [400, true]);

  // ---------------------------------------------------------------- export links
  const mk = (body) => as(OWNER).post('/api/owner/export/link', body);
  const l1 = await mk({ kind: 'clients' });
  s.check('export link: 201 with a token URL', l1.status === 201 && /\/api\/owner\/export\/clients\.csv\?token=[0-9a-f]{48}$/.test(l1.body.url), l1.text);
  const tokenPath = (u) => new URL(u).pathname + new URL(u).search;
  const g1 = await req(null, 'GET', tokenPath(l1.body.url), { allowNonJsonError: true });
  const g2 = await req(null, 'GET', tokenPath(l1.body.url), { allowNonJsonError: true });
  s.eq('export link: works once without auth, then 410', [g1.status, g1.bytes[0], g2.status], [200, 0xef, 410]);
  const l2 = await mk({ kind: 'clients' });
  const wrongKind = await req(null, 'GET', tokenPath(l2.body.url).replace('clients.csv', 'operations.csv'), { allowNonJsonError: true });
  const after = await req(null, 'GET', tokenPath(l2.body.url), { allowNonJsonError: true });
  s.eq('export link used on the other file → 410', wrongKind.status, 410);
  s.eq('L1: the link opened on the wrong file is NOT consumed (works on its own file afterwards)', after.status, 200);
  const l3 = await mk({ kind: 'operations', from: '2026-01-01', to: '2026-12-31' });
  s.eq('export link (operations with period) → 201', l3.status, 201);
  s.eq('export link bad period → 400', (await mk({ kind: 'operations', from: '2026-12-31', to: '2026-01-01' })).status, 400);
  s.eq('export link bad kind → 400', (await mk({ kind: 'staff' })).status, 400);
  s.eq('export link: florist → 403', (await as(FLORIST).post('/api/owner/export/link', { kind: 'clients' })).status, 403);
  s.eq('export via unknown token → 410', (await req(null, 'GET', '/api/owner/export/clients.csv?token=deadbeef', { allowNonJsonError: true })).status, 410);
  s.eq('export without token and without auth → 401', (await req(null, 'GET', '/api/owner/export/clients.csv')).status, 401);
  const l4 = await mk({ kind: 'clients' });
  await clock(1);
  s.eq('export link expires (10 minutes; test clock +1 day) → 410', (await req(null, 'GET', tokenPath(l4.body.url), { allowNonJsonError: true })).status, 410);

  const v = await checkInvariants();
  area('invariants (scenarios)').check('invariants after: clients list & export', v.length === 0, v.slice(0, 5));
  void ctx;
}
