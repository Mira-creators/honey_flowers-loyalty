import type { StockStatusDTO } from '@honey/contracts';
import { can } from '@honey/stock';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, STAFF_ROLES, type Vars } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { assemble, cancelAssembly, disassemble, listOpenBouquets, loadBouquet, toShowcase } from '../stock/bouquets.js';
import { getCatalog, getItem, listSuppliers, listTemplates, saveTemplate } from '../stock/catalog.js';
import { actorOf, loadConfig, requireStock } from '../stock/core.js';
import { listReceipts, postReceipt, previewReceipt, receiptForm } from '../stock/receipts.js';
import { postSale, previewSale, retryLoyalty } from '../stock/sales.js';
import { freshness, postWriteoff, setLotPriority } from '../stock/writeoffs.js';

/**
 * «Склад» for staff (florist / manager / owner in the Mini App): /api/stock/*.
 * Deny by default: clients get 403 here; every route also checks the stock permission table
 * (packages/stock/permissions.ts). The whole router is 404 unless STOCK_ENABLED = "1" (app.ts).
 */
export const stockRoutes = new Hono<{ Variables: Vars }>();

stockRoutes.use('*', async (c, next) => {
  requireRole(c, STAFF_ROLES);
  await next();
});

const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => {
  throw new HttpError(400, 'validation', 'Тело запроса не JSON');
});

stockRoutes.get('/status', async (c) => {
  const caller = c.get('caller');
  const cfg = await loadConfig(c.get('app').repo.db);
  const out: StockStatusDTO = {
    enabled: true,
    role: caller.role as StockStatusDTO['role'],
    canReceive: can(caller.role, 'receipt.post', cfg),
    canEditCatalog: can(caller.role, 'catalog.edit', cfg),
    canApprove: can(caller.role, 'writeoff.approve', cfg),
  };
  return c.json(out);
});

stockRoutes.get('/catalog', async (c) => {
  const { etag, body: dto } = await getCatalog(c.get('app'), c.req.header('if-none-match') ?? null);
  if (!dto) return c.body(null, 304, { ETag: etag, 'Cache-Control': 'no-cache' });
  return c.json(dto, 200, { ETag: etag, 'Cache-Control': 'no-cache' });
});

stockRoutes.get('/items/:id', async (c) => {
  const it = await getItem(c.get('app'), c.req.param('id'));
  if (!it) throw new HttpError(404, 'not_found', 'Позиция не найдена');
  return c.json(it);
});

stockRoutes.get('/templates', async (c) => c.json(await listTemplates(c.get('app'))));
stockRoutes.post('/templates', async (c) => {
  const app = c.get('app');
  requireStock(c.get('caller'), 'template.save', await loadConfig(app.repo.db));
  return c.json(await saveTemplate(app, actorOf(c.get('caller')), await body(c)), 201);
});
stockRoutes.get('/suppliers', async (c) => c.json(await listSuppliers(c.get('app'))));

// ------------------------------------------------------------------ receipts

stockRoutes.get('/receipts/form', async (c) => {
  const app = c.get('app');
  return c.json(await receiptForm(app, c.get('caller'), await loadConfig(app.repo.db)));
});
stockRoutes.post('/receipts/preview', async (c) => {
  const app = c.get('app');
  return c.json(await previewReceipt(app, c.get('caller'), await body(c), await loadConfig(app.repo.db)));
});
stockRoutes.post('/receipts', async (c) => {
  const app = c.get('app');
  const r = await postReceipt(app, c.get('caller'), await body(c), await loadConfig(app.repo.db));
  return c.json(r, r.replayed ? 200 : 201);
});
stockRoutes.get('/receipts', async (c) => {
  const app = c.get('app');
  requireStock(c.get('caller'), 'receipt.post', await loadConfig(app.repo.db));
  return c.json(await listReceipts(app, { limit: 30, cursor: c.req.query('cursor') ?? null }));
});

// ------------------------------------------------------------------ bouquets

stockRoutes.post('/bouquets', async (c) => {
  const app = c.get('app');
  const r = await assemble(app, c.get('caller'), await body(c), await loadConfig(app.repo.db));
  return c.json(r, r.replayed ? 200 : 201);
});
stockRoutes.get('/bouquets', async (c) => c.json(await listOpenBouquets(c.get('app'))));
stockRoutes.get('/bouquets/:id', async (c) => {
  const b = await loadBouquet(c.get('app'), c.req.param('id'));
  if (!b) throw new HttpError(404, 'not_found', 'Букет не найден');
  return c.json(b);
});
stockRoutes.post('/bouquets/:id/showcase', async (c) => {
  const app = c.get('app');
  return c.json(await toShowcase(app, c.get('caller'), c.req.param('id'), await loadConfig(app.repo.db)));
});
stockRoutes.post('/bouquets/:id/disassemble', async (c) => {
  const app = c.get('app');
  const r = await disassemble(app, c.get('caller'), c.req.param('id'), await body(c), await loadConfig(app.repo.db));
  return c.json(r, r.replayed ? 200 : 201);
});
stockRoutes.post('/bouquets/:id/cancel', async (c) => {
  const app = c.get('app');
  return c.json(await cancelAssembly(app, c.get('caller'), c.req.param('id'), await loadConfig(app.repo.db)));
});

// ------------------------------------------------------------------ sales

stockRoutes.post('/sales/preview', async (c) => {
  const app = c.get('app');
  return c.json(await previewSale(app, c.get('caller'), await body(c), await loadConfig(app.repo.db)));
});
stockRoutes.post('/sales', async (c) => {
  const app = c.get('app');
  const r = await postSale(app, c.get('caller'), await body(c), await loadConfig(app.repo.db));
  return c.json(r, r.replayed ? 200 : 201);
});
stockRoutes.post('/sales/:id/loyalty', async (c) => {
  const app = c.get('app');
  return c.json(await retryLoyalty(app, c.get('caller'), c.req.param('id'), await loadConfig(app.repo.db), await c.req.json().catch(() => ({}))));
});

// ------------------------------------------------------------------ write-offs, freshness

stockRoutes.post('/writeoffs', async (c) => {
  const app = c.get('app');
  const r = await postWriteoff(app, c.get('caller'), await body(c), await loadConfig(app.repo.db));
  return c.json(r, r.replayed ? 200 : 201);
});
stockRoutes.get('/freshness', async (c) => {
  const app = c.get('app');
  requireStock(c.get('caller'), 'freshness.read', await loadConfig(app.repo.db));
  return c.json(await freshness(app));
});
stockRoutes.post('/lots/:id/priority', async (c) => {
  const app = c.get('app');
  const { on } = z.object({ on: z.boolean() }).parse(await body(c));
  return c.json(await setLotPriority(app, c.get('caller'), c.req.param('id'), on, await loadConfig(app.repo.db)));
});
