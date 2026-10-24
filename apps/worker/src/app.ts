import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, type Vars } from './auth.js';
import { handleWebhook } from './bot/bot.js';
import { createContext } from './context.js';
import { isTestMode, type Env } from './env.js';
import { normalizeRoute, reportError } from './lib/alerts.js';
import { HttpError, toApiError } from './lib/errors.js';
import { healthInfo } from './lib/monitor.js';
import { clientRoutes } from './routes/client.js';
import { ownerConsoleRoutes, webRoutes, webSessionHandler } from './routes/console.js';
import { demoRoutes } from './routes/demo.js';
import { ownerRoutes } from './routes/owner.js';
import { ownerGrantRoutes } from './routes/ownerGrant.js';
import { exportByToken } from './routes/ownerClients.js';
import { handleSetup } from './routes/setup.js';
import { staffRoutes } from './routes/staff.js';
import { testRoutes } from './routes/test.js';

/**
 * One Worker serves:
 *   /api/*             JSON API (packages/contracts)
 *   /telegram/webhook  Telegram bot (grammY)
 *   /setup?key=…       one-click bot setup
 *   /health            liveness, DB reachability, last daily job run (no secrets)
 *   everything else    Mini App static files (ASSETS, SPA fallback to index.html)
 * wrangler.toml `run_worker_first` sends /api/*, /telegram/*, /setup, /health here
 * before the static assets.
 */
export type HonoEnv = { Bindings: Env; Variables: Vars };

const app = new Hono<HonoEnv>();

/** ctx.waitUntil of the request, or "just let it run" (app.request() in tests has no execution context). */
function deferOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  return (p: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p;
    }
  };
}

app.onError((err, c) => {
  const { status, body } = toApiError(err);
  // Unhandled errors / 5xx → Telegram alert to ALERT_CHAT_ID (throttled, in the background).
  if (status >= 500) {
    const kind = c.req.path.startsWith('/telegram/') ? 'webhook' : 'http';
    reportError(c.env, deferOf(c), { kind, route: `${c.req.method} ${normalizeRoute(c.req.path)}`, status }, err);
  }
  return c.json(body, status as 400);
});

// Before the context middleware: /health must answer (db: "unreachable") even if D1 is down.
app.get('/health', async (c) => {
  const info = await healthInfo(c.env, isTestMode(c.env));
  return c.json(info, info.ok ? 200 : 503);
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
    allowHeaders: ['Authorization', 'Content-Type', 'X-Test-User', 'X-Test-Name', 'X-Test-Key', 'Idempotency-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  })(c, next);
});

app.get('/setup', (c) => handleSetup(c, c.get('app')));
app.post('/telegram/webhook', (c) => handleWebhook(c, c.get('app')));

const api = new Hono<HonoEnv>();
api.use('*', authMiddleware);
api.route('/', clientRoutes);
api.route('/staff', staffRoutes);
api.route('/owner', ownerRoutes);
api.route('/owner', ownerConsoleRoutes);
api.route('/web', webRoutes);
api.route('/owner', ownerGrantRoutes);
// Test features only for testers (TEST_MODE + TEST_USERS, lib/testAccess.ts): for everybody else
// /api/test/* does not exist, exactly as in production.
api.use('/test/*', async (c, next) => {
  if (!c.get('app').testMode || !c.get('caller').tester) throw new HttpError(404, 'not_found', 'Не найдено');
  await next();
});
api.route('/test', testRoutes);
api.route('/test', demoRoutes);

// /api/test/* without TEST_MODE must be 404 even before auth.
app.all('/api/test/*', async (c, next) => {
  if (!isTestMode(c.env)) throw new HttpError(404, 'not_found', 'Не найдено');
  await next();
});
// Owner console login: exchanges a one-time link token, so it runs before the auth middleware.
app.post('/api/web/session', (c) => webSessionHandler(c, c.get('app')));
// CSV export via a one-time link (?token=…) opened in a normal browser: no auth header there.
// Without a token the request goes on to the authenticated owner route.
app.use('/api/owner/export/:file', async (c, next) => {
  const token = c.req.query('token');
  if (c.req.method !== 'GET' || !token) return next();
  return exportByToken(c, c.get('app'), c.req.param('file'), token);
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
