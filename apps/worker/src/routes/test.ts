import type { TestRunExpiryDTO } from '@honey/contracts';
import { normalizePhone } from '@honey/service';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { runDailyJob } from '../cron.js';
import { HttpError } from '../lib/errors.js';
import { buildMe } from '../lib/summary.js';

/** TEST_MODE-only routes (the router answers 404 without TEST_MODE, see app.ts). */
export const testRoutes = new Hono<{ Variables: Vars }>();

/** POST /api/test/role { role } — switch the caller's own effective role. → MeDTO */
testRoutes.post('/role', async (c) => {
  const app = c.get('app');
  const { role } = z.object({ role: z.enum(['client', 'florist', 'manager', 'owner']) }).parse(await c.req.json());
  const caller = c.get('caller');
  await app.repo.setTestRole(caller.telegramId, role, app.now());
  return c.json(await buildMe(app, { ...caller, role }));
});

/** POST /api/test/clock { days } | { reset: true } — move the GLOBAL test clock. → MeDTO */
testRoutes.post('/clock', async (c) => {
  const app = c.get('app');
  const body = z
    .object({ days: z.number().int().min(-3650).max(3650).optional(), reset: z.boolean().optional() })
    .refine((b) => b.reset || b.days !== undefined, 'укажите days или reset')
    .parse(await c.req.json());
  const offset = body.reset ? 0 : app.clockOffsetDays + body.days!;
  if (offset < 0) throw new HttpError(400, 'validation', 'Нельзя уйти в прошлое раньше реального времени');
  await app.repo.setSetting('clock_offset_days', String(offset));
  // Rebuild the context so "now" in the response reflects the new offset.
  const fresh = await c.get('rebuild')();
  return c.json(await buildMe(fresh, c.get('caller')));
});

/** POST /api/test/run-expiry — runs the daily job now. */
testRoutes.post('/run-expiry', async (c) => {
  const res = await runDailyJob(c.get('app'));
  return c.json({ expired: res.expired, warned: res.warned } satisfies TestRunExpiryDTO);
});

/** POST /api/test/reset-me — delete the caller's client data (replay onboarding). → MeDTO */
testRoutes.post('/reset-me', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const client = await app.repo.findClientByTelegramId(caller.telegramId);
  if (client) await app.repo.deleteClient(client.id);
  return c.json(await buildMe(app, caller));
});

/** POST /api/test/register { phone, name } — browser-only registration shortcut. → MeDTO */
testRoutes.post('/register', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const body = z.object({ phone: z.string().min(4).max(30), name: z.string().trim().min(1).max(60) }).parse(await c.req.json());
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'validation', 'Не похоже на номер телефона');
  const user = await app.repo.getTgUser(caller.telegramId);
  await app.service.registerWithPhone({ telegramId: caller.telegramId, name: body.name, phone, language: user?.language ?? 'ru' });
  await app.repo.linkStaffByPhone(phone, caller.telegramId);
  return c.json(await buildMe(app, caller), 201);
});
