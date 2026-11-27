import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { applyBirthday, parseBirthdayInput } from '../lib/birthday.js';
import { HttpError } from '../lib/errors.js';
import { CONSENT_VERSION, legalDTO } from '../lib/legal.js';
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

/** GET /api/legal — Д1: «Как работает Медовая карта», «Правила программы», «Согласие на обработку ПД». */
clientRoutes.get('/legal', async (c) => {
  const app = c.get('app');
  const { rules } = await app.repo.getActiveRules(app.now());
  return c.json(legalDTO(rules));
});

/**
 * POST /api/me/consent { version } → MeDTO. Д1: the caller accepted the current texts (checkbox
 * «Принимаю»). Before registration it is kept for this Telegram user and copied to the card when it
 * is created; an existing client (asked once on the next open) gets it on the card at once.
 */
clientRoutes.post('/me/consent', async (c) => {
  const app = c.get('app');
  const { version } = z.object({ version: z.string().min(1).max(40) }).parse(await c.req.json().catch(() => ({})));
  if (version !== CONSENT_VERSION) throw new HttpError(409, 'conflict', 'Тексты правил обновились — откройте их ещё раз');
  await app.repo.setTgConsent(c.get('caller').telegramId, version, app.now());
  return c.json(await buildMe(app, c.get('caller')));
});

/** POST /api/me/birthday { birthday: 'YYYY-MM-DD' } → MeDTO. Л6: once; then only the owner changes it. */
clientRoutes.post('/me/birthday', async (c) => {
  const app = c.get('app');
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { birthday?: unknown };
  const birthday = parseBirthdayInput(body.birthday, app.now());
  const client = await app.repo.findClientByTelegramId(c.get('caller').telegramId);
  if (!client?.phone) throw new HttpError(403, 'not_registered', 'Сначала получите медовую карту');
  if (client.birthday) throw new HttpError(409, 'conflict', 'Дату рождения можно указать один раз. Чтобы изменить её, обратитесь в магазин.');
  // Atomic "only if still empty": a double tap cannot overwrite the first value.
  if (!(await app.repo.setBirthdayOnce(client.id, birthday))) {
    throw new HttpError(409, 'conflict', 'Дату рождения можно указать один раз. Чтобы изменить её, обратитесь в магазин.');
  }
  await applyBirthday(app, client.id);
  return c.json(await buildMe(app, c.get('caller')));
});
