import { normalizePhone, timingSafeEqualStr } from '@honey/service';
import type { Context } from 'hono';
import { getBotInfo } from '../bot/bot.js';
import { tgCall } from '../bot/telegramApi.js';
import { COMMANDS, TEXTS } from '../bot/texts.js';
import type { AppContext } from '../context.js';
import { classifyPhoneOrId } from './owner.js';

/**
 * GET /setup?key=SETUP_KEY — one-click bot setup after deploy:
 *   setWebhook (origin + /telegram/webhook, secret_token, message + callback_query),
 *   setMyCommands (ru default + uz), setChatMenuButton (web_app → origin),
 *   stores origin, bot username and bot info in settings.
 *   Optional &owner=<phone | telegram id> adds the first owner (staff table).
 * Returns JSON describing every step.
 */
export async function handleSetup(c: Context, app: AppContext): Promise<Response> {
  const env = app.env;
  const key = c.req.query('key') ?? '';
  if (!env.SETUP_KEY) return c.json({ ok: false, error: 'SETUP_KEY secret is not set (Settings → Variables and Secrets)' }, 503);
  if (!timingSafeEqualStr(key, env.SETUP_KEY)) return c.json({ ok: false, error: 'wrong key' }, 403);
  const missing = (['BOT_TOKEN', 'WEBHOOK_SECRET'] as const).filter((k) => !env[k]);
  if (missing.length) return c.json({ ok: false, error: `missing secrets: ${missing.join(', ')}` }, 503);

  const url = new URL(c.req.url);
  const origin = (env.PUBLIC_URL?.trim() || `https://${url.host}`).replace(/\/+$/, '');
  if (!origin.startsWith('https://')) {
    return c.json({ ok: false, error: `Telegram needs an https URL, got ${origin}. Set PUBLIC_URL or open /setup via https.` }, 400);
  }
  const webhookUrl = `${origin}/telegram/webhook`;
  const steps: Array<{ step: string; ok: boolean; detail?: unknown }> = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, ...(detail === undefined || detail === true ? {} : { detail }) });
    } catch (e) {
      steps.push({ step: name, ok: false, detail: String(e) });
    }
  };

  await app.repo.setSetting('public_url', origin);
  // Re-read getMe on every setup (token may have changed).
  await app.repo.setSetting('bot_info', '');
  let username: string | null = null;
  await step('getMe', async () => {
    const info = await getBotInfo(app);
    username = info.username;
    return { id: info.id, username: info.username };
  });
  await step('setWebhook', () =>
    tgCall(env, 'setWebhook', {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 40,
    }),
  );
  await step('setMyCommands', async () => {
    await tgCall(env, 'setMyCommands', { commands: COMMANDS.ru });
    await tgCall(env, 'setMyCommands', { commands: COMMANDS.uz, language_code: 'uz' });
  });
  await step('setChatMenuButton', () =>
    tgCall(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: TEXTS.ru.menuButton, web_app: { url: origin } } }),
  );
  await step('getWebhookInfo', async () => {
    const info = await tgCall<{ url: string; pending_update_count: number; last_error_message?: string }>(env, 'getWebhookInfo');
    return { url: info.url, pending: info.pending_update_count, lastError: info.last_error_message ?? null };
  });

  // Optional: &owner=<phone or telegram id> creates the first owner (needed when TEST_MODE = "0").
  const ownerArg = c.req.query('owner')?.trim();
  if (ownerArg) {
    await step('addOwner', async () => {
      const { kind, value } = classifyPhoneOrId(ownerArg);
      if (kind === 'ambiguous') throw new Error(`"${ownerArg}" is ambiguous: write a phone as +998… (URL-encode + as %2B) or a Telegram id as id:${ownerArg}`);
      const phone = kind === 'phone' ? normalizePhone(value) : null;
      const telegramId = phone ? null : Number(value);
      if (!phone && (!Number.isSafeInteger(telegramId) || telegramId! <= 0)) throw new Error('owner must be a phone (+998…) or a Telegram id');
      const client = phone ? await app.repo.findClientByPhone(phone) : await app.repo.findClientByTelegramId(telegramId!);
      const member = await app.repo.upsertStaff(
        { telegramId: client?.telegramId ?? telegramId, phone: phone ?? client?.phone ?? null, name: client?.name ?? 'Владелец', role: 'owner' },
        app.now(),
      );
      return { id: member.id, telegramId: member.telegramId, phone: member.phone ?? null };
    });
  }

  const ok = steps.every((s) => s.ok);
  return c.json(
    {
      ok,
      origin,
      webhook: webhookUrl,
      bot: username ? `https://t.me/${username}` : null,
      testMode: app.testMode,
      steps,
      next: ok
        ? 'Готово. Откройте бота в Telegram и нажмите /start.'
        : 'Есть ошибки: проверьте BOT_TOKEN и откройте эту ссылку ещё раз.',
    },
    ok ? 200 : 502,
  );
}
