import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { clearDemo, DEMO_CHUNKS, demoAnchor, seedDemoChunk } from '../demo/seed.js';
import { seedStockDemoChunk, STOCK_DEMO_CHUNKS } from '../demo/stock.js';
import { HttpError } from '../lib/errors.js';
import { stockEnabled } from '../stock/core.js';

/**
 * TEST_MODE-only demo data for the briefing (mounted under /api/test, 404 without TEST_MODE):
 *   POST /api/test/demo-seed { chunk }  → TestDemoSeedDTO   (call chunk 0, 1, … until finished)
 *   POST /api/test/demo-clear           → TestDemoClearDTO  (removes exactly the demo records)
 * Chunks keep every request within the Workers Free limits (10 ms CPU, 50 D1 queries).
 */
export const demoRoutes = new Hono<{ Variables: Vars }>();

demoRoutes.post('/demo-seed', async (c) => {
  const { chunk } = z
    .object({ chunk: z.number().int().min(0).max(DEMO_CHUNKS - 1) })
    .parse(await c.req.json().catch(() => ({})));
  return c.json(await seedDemoChunk(c.get('app'), chunk));
});

demoRoutes.post('/demo-clear', async (c) => c.json(await clearDemo(c.get('app'))));

/**
 * «Склад» demo (STOCK_ENABLED): POST /api/test/demo-stock { chunk } → 30 days of receipts, bouquets,
 * sales (linked to demo loyalty purchases of the same day), showcase, write-offs. Run after demo-seed.
 */
demoRoutes.post('/demo-stock', async (c) => {
  if (!stockEnabled(c.get('app').env)) throw new HttpError(404, 'not_found', 'Не найдено');
  const { chunk } = z
    .object({ chunk: z.number().int().min(0).max(STOCK_DEMO_CHUNKS - 1) })
    .parse(await c.req.json().catch(() => ({})));
  const app = c.get('app');
  return c.json(await seedStockDemoChunk(app, chunk, await demoAnchor(app)));
});
