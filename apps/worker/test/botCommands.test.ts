import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buy, call, commandUpdate, makeStaff, mockTelegram, register, resetDb, T, webhook } from './helpers.js';

const OWNER_TG = 7001;
const CLIENT_TG = 6001;
const FLORIST = T + 1001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

const lastText = () => String(tg.sent().at(-1)?.payload.text ?? '');
const callback = (fromId: number, data: string) => ({
  callback_query: {
    id: `cq-${data}`,
    from: { id: fromId, is_bot: false, first_name: 'Амалия' },
    chat_instance: '1',
    data,
    message: { message_id: 5, date: 1, chat: { id: fromId, type: 'private' }, text: 'x' },
  },
});

describe('bot polish: /help, /stats, /start menu', () => {
  it('/help explains the program from the rules in force (no owner commands for a client)', async () => {
    await webhook(commandUpdate(CLIENT_TG, '/help'));
    const text = lastText();
    expect(text).toContain('🐝 Как работает «Медовые соты»');
    expect(text).toContain('Пчёлка 1% → Медовая 3% → Королева улья 5%');
    expect(text).toMatch(/покупка от 100\s000 сум/);
    expect(text).toContain('в сотах 3, 6, 10 ждут подарки-сюрпризы');
    expect(text).toContain('до 50% заказа');
    expect(text).toContain('90 дней');
    expect(text).toContain('/card');
    expect(text).not.toContain('/stats');
    // The menu button does the same.
    await webhook(callback(CLIENT_TG, 'help'));
    expect(lastText()).toContain('Как работает');
    expect(tg.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('/stats is for the owner only and summarises today and this week', async () => {
    await webhook(commandUpdate(CLIENT_TG, '/stats'));
    expect(lastText()).toBe('Эта команда доступна только владельцу 🐝');

    await makeStaff(OWNER_TG, 'owner', 'Владелец');
    await makeStaff(FLORIST, 'florist', 'Флорист');
    const a = await register(T + 5001);
    const b = await register(T + 5002);
    await buy(FLORIST, a.client!.id, 300_000);
    await buy(FLORIST, b.client!.id, 400_000, { idempotencyKey: 'stats-key-2' });
    await call('/api/staff/purchase', { user: FLORIST, body: { clientId: a.client!.id, amount: 200_000, redeem: true, idempotencyKey: 'stats-key-3' } });

    await webhook(commandUpdate(OWNER_TG, '/stats'));
    const text = lastText();
    expect(text).toContain('📊 Сводка Honey Flowers');
    expect(text).toMatch(/Сегодня, \d+ \S+:\n🛍 Покупок: 3 · выручка 900\s000 сум\n👋 Новых клиентов: 2\n🍯 Мёда начислено: 8\s970 · списано: 3\s000/);
    expect(text).toMatch(/За неделю \(с \d+ \S+\):\n🛍 Покупок: 3/);

    await webhook(callback(OWNER_TG, 'stats'));
    expect(lastText()).toContain('📊 Сводка Honey Flowers');
    await webhook(commandUpdate(OWNER_TG, '/help'));
    expect(lastText()).toContain('/stats — сводка для владельца');
  });

  it('/start shows the owner summary button only to the owner; the language button opens the language picker', async () => {
    await makeStaff(OWNER_TG, 'owner', 'Владелец');
    await webhook(commandUpdate(OWNER_TG, '/start'));
    const menu = tg.sent().at(-1)!.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
    expect(menu.inline_keyboard.at(-1)).toEqual([{ text: '📊 Сводка за сегодня', callback_data: 'stats' }]);

    await webhook(callback(CLIENT_TG, 'lang'));
    expect(tg.sent().at(-1)!.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }, { text: '🇺🇿 O‘zbekcha', callback_data: 'lang:uz' }]],
    });
  });

  it('/setup registers /help in the command list', async () => {
    await call('/setup?key=test-setup-key');
    const cmds = tg.calls.filter((c) => c.method === 'setMyCommands').map((c) => (c.payload.commands as Array<{ command: string }>).map((x) => x.command));
    expect(cmds).toEqual([
      ['start', 'card', 'help', 'lang'],
      ['start', 'card', 'help', 'lang'],
    ]);
  });
});
