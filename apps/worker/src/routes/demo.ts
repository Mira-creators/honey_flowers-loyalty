import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { clearDemo, DEMO_CHUNKS, seedDemoChunk } from '../demo/seed.js';

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
