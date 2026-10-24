import type { ClientListDTO, ConsoleClientsPageDTO, ImportBatchDTO, ImportRequest, ImportResultDTO, OwnerStatsDTO, TestDemoSeedDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, db, session } from './consoleHelpers.js';
import { call, contactUpdate, json, makeStaff, mockTelegram, register, resetDb, T, webhook } from './helpers.js';

/**
 * The owner console next to the other features: TEST_MODE demo clients (negative telegram ids
 * too, clients.demo = 1), the client_stats summaries (migration 0004) and the Mini App stats.
 */
const OWNER = T + 1002;
const TG_USER = 777_000_222;
const OPTS = { creditBalance: true, levelFromTotal: true, cellsFromCount: true };

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner', 'Владелица');
});
afterEach(() => tg.restore());

async function doImport(batchId: string, rows: ImportRequest['rows']): Promise<ImportResultDTO> {
  const res = await call('/api/owner/import', { user: OWNER, body: { batchId, fileName: 'база.xlsx', dryRun: false, options: OPTS, rows } satisfies ImportRequest });
  if (res.status !== 201) throw new Error(`import: ${res.status} ${await res.text()}`);
  return json<ImportResultDTO>(res);
}
const row = (sql: string, ...args: unknown[]) => db().prepare(sql).bind(...args).first<Record<string, unknown>>();
const count = async (sql: string, ...args: unknown[]) => Number((await row(sql, ...args))!.n);

async function seedDemoChunk() {
  const res = await call('/api/test/demo-seed', { user: OWNER, body: { chunk: 0 } });
  expect(res.status).toBe(200);
  const r = await json<TestDemoSeedDTO>(res);
  expect(r.created).toBeGreaterThan(0);
  return (await row('SELECT id, phone, name, telegram_id FROM clients WHERE demo = 1 ORDER BY id LIMIT 1'))!;
}

