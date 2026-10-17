import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { buildMe } from '../lib/summary.js';

export const clientRoutes = new Hono<{ Variables: Vars }>();

/** GET /api/me — who am I, my card (if registered), public rules, server "now". */
clientRoutes.get('/me', async (c) => c.json(await buildMe(c.get('app'), c.get('caller'))));

/** POST /api/me/lang { lang } → MeDTO */
clientRoutes.post('/me/lang', async (c) => {
  const app = c.get('app');
  const { lang } = z.object({ lang: z.enum(['ru', 'uz']) }).parse(await c.req.json());
  await app.repo.setLanguage(c.get('caller').telegramId, lang, app.now());
  return c.json(await buildMe(app, c.get('caller')));
});
