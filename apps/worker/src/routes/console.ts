import type {
  ClientActivity,
  ConsoleClientSort,
  ConsoleOpKind,
  ImportBatchDTO,
  WebLinkDTO,
  WebMeDTO,
  WebSessionDTO,
} from '@honey/contracts';
import { CONSOLE_OP_KINDS } from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, localDateKey } from '@honey/core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { actingStaff, requireRole, type Vars } from '../auth.js';
import { tgCall } from '../bot/telegramApi.js';
import {
  clientsPage,
  cohorts,
  decodeCursor,
  isClientCursor,
  isOpsCursor,
  operationsPage,
  overview,
  period,
  type Period,
} from '../console/analytics.js';
import { importSchema, listBatches, runImport, undoBatch } from '../console/importer.js';
import {
  bumpSessionVersion,
  consumeLinkToken,
  createLinkToken,
  effectiveRole,
  ensureSessionVersion,
  EXPIRED_LINK_MESSAGE,
  lookupOwner,
  sessionKey,
  signSession,
  WEB_SESSION_TTL_MS,
} from '../console/webAuth.js';
import type { AppContext } from '../context.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { isTester, testPolicy } from '../lib/testAccess.js';

/**
 * Owner web console ("Кабинет владельца", apps/miniapp/console.html):
 *   POST /api/owner/web-link               one-time login link (from the Mini App; also sent to the bot chat)
 *   POST /api/web/session                  link token → browser session (no auth; see webSessionHandler)
 *   GET  /api/web/me, POST /api/web/logout
 *   GET  /api/owner/console/overview|clients|operations|cohorts
 *   POST /api/owner/import, GET /api/owner/import/batches, POST /api/owner/import/:id/undo
 * Every analytics endpoint = auth (2 queries for a web session) + 1 data round trip (+1 rules).
 */

type C = Context<{ Bindings: Env; Variables: Vars }>;

export const ownerConsoleRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();
export const webRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

ownerConsoleRoutes.use('*', async (c, next) => {
  requireRole(c, ['owner']);
  await next();
});

function waitUntil(c: C, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p; // app.request() in tests: no execution context, the promise still runs
  }
}

// ------------------------------------------------------------------ login link

ownerConsoleRoutes.post('/web-link', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  if (caller.via === 'webSession') throw new HttpError(403, 'forbidden', 'Новую ссылку можно получить только в приложении в Telegram');
  const { token, expiresAt } = await createLinkToken(app.repo.db, caller.telegramId, Date.now());
  const origin = (await app.origin()) ?? new URL(c.req.url).origin;
  const url = `${origin}/console.html#t=${token}`;
  let sentToChat = false;
  // Real Telegram users also get the link in the bot chat (handy in Telegram Desktop).
  if (caller.via === 'initData' && app.env.BOT_TOKEN && url.startsWith('https://')) {
    sentToChat = true;
    waitUntil(
      c,
      tgCall(app.env, 'sendMessage', {
        chat_id: caller.telegramId,
        text: '💻 Кабинет владельца на компьютере\n\nСсылка действует 10 минут и открывается один раз. Никому её не пересылайте.',
        protect_content: true,
        reply_markup: { inline_keyboard: [[{ text: 'Открыть кабинет', url }]] },
      }).catch((e) => console.error('web-link message failed', e)),
    );
  }
  return c.json({ url, expiresAt, sentToChat } satisfies WebLinkDTO, 201);
});

/** POST /api/web/session { token } — registered in app.ts BEFORE the auth middleware. */
export async function webSessionHandler(c: C, app: AppContext): Promise<Response> {
  const { token } = z.object({ token: z.string().min(1).max(200) }).parse(await c.req.json().catch(() => ({})));
  const nowMs = Date.now();
  const telegramId = await consumeLinkToken(app.repo.db, token, nowMs);
  if (!telegramId) throw new HttpError(401, 'expired', EXPIRED_LINK_MESSAGE);
  const owner = await lookupOwner(app.repo.db, telegramId);
  const tester = await isTester(testPolicy(app.env), telegramId, async () => [owner.staffPhone, owner.clientPhone]);
  if (effectiveRole(owner, tester) !== 'owner') throw new HttpError(403, 'forbidden', 'Кабинет доступен только владельцу');
  const ver = await ensureSessionVersion(app.repo.db, telegramId, nowMs);
  const exp = nowMs + WEB_SESSION_TTL_MS;
  const session = await signSession(await sessionKey(app.env), { tid: telegramId, ver, iat: nowMs, exp });
  const body: WebSessionDTO = { session, expiresAt: new Date(exp).toISOString(), name: owner.staffName || owner.firstName || 'Владелец' };
  return c.json(body, 201);
}

webRoutes.get('/me', async (c) => {
  const app = c.get('app');
  const caller = requireRole(c, ['owner']);
  const body: WebMeDTO = {
    telegramId: caller.telegramId,
    name: caller.firstName,
    via: caller.via,
    testMode: caller.tester,
    now: app.now().toISOString(),
    sessionExpiresAt: caller.sessionExpiresAt ? new Date(caller.sessionExpiresAt).toISOString() : null,
  };
  return c.json(body);
});