describe('demo clients vs imported clients (both have negative telegram ids)', () => {
  it('a demo client is never claimed by a real person, never touched by an import; demo-clear keeps imported clients', async () => {
    const demo = await seedDemoChunk();
    expect(Number(demo.telegram_id)).toBeLessThan(0);

    // A real Telegram user shares the (fake) phone of a demo client: refused, nothing moves.
    await webhook(contactUpdate(TG_USER, String(demo.phone)));
    expect(String(tg.sent().find((m) => m.payload.chat_id === TG_USER)?.payload.text)).toMatch(/уже привязан/);
    expect((await row('SELECT telegram_id, name FROM clients WHERE id = ?', demo.id))).toMatchObject({ telegram_id: demo.telegram_id, name: demo.name });
    expect(await count('SELECT COUNT(*) AS n FROM clients WHERE telegram_id = ?', TG_USER)).toBe(0);

    // An import row with that phone leaves the demo client alone; a new phone is imported.
    const res = await doImport('batch-demo-1', [
      { line: 2, phone: String(demo.phone), name: 'Чужое имя', balance: 99_000 },
      { line: 3, phone: '+998905555555', name: 'Нигора', balance: 40_000, total: 2_500_000, count: 4 },
    ]);
    expect(res.results[0]).toMatchObject({ status: 'update', honey: 0 });
    expect(res.results[0]!.message).toMatch(/демо-клиентом/);
    expect(res.results[1]).toMatchObject({ status: 'create', honey: 40_000 });
    expect((await row('SELECT name FROM clients WHERE id = ?', demo.id))!.name).toBe(demo.name);
    expect(await count('SELECT COUNT(*) AS n FROM client_imports WHERE client_id = ?', demo.id)).toBe(0);

    // Import placeholders and demo ids live in disjoint ranges (and telegram_id is UNIQUE anyway).
    const imported = (await row('SELECT id, telegram_id FROM clients WHERE phone = ?', '+998905555555'))!;
    expect(Number(imported.telegram_id)).toBe(-998905555555);
    expect(await count('SELECT COUNT(*) AS n FROM clients WHERE demo = 1 AND telegram_id <= -1000000000')).toBe(0);

    // The console's "not in Telegram yet" filter lists imports only, not demo clients.
    const s = await session(OWNER);
    const pending = await json<ConsoleClientsPageDTO>(bearer('/api/owner/console/clients?linked=pending', s));
    expect(pending.rows.map((r) => r.id)).toEqual([imported.id]);
    // Demo clients act as real ones: never tagged "not in Telegram".
    const all = await json<ConsoleClientsPageDTO>(bearer('/api/owner/console/clients?limit=1000', s));
    expect(all.rows.filter((r) => !r.linked).map((r) => r.id)).toEqual([imported.id]);
    const tgOnly = await json<ConsoleClientsPageDTO>(bearer('/api/owner/console/clients?linked=tg&limit=1000', s));
    expect(tgOnly.matched).toBe(all.matched - 1);

    // «Удалить демо-данные» works with the console's tables present and keeps the imported client.
    const clear = await call('/api/test/demo-clear', { user: OWNER, body: {} });
    expect(clear.status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM clients WHERE demo = 1')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM client_imports WHERE client_id = ?', imported.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM client_stats WHERE client_id = ?', imported.id)).toBe(1);
    expect(await count(`SELECT COALESCE(SUM(amount), 0) AS n FROM points_ledger WHERE client_id = ?`, imported.id)).toBe(40_000);

    // Now the number is free: a new import creates that client.
    const again = await doImport('batch-demo-2', [{ line: 2, phone: String(demo.phone), name: 'Настоящая клиентка' }]);
    expect(again.results[0]!.status).toBe('create');

    // …and the real person who shares it with the bot claims it.
    await webhook(contactUpdate(TG_USER, String(demo.phone)));
    const claimed = (await row('SELECT telegram_id, name FROM clients WHERE phone = ?', demo.phone))!;
    expect(claimed).toMatchObject({ telegram_id: TG_USER, name: 'Настоящая клиентка' });
  });
});

describe('imported clients and client_stats', () => {
  it('get a summary row (start мёд, level from the past sum), show in the Mini App client list; undo removes it', async () => {
    await doImport('batch-stats-1', [{ line: 2, phone: '+998905555555', name: 'Нигора', balance: 40_000, total: 2_500_000, count: 4 }]);
    const c = (await row('SELECT id FROM clients WHERE phone = ?', '+998905555555'))!;
    const stats = (await row('SELECT * FROM client_stats WHERE client_id = ?', c.id))!;
    expect(stats).toMatchObject({ balance: 40_000, level_id: 'honey', purchases_count: 0, last_purchase_at: '', gifts_available: 0 });
    expect(String(stats.expires_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const list = await json<ClientListDTO>(call('/api/owner/clients?q=905555555', { user: OWNER }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: c.id, name: 'Нигора', balance: 40_000, levelId: 'honey', purchases: 0 });

    // Opening the card self-heals drifted stats: nothing drifted, the row is exactly what the engine computes.
    expect((await call(`/api/owner/clients/${c.id}`, { user: OWNER })).status).toBe(200);
    const after = (await row('SELECT * FROM client_stats WHERE client_id = ?', c.id))!;
    expect({ ...after, updated_at: null }).toEqual({ ...stats, updated_at: null });

    // The console list reads the same summary.
    const s = await session(OWNER);
    const page = await json<ConsoleClientsPageDTO>(bearer('/api/owner/console/clients', s));
    expect(page.rows[0]).toMatchObject({ id: c.id, balance: 40_000, level: 'honey', linked: false });
    expect(page.matchedTotal).toBeNull(); // the all-time view does not read purchases

    const undo = await call('/api/owner/import/batch-stats-1/undo', { user: OWNER, body: {} });
    expect(await json<ImportBatchDTO>(undo)).toMatchObject({ status: 'undone' });
    expect(await count('SELECT COUNT(*) AS n FROM client_stats')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM clients')).toBe(0);
  });
});

describe('Mini App owner stats', () => {
  it('imported clients are not "new" and their start мёд is not "accrued"; demo clients count as real', async () => {
    await register(T + 5001, '+998901112233', 'Клиент из Telegram');
    await doImport('batch-ms-1', [
      { line: 2, phone: '+998905555555', balance: 40_000 },
      { line: 3, phone: '+998906666666', balance: 5000 },
    ]);
    const base = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(base.clients).toBe(3);
    expect(base.clientsNew7d).toBe(1);
    expect(base.points.accrued).toBe(0);
    expect(base.points.outstanding).toBe(45_000);

    await seedDemoChunk();
    const demoCount = await count('SELECT COUNT(*) AS n FROM clients WHERE demo = 1');
    const demoAccrued = await count(`SELECT COALESCE(SUM(l.amount), 0) AS n FROM points_ledger l JOIN clients c ON c.id = l.client_id
      WHERE c.demo = 1 AND (l.type IN ('accrual', 'welcome') OR (l.type = 'manual_adjust' AND l.amount > 0) OR (l.type = 'reversal' AND l.amount < 0))`);
    const withDemo = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(withDemo.clients).toBe(3 + demoCount);
    expect(withDemo.points.accrued).toBe(demoAccrued);
  });
});
