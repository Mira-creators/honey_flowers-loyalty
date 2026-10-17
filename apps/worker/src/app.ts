import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, type Vars } from './auth.js';
import { handleWebhook } from './bot/bot.js';
import { createContext } from './context.js';
import { isTestMode, type Env } from './env.js';
import { HttpError, toApiError } from './lib/errors.js';
import { clientRoutes } from './routes/client.js';
import { ownerRoutes } from './routes/owner.js';
import { handleSetup } from './routes/setup.js';
import { staffRoutes } from './routes/staff.js';
import { testRoutes } from './routes/test.js';

/**
 * One Worker serves:
 *   /api/*             JSON API (packages/contracts)
 *   /telegram/webhook  Telegram bot (grammY)
 *   /setup?key=…       one-click bot setup
 *   /health            liveness
 *   everything else    Mini App static files (ASSETS, SPA fallback to index.html)
 * wrangler.toml `run_worker_first` sends /api/*, /telegram/*, /setup, /health here
 * before the static assets.
 */
export type HonoEnv = { Bindings: Env; Variables: Vars };

const app = new Hono<HonoEnv>();

app.onError((err, c) => {
  const { status, body } = toApiError(err);
  return c.json(body, status as 400);
});

// Context per request (repository, clock with test offset, service + notifier).
app.use('*', async (c, next) => {
  const waitUntil = (p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // no execution context (e.g. app.request() in tests): the promise still runs
      void p;
    }
  };
  const build = () => createContext(c.env, { waitUntil, requestOrigin: new URL(c.req.url).origin });
  c.set('app', await build());
  c.set('rebuild', async () => {
    const fresh = await build();
    c.set('app', fresh);
    return fresh;
  });
  await next();
});

// Same origin in production. In TEST_MODE allow a local Vite dev server to call the API.
app.use('/api/*', async (c, next) => {
  if (!isTestMode(c.env)) return next();
  return cors({
    origin: (origin) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'X-Test-User', 'X-Test-Name'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  })(c, next);
});

app.get('/health', (c) => c.json({ ok: true, testMode: isTestMode(c.env) }));
app.get('/setup', (c) => handleSetup(c, c.get('app')));
app.post('/telegram/webhook', (c) => handleWebhook(c, c.get('app')));

const api = new Hono<HonoEnv>();
api.use('*', authMiddleware);
api.route('/', clientRoutes);
api.route('/staff', staffRoutes);
api.route('/owner', ownerRoutes);
api.use('/test/*', async (c, next) => {
  if (!c.get('app').testMode) throw new HttpError(404, 'not_found', 'Не найдено');
  await next();
});
api.route('/test', testRoutes);

// /api/test/* without TEST_MODE must be 404 even before auth.
app.all('/api/test/*', async (c, next) => {
  if (!isTestMode(c.env)) throw new HttpError(404, 'not_found', 'Не найдено');
  await next();
});
app.route('/api', api);
app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'Нет такого метода API');
});
app.all('/telegram/*', () => {
  throw new HttpError(404, 'not_found', 'Не найдено');
});

// Static Mini App (only reached for paths not listed in run_worker_first, or in tests).
app.all('*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Mini App is not built (apps/miniapp/dist)', 404);
});

export default app;
