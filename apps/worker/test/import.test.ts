import type { ImportBatchDTO, ImportRequest, ImportResultDTO, MeDTO, StaffClientLookupDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDailyJob } from '../src/cron.js';
import { createContext } from '../src/context.js';
import { countingEnv } from './d1Counter.js';
import { bearer, db, session } from './consoleHelpers.js';
import { buy, call, contactUpdate, json, makeStaff, mockTelegram, moveClock, register, resetDb, T, testEnv, tmaHeader, webhook } from './helpers.js';

const OWNER = T + 1002;
const FLORIST = T + 1001;
const TG_USER = 777_000_111; // a real Telegram account (contact via the bot)

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(FLORIST, 'florist', 'Флорист');
  await makeStaff(OWNER, 'owner', 'Владелица');
});
afterEach(() => tg.restore());

const ALL_ON = { creditBalance: true, levelFromTotal: true, cellsFromCount: true };
const OFF = { creditBalance: false, levelFromTotal: false, cellsFromCount: false };

function req(batchId: string, rows: ImportRequest['rows'], opts: Partial<ImportRequest> = {}): ImportRequest {
  return { batchId, fileName: 'база.xlsx', dryRun: false, options: ALL_ON, rows, ...opts };
}

async function importAs(user: number, body: ImportRequest) {
  return call('/api/owner/import', { user, body });
}

async function doImport(body: ImportRequest): Promise<ImportResultDTO> {
  const res = await importAs(OWNER, body);
  if (res.status !== 201 && res.status !== 200) throw new Error(`import failed: ${res.status} ${await res.text()}`);
  return json<ImportResultDTO>(res);
}

const NIGORA = { line: 2, phone: '+998 90 555 55 55', name: 'Нигора', birthday: '1992-04-01', balance: 40_000, total: 2_500_000, count: 4, lastPurchase: '2026-06-01' };

