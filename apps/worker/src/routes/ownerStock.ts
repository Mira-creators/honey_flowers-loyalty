import { addDays, mergeStockConfig } from '@honey/stock';
import { Hono } from 'hono';
import { requireRole, type Vars } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { auditStmt, createItem, createSupplier, seedCatalog, updateItem } from '../stock/catalog.js';
import { actorOf, loadConfig, requireStock, revStmt, stockConfigSchema, todayOf } from '../stock/core.js';
import { cancelReceipt, listReceipts } from '../stock/receipts.js';
import { balances, bouquetsPage, overview, writeoffsPage } from '../stock/reports.js';
import { decideWriteoff, pendingWriteoffs } from '../stock/writeoffs.js';

/**
 * «Склад» for the owner: /api/owner/stock/* (Mini App and the owner console — a Bearer console
 * session is admitted only under /api/owner/*). 404 unless STOCK_ENABLED = "1" (app.ts).
 */
export const ownerStockRoutes = new Hono<{ Variables: Vars }>();

ownerStockRoutes.use('*', async (c, next) => {
  requireRole(c, ['owner']);
  await next();
});

const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => {
  throw new HttpError(400, 'validation', 'Тело запроса не JSON');
});

/** ?from&to (YYYY-MM-DD, Tashkent days), default = the last 30 days, at most 400 days. */
function period(c: { req: { query(k: string): string | undefined } }, today: string): { from: string; to: string } {
  const ok = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  const to = ok(c.req.query('to')) ? c.req.query('to')! : today;
  const from = ok(c.req.query('from')) ? c.req.query('from')! : addDays(to, -29);
  if (from > to) throw new HttpError(400, 'validation', 'Начало периода позже конца');
  if (from < addDays(to, -400)) throw new HttpError(400, 'validation', 'Период не длиннее 400 дней');
  return { from, to };
}

ownerStockRoutes.get('/overview', async (c) => {
  const app = c.get('app');
  return c.json(await overview(app, await loadConfig(app.repo.db)));
});

ownerStockRoutes.get('/config', async (c) => c.json(await loadConfig(c.get('app').repo.db)));
ownerStockRoutes.put('/config', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const before = await loadConfig(app.repo.db);
  requireStock(caller, 'config.edit', before);
  const next = stockConfigSchema.parse(mergeStockConfig(await body(c), before));
  await app.repo.db.batch([
    app.repo.db.prepare(`INSERT INTO settings (key, value) VALUES ('stock_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(next)),
    auditStmt(app, actorOf(caller), 'stock.config.update', 'settings', 'stock_config', { after: next }),
    revStmt(app.repo.db, 'stock_catalog_rev'),
  ]);
  return c.json(next);
});

ownerStockRoutes.post('/items', async (c) => {
  const app = c.get('app');
  const cfg = await loadConfig(app.repo.db);
  requireStock(c.get('caller'), 'catalog.edit', cfg);
  return c.json(await createItem(app, actorOf(c.get('caller')), (await body(c)) as never, cfg), 201);
});
ownerStockRoutes.put('/items/:id', async (c) => {
  const app = c.get('app');
  const cfg = await loadConfig(app.repo.db);
  requireStock(c.get('caller'), 'catalog.edit', cfg);
  return c.json(await updateItem(app, actorOf(c.get('caller')), c.req.param('id'), (await body(c)) as never, cfg));
});
ownerStockRoutes.post('/catalog/seed', async (c) => {
  const app = c.get('app');
  const cfg = await loadConfig(app.repo.db);
  requireStock(c.get('caller'), 'catalog.edit', cfg);
  return c.json(await seedCatalog(app, actorOf(c.get('caller')), cfg), 201);
});
ownerStockRoutes.post('/suppliers', async (c) => c.json(await createSupplier(c.get('app'), await body(c)), 201));

ownerStockRoutes.post('/receipts/:id/cancel', async (c) => {
  const app = c.get('app');
  return c.json(await cancelReceipt(app, c.get('caller'), c.req.param('id'), await loadConfig(app.repo.db)));
});

ownerStockRoutes.get('/approvals', async (c) => c.json(await pendingWriteoffs(c.get('app'), 50)));
ownerStockRoutes.post('/approvals/:docId', async (c) => {
  const app = c.get('app');
  return c.json(await decideWriteoff(app, c.get('caller'), c.req.param('docId'), await body(c), await loadConfig(app.repo.db)));
});

// ------------------------------------------------------------------ console tables

ownerStockRoutes.get('/balances', async (c) => c.json({ items: await balances(c.get('app')), cursor: null }));
ownerStockRoutes.get('/receipts', async (c) => {
  const app = c.get('app');
  const p = period(c, todayOf(app));
  return c.json(await listReceipts(app, { from: p.from, to: p.to, limit: 500, cursor: c.req.query('cursor') ?? null }));
});
ownerStockRoutes.get('/bouquets', async (c) => {
  const app = c.get('app');
  const p = period(c, todayOf(app));
  return c.json(await bouquetsPage(app, p.from, p.to, c.req.query('cursor') ?? null));
});
ownerStockRoutes.get('/writeoffs', async (c) => {
  const app = c.get('app');
  const p = period(c, todayOf(app));
  return c.json(await writeoffsPage(app, p.from, p.to, c.req.query('cursor') ?? null));
});
