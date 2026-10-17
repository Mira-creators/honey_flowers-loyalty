import { normalizePhone, PhoneTakenError, timingSafeEqualStr } from '@honey/service';
import { Bot, InlineKeyboard, Keyboard, webhookCallback, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Context as HonoContext } from 'hono';
import type { AppContext } from '../context.js';
import { apiBase, webAppKeyboard } from './telegramApi.js';
import { asLang, t, type BotLang } from './texts.js';

/**
 * Telegram bot (grammY) behind POST /telegram/webhook.
 *
 * Private chats only (group / channel updates are ignored).
 *
 *   /start   greeting (ru + uz line); not registered → "📱 Поделиться номером" (request_contact)
 *            + inline web_app button "🐝 Открыть медовую карту"
 *   contact  only the sender's own contact: normalize phone, create client / attach phone,
 *            welcome bonus via the engine, reply + web_app button, remove the keyboard
 *   /card    web_app button
 *   /lang    inline ru / uz
 *   web_app_data → ignored; any other text → short help
 */

async function langOf(app: AppContext, ctx: Context): Promise<BotLang> {
  const id = ctx.from?.id;
  if (!id) return 'ru';
  const u = await app.repo.getTgUser(id);
  return asLang(u?.language ?? (ctx.from?.language_code?.startsWith('uz') ? 'uz' : 'ru'));
}

async function sendCardButton(app: AppContext, ctx: Context, lang: BotLang, text?: string) {
  const T = t(lang);
  const kb = webAppKeyboard(T.openCardButton, await app.origin());
  if (!kb) {
    await ctx.reply(T.cardUnavailable);
    return;
  }
  await ctx.reply(text ?? T.openCardHint, { reply_markup: kb });
}

export function createBot(app: AppContext, botInfo: UserFromGetMe): Bot {
  const bot = new Bot(app.env.BOT_TOKEN ?? '', { botInfo, client: { apiRoot: apiBase(app.env) } });

  // Error boundary: a failing handler must not make Telegram re-deliver the update forever.
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from && !ctx.from.is_bot) {
        await app.repo.touchTgUser(
          {
            telegramId: ctx.from.id,
            firstName: ctx.from.first_name ?? null,
            username: ctx.from.username ?? null,
            language: ctx.from.language_code?.startsWith('uz') ? 'uz' : 'ru',
          },
          app.now(),
        );
      }
      await next();
    } catch (err) {
      console.error('bot handler failed', err);
    }
  });

  // The loyalty card is personal: the bot talks only in private chats. Updates from
  // groups, supergroups and channels are acknowledged (200) and otherwise ignored, so a
  // member's card code never lands in a group.
  const pm = bot.chatType('private');

  pm.command('start', async (ctx) => {
    const lang = await langOf(app, ctx);
    const T = t(lang);
    const name = ctx.from?.first_name || '👋';
    const client = ctx.from ? await app.repo.findClientByTelegramId(ctx.from.id) : null;
    if (client?.phone) {
      await ctx.reply(`${T.greeting(name)}\n\n${T.alreadyRegistered(client.code)}`, { reply_markup: { remove_keyboard: true } });
      await sendCardButton(app, ctx, lang);
      return;
    }
    await ctx.reply(`${T.greeting(name)}\n\n${T.askContact}`, {
      reply_markup: new Keyboard().requestContact(T.contactButton).resized().oneTime(),
    });
    await sendCardButton(app, ctx, lang);
  });

  pm.command('card', async (ctx) => {
    await sendCardButton(app, ctx, await langOf(app, ctx));
  });

  pm.command('lang', async (ctx) => {
    await ctx.reply(t('ru').langPrompt, {
      reply_markup: new InlineKeyboard().text('🇷🇺 Русский', 'lang:ru').text('🇺🇿 O‘zbekcha', 'lang:uz'),
    });
  });

  pm.callbackQuery(/^lang:(ru|uz)$/, async (ctx) => {
    const lang = asLang(ctx.match[1]);
    await app.repo.setLanguage(ctx.from.id, lang, app.now());
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(t(lang).langSet);
    } catch {
      await ctx.reply(t(lang).langSet);
    }
  });

  pm.on('callback_query', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  pm.on('message:contact', async (ctx) => {
    const lang = await langOf(app, ctx);
    const T = t(lang);
    const contact = ctx.message.contact;
    if (!ctx.from || contact.user_id !== ctx.from.id) {
      await ctx.reply(T.notOwnContact, { reply_markup: new Keyboard().requestContact(T.contactButton).resized().oneTime() });
      return;
    }
    const phone = normalizePhone(contact.phone_number);
    if (!phone) {
      await ctx.reply(T.badPhone, { reply_markup: new Keyboard().requestContact(T.contactButton).resized().oneTime() });
      return;
    }
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || ctx.from.first_name || null;
    try {
      const existing = await app.repo.findClientByTelegramId(ctx.from.id);
      const res = await app.service.registerWithPhone({ telegramId: ctx.from.id, name, phone, language: lang });
      await app.repo.linkStaffByPhone(phone, ctx.from.id);
      const text = existing?.phone && res.welcomeBonus === 0 ? T.alreadyRegistered(res.client.code) : T.welcome(res.welcomeBonus, res.client.code);
      await ctx.reply(text, { reply_markup: { remove_keyboard: true } });
      await sendCardButton(app, ctx, lang);
    } catch (err) {
      if (err instanceof PhoneTakenError) {
        await ctx.reply(T.phoneTaken, { reply_markup: { remove_keyboard: true } });
        return;
      }
      throw err;
    }
  });

  // Data sent by the Mini App via Telegram.WebApp.sendData(): not used, ignore silently.
  pm.on('message:web_app_data', () => undefined);

  pm.on('message:text', async (ctx) => {
    await ctx.reply(t(await langOf(app, ctx)).help);
  });

  return bot;
}

/** Cached getMe result (settings.bot_info); calls getMe once and stores it. */
export async function getBotInfo(app: AppContext): Promise<UserFromGetMe> {
  const cached = await app.repo.getSetting('bot_info');
  if (cached) {
    try {
      return JSON.parse(cached) as UserFromGetMe;
    } catch {
      // fall through
    }
  }
  const probe = new Bot(app.env.BOT_TOKEN ?? '', { client: { apiRoot: apiBase(app.env) } });
  await probe.init();
  await app.repo.setSetting('bot_info', JSON.stringify(probe.botInfo));
  if (probe.botInfo.username) await app.repo.setSetting('bot_username', probe.botInfo.username);
  return probe.botInfo;
}

/** Hono handler for POST /telegram/webhook. */
export async function handleWebhook(c: HonoContext, app: AppContext): Promise<Response> {
  const secret = app.env.WEBHOOK_SECRET;
  if (!app.env.BOT_TOKEN || !secret) {
    return c.json({ error: { code: 'internal', message: 'BOT_TOKEN / WEBHOOK_SECRET не настроены' } }, 503);
  }
  // Reject foreign requests before doing any work (getMe, DB).
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqualStr(given, secret)) {
    return c.json({ error: { code: 'unauthorized', message: 'Неверный секрет вебхука' } }, 401);
  }
  const bot = createBot(app, await getBotInfo(app));
  // grammY checks X-Telegram-Bot-Api-Secret-Token (constant-time) and answers 401 on mismatch.
  const handle = webhookCallback(bot, 'hono', { secretToken: secret, onTimeout: 'return', timeoutMilliseconds: 25_000 });
  return (await handle(c)) as Response;
}