/** Logout = revoke every browser session of this owner (bumps the session version). */
webRoutes.post('/logout', async (c) => {
  const caller = c.get('caller');
  await bumpSessionVersion(c.get('app').repo.db, caller.telegramId, Date.now());
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ query parsing

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3660;

function isDay(v: string): boolean {
  if (!DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseRange(from: string | undefined, to: string | undefined, label: string): Period | null {
  if (!from && !to) return null;
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new HttpError(400, 'validation', `${label}: укажите даты в формате ГГГГ-ММ-ДД`);
  for (const d of [from, to]) if (!isDay(d)) throw new HttpError(400, 'validation', `${label}: такой даты нет — ${d}`);
  const days = dayNumberFromKey(to) - dayNumberFromKey(from) + 1;
  if (days < 1) throw new HttpError(400, 'validation', `${label}: дата «с» позже даты «по»`);
  if (days > MAX_DAYS) throw new HttpError(400, 'validation', `${label}: не больше 10 лет`);
  return period(from, to);
}

/** Period from ?from&to, default = the last 30 days (Tashkent) ending today. */
function periodOrDefault(c: C): Period {
  const p = parseRange(c.req.query('from'), c.req.query('to'), 'Период');
  if (p) return p;
  const today = localDateKey(c.get('app').now(), 'Asia/Tashkent');
  return period(keyFromDayNumber(dayNumberFromKey(today) - 29), today);
}

function optInt(c: C, name: string, max = Number.MAX_SAFE_INTEGER): number | null {
  const v = c.req.query(name);
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, 'validation', `Неверное значение ${name}`);
  return Math.round(n);
}

function limitOf(c: C, def: number, max: number): number {
  return Math.min(max, Math.max(1, optInt(c, 'limit') ?? def));
}

const SORTS: ConsoleClientSort[] = ['name', 'registered', 'count', 'total', 'avg', 'last', 'balance', 'level'];
const ACTIVITY: ClientActivity[] = ['active', 'sleeping', 'gone', 'never'];

// ------------------------------------------------------------------ analytics

ownerConsoleRoutes.get('/console/overview', async (c) => {
  const app = c.get('app');
  const now = app.now();
  return c.json(await overview(app.repo.db, periodOrDefault(c), localDateKey(now, 'Asia/Tashkent'), now.toISOString()));
});

ownerConsoleRoutes.get('/console/clients', async (c) => {
  const app = c.get('app');
  const q = (k: string) => c.req.query(k) || null;
  const sort = (q('sort') ?? 'last') as ConsoleClientSort;
  if (!SORTS.includes(sort)) throw new HttpError(400, 'validation', 'Неверная сортировка');
  const activity = q('activity') as ClientActivity | null;
  if (activity && !ACTIVITY.includes(activity)) throw new HttpError(400, 'validation', 'Неверный фильтр активности');
  const linked = q('linked');
  if (linked && linked !== 'tg' && linked !== 'pending') throw new HttpError(400, 'validation', 'Неверный фильтр linked');
  const bmonth = optInt(c, 'bmonth', 12);
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const cursor = q('cursor');
  const decoded = decodeCursor(cursor, isClientCursor);
  if (cursor && !decoded) throw new HttpError(400, 'validation', 'Неверный курсор');
  return c.json(
    await clientsPage(app.repo.db, rules, now.toISOString(), {
      period: parseRange(c.req.query('from'), c.req.query('to'), 'Период'),
      registered: parseRange(c.req.query('regFrom'), c.req.query('regTo'), 'Регистрация'),
      level: q('level'),
      minCount: optInt(c, 'minCount'),
      maxCount: optInt(c, 'maxCount'),
      minTotal: optInt(c, 'minTotal'),
      maxTotal: optInt(c, 'maxTotal'),
      minAvg: optInt(c, 'minAvg'),
      maxAvg: optInt(c, 'maxAvg'),
      activity,
      bmonth: bmonth && bmonth >= 1 ? bmonth : null,
      gift: q('gift') === '1',
      linked: linked as 'tg' | 'pending' | null,
      q: q('q')?.slice(0, 60) ?? null,
      sort,
      dir: q('dir') === 'asc' ? 'asc' : 'desc',
      cursor: decoded,
      limit: limitOf(c, 50, 1000),
    }),
  );
});

ownerConsoleRoutes.get('/console/operations', async (c) => {
  const app = c.get('app');
  const rawKinds = c.req.query('kinds');
  const kinds = rawKinds ? (rawKinds.split(',').filter(Boolean) as ConsoleOpKind[]) : CONSOLE_OP_KINDS;
  if (kinds.some((k) => !CONSOLE_OP_KINDS.includes(k))) throw new HttpError(400, 'validation', 'Неверный тип операции');
  const cursor = c.req.query('cursor');
  const decoded = decodeCursor(cursor, isOpsCursor);
  if (cursor && !decoded) throw new HttpError(400, 'validation', 'Неверный курсор');
  return c.json(
    await operationsPage(app.repo.db, {
      period: periodOrDefault(c),
      kinds,
      staff: c.req.query('staff')?.slice(0, 80) || null,
      minAmount: optInt(c, 'minAmount'),
      maxAmount: optInt(c, 'maxAmount'),
      cursor: decoded,
      limit: limitOf(c, 50, 1000),
      totals: c.req.query('totals') === '1',
    }),
  );
});

ownerConsoleRoutes.get('/console/cohorts', async (c) => {
  const months = Math.max(1, Math.min(36, optInt(c, 'months') ?? 12));
  return c.json(await cohorts(c.get('app').repo.db, c.get('app').now().toISOString(), months));
});

// ------------------------------------------------------------------ import

ownerConsoleRoutes.post('/import', async (c) => {
  const app = c.get('app');
  const req = importSchema.parse(await c.req.json());
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const res = await runImport(app.repo.db, rules, actingStaff(c.get('caller')).id, req, now);
  return c.json(res, req.dryRun ? 200 : 201);
});

ownerConsoleRoutes.get('/import/batches', async (c) => {
  return c.json((await listBatches(c.get('app').repo.db)) satisfies ImportBatchDTO[]);
});

ownerConsoleRoutes.post('/import/:id/undo', async (c) => {
  const app = c.get('app');
  return c.json((await undoBatch(app.repo.db, c.req.param('id'), app.now())) satisfies ImportBatchDTO);
});