async function clientRow(phone: string) {
  return db().prepare('SELECT * FROM clients WHERE phone = ?').bind(phone).first<Record<string, unknown>>();
}
async function balanceOf(clientId: string) {
  return Number((await db().prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM points_ledger WHERE client_id = ?').bind(clientId).first<{ b: number }>())!.b);
}
const countClients = async () => Number((await db().prepare('SELECT COUNT(*) AS n FROM clients').first<{ n: number }>())!.n);

describe('import: preview (dryRun)', () => {
  it('reports create / update / invalid / duplicate per row and writes nothing', async () => {
    const me = await register(T + 5001, '+998901112233', 'Клиент из Telegram');
    const before = await countClients();
    const res = await doImport(
      req(
        'batch-dry-1',
        [
          NIGORA,
          { line: 3, phone: '901112233', name: 'Другое имя', birthday: '1990-05-05' },
          { line: 4, phone: '12345', name: 'Ошибка' },
          { line: 5, phone: '+998905555555', name: 'Повтор' },
        ],
        { dryRun: true },
      ),
    );
    expect(res.dryRun).toBe(true);
    expect(res.results.map((r) => [r.line, r.status])).toEqual([[2, 'create'], [3, 'update'], [4, 'invalid'], [5, 'duplicate']]);
    expect(res.results[0]).toMatchObject({ phone: '+998905555555', honey: 40_000, linked: false });
    expect(res.results[0]!.message).toMatch(/мёд 40.000, уровень «Медовая», соты: 4/);
    expect(res.results[1]).toMatchObject({ linked: true, honey: 0 });
    expect(res.results[1]!.message).toMatch(/Уже участник в Telegram: обновим день рождения, мёд не начисляется/);
    expect(res.summary).toEqual({ create: 1, update: 1, replay: 0, skipped: 2, honey: 40_000 });
    expect(await countClients()).toBe(before);
    expect((await db().prepare('SELECT COUNT(*) AS n FROM import_batches').first<{ n: number }>())!.n).toBe(0);
    expect(me.client!.name).toBe('Клиент из Telegram');
  });

  it('only the owner can import; at most 100 rows per request', async () => {
    expect((await importAs(FLORIST, req('batch-x-1', [NIGORA]))).status).toBe(403);
    const rows = Array.from({ length: 101 }, (_, i) => ({ line: i + 2, phone: `+9989000${String(i).padStart(5, '0')}` }));
    expect((await importAs(OWNER, req('batch-x-2', rows))).status).toBe(400);
  });
});

describe('import: commit', () => {
  it('creates clients without Telegram with honey, level floor and bee position; never double-credits', async () => {
    await register(T + 5001, '+998901112233', 'Клиент из Telegram');
    const first = await doImport(req('batch-0001', [NIGORA, { line: 3, phone: '901112233', name: 'Другое имя', birthday: '1990-05-05' }]));
    expect(first.summary).toEqual({ create: 1, update: 1, replay: 0, skipped: 0, honey: 40_000 });

    const c = (await clientRow('+998905555555'))!;
    expect(Number(c.telegram_id)).toBe(-998905555555);
    expect(String(c.code)).toMatch(/^HF\d{6}$/);
    expect(c).toMatchObject({ name: 'Нигора', birthday: '1992-04-01', level_override: 'honey', level_override_index: 1, consent_at: null });
    const ledger = await db().prepare('SELECT type, amount, idempotency_key, reason FROM points_ledger WHERE client_id = ?').bind(c.id).all();
    expect(ledger.results).toEqual([{ type: 'manual_adjust', amount: 40_000, idempotency_key: 'import:batch-0001:+998905555555', reason: 'Импорт базы: стартовый баланс' }]);
    // The engine sees it as a normal client: balance, level, card.
    const look = await json<StaffClientLookupDTO>(call('/api/staff/client?q=905555555', { user: FLORIST }));
    expect(look.client).toMatchObject({ name: 'Нигора', balance: 40_000, level: { id: 'honey' }, card: { filled: 4, cycle: 1 } });
    // A Telegram client's existing name is kept, the missing birthday filled in.
    expect(await clientRow('+998901112233')).toMatchObject({ name: 'Клиент из Telegram', birthday: '1990-05-05' });

    // The same chunk again (network retry) → replay, nothing doubled.
    const again = await doImport(req('batch-0001', [NIGORA]));
    expect(again.results[0]!.status).toBe('replay');
    expect(await balanceOf(String(c.id))).toBe(40_000);

    // A later import of the same base: name updated (not yet in Telegram), honey NOT credited again.
    const later = await doImport(req('batch-0002', [{ ...NIGORA, name: 'Нигора Каримова', balance: 99_999 }]));
    expect(later.results[0]).toMatchObject({ status: 'update', honey: 0 });
    expect(await balanceOf(String(c.id))).toBe(40_000);
    expect((await clientRow('+998905555555'))!.name).toBe('Нигора Каримова');

    // Options cannot change in the middle of a batch.
    expect((await importAs(OWNER, req('batch-0001', [NIGORA], { options: OFF }))).status).toBe(409);

    const batches = await json<ImportBatchDTO[]>(call('/api/owner/import/batches', { user: OWNER }));
    expect(batches.map((b) => b.id)).toEqual(['batch-0002', 'batch-0001']);
    expect(batches[1]).toMatchObject({ created: 1, updated: 1, honey: 40_000, status: 'active', fileName: 'база.xlsx', options: ALL_ON, claimed: 0 });
  });

  it('with options off: no honey, no level, no bee move', async () => {
    await doImport(req('batch-off-1', [NIGORA], { options: OFF }));
    const c = (await clientRow('+998905555555'))!;
    expect(c.level_override).toBeNull();
    expect(await balanceOf(String(c.id))).toBe(0);
    const look = await json<StaffClientLookupDTO>(call('/api/staff/client?q=905555555', { user: FLORIST }));
    expect(look.client).toMatchObject({ balance: 0, level: { id: 'bee' }, card: { filled: 0 } });
    expect(Number((await db().prepare('SELECT legacy_total FROM client_imports WHERE client_id = ?').bind(c.id).first<{ legacy_total: number }>())!.legacy_total)).toBe(2_500_000);
  });

  it('a 100-row chunk is a few D1 round trips (web session)', async () => {
    const s = await session(OWNER);
    const rows = Array.from({ length: 100 }, (_, i) => ({ line: i + 2, phone: `+9989100${String(i).padStart(5, '0')}`, name: `Клиент ${i}`, balance: 1000 + i, total: 100_000 * i, count: i % 12 }));
    const { env, c } = countingEnv();
    const res = await bearer('/api/owner/import', s, { env, body: req('batch-big-1', rows) });
    expect(res.status).toBe(201);
    expect((await json<ImportResultDTO>(res)).summary.create).toBe(100);
    expect(c.calls).toBeLessThanOrEqual(6);
    expect(c.stmts).toBeLessThanOrEqual(18); // + 4 set-based stats_daily statements (migration 0007)
    expect(await countClients()).toBe(100);
    expect(Number((await db().prepare(`SELECT COUNT(*) AS n FROM card_moves WHERE reason = 'import'`).first<{ n: number }>())!.n)).toBe(rows.filter((r) => r.count > 0).length);
  });
});

describe('import: an imported client claims the card when sharing the phone', () => {
  it('via the bot: same client, balance and level kept, no duplicate, no "number taken" error', async () => {
    await doImport(req('batch-claim-1', [NIGORA]));
    const imported = (await clientRow('+998905555555'))!;
    const before = await countClients();

    await webhook(contactUpdate(TG_USER, '+998905555555'));
    const reply = tg.sent().find((m) => m.payload.chat_id === TG_USER);
    expect(String(reply?.payload.text)).toMatch(/нашли вас в базе клиентов/);
    expect(String(reply?.payload.text)).toContain(String(imported.code));

    expect(await countClients()).toBe(before);
    const after = (await clientRow('+998905555555'))!;
    expect(after.id).toBe(imported.id);
    expect(Number(after.telegram_id)).toBe(TG_USER);
    expect(after.consent_at).not.toBeNull();
    const me = await json<MeDTO>(call('/api/me', { headers: await tmaHeader(TG_USER) }));
    expect(me).toMatchObject({ registered: true, client: { id: imported.id, name: 'Нигора', balance: 40_000, level: { id: 'honey' }, card: { filled: 4 } } });

    // Now a regular client: a purchase moves the bee from cell 4 to 5.
    const p = await buy(FLORIST, String(imported.id), 300_000);
    expect(p.client.card.filled).toBe(5);

    // Another Telegram account sharing the same phone is still refused.
    await webhook(contactUpdate(TG_USER + 1, '+998905555555'));
    expect(String(tg.sent().find((m) => m.payload.chat_id === TG_USER + 1)?.payload.text)).toMatch(/уже привязан к другому аккаунту/);

    const batches = await json<ImportBatchDTO[]>(call('/api/owner/import/batches', { user: OWNER }));
    expect(batches[0]!.claimed).toBe(1);
  });

  it('via the TEST_MODE register shortcut too', async () => {
    await doImport(req('batch-claim-2', [NIGORA]));
    const imported = (await clientRow('+998905555555'))!;
    const me = await register(T + 6001, '+998905555555', 'Тестер');
    expect(me.client).toMatchObject({ id: imported.id, balance: 40_000, name: 'Нигора' });
  });

  it('a person who already has a card of their own is not merged automatically', async () => {
    await doImport(req('batch-claim-3', [NIGORA]));
    await webhook(contactUpdate(TG_USER, '+998907777777'));
    await webhook(contactUpdate(TG_USER, '+998905555555'));
    expect(String(tg.sent().at(-1)?.payload.text)).toMatch(/уже привязан/);
    expect(Number((await clientRow('+998905555555'))!.telegram_id)).toBeLessThan(0);
  });

  it('the daily job never messages an imported client (no Telegram yet)', async () => {
    await doImport(req('batch-notify-1', [NIGORA]));
    await moveClock(76); // 14 days before the import honey expires
    tg.calls.length = 0;
    const res = await runDailyJob(await createContext(testEnv, {}));
    expect(res.warned).toBe(1);
    expect(tg.sent()).toHaveLength(0); // skipped silently, like demo clients (nothing to log: there is no chat)
  });
});

describe('import: undo', () => {
  it('removes the clients a batch created if nothing happened to them since', async () => {
    await register(T + 5001, '+998901112233', 'Клиент из Telegram');
    await doImport(req('batch-undo-1', [NIGORA, { line: 3, phone: '+998901112233', birthday: '1990-05-05' }, { line: 4, phone: '+998906666666', balance: 5000 }]));
    expect(await countClients()).toBe(3);
    expect((await clientRow('+998901112233'))!.birthday).toBe('1990-05-05'); // filled in by the import
    const res = await call('/api/owner/import/batch-undo-1/undo', { user: OWNER, body: {} });
    expect(res.status).toBe(200);
    expect(await json<ImportBatchDTO>(res)).toMatchObject({ status: 'undone', created: 2 });
    expect(await countClients()).toBe(1); // the Telegram client stays…
    expect(await clientRow('+998901112233')).toMatchObject({ name: 'Клиент из Telegram', birthday: null }); // …as it was before the import
    expect(Number((await db().prepare('SELECT COUNT(*) AS n FROM points_ledger').first<{ n: number }>())!.n)).toBe(0);
    expect(Number((await db().prepare(`SELECT COUNT(*) AS n FROM card_moves`).first<{ n: number }>())!.n)).toBe(0);
    expect((await call('/api/owner/import/batch-undo-1/undo', { user: OWNER, body: {} })).status).toBe(409);
    // An undone batch id cannot be reused.
    expect((await importAs(OWNER, req('batch-undo-1', [NIGORA]))).status).toBe(409);
  });

  it('is refused once a client from the batch joined via Telegram or bought something', async () => {
    await doImport(req('batch-undo-2', [NIGORA, { line: 3, phone: '+998906666666', balance: 5000 }]));
    await webhook(contactUpdate(TG_USER, '+998905555555'));
    const res = await call('/api/owner/import/batch-undo-2/undo', { user: OWNER, body: {} });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toMatch(/1 уже вошли через Telegram/);
    expect(await countClients()).toBe(2);

    await doImport(req('batch-undo-3', [{ line: 2, phone: '+998908888888', balance: 1000 }]));
    const c = (await clientRow('+998908888888'))!;
    await buy(FLORIST, String(c.id), 150_000);
    expect((await call('/api/owner/import/batch-undo-3/undo', { user: OWNER, body: {} })).status).toBe(409);
    expect((await call('/api/owner/import/nope/undo', { user: OWNER, body: {} })).status).toBe(404);
  });
});
