import type { EditableRulesDTO, MeDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, commandUpdate, contactUpdate, json, makeStaff, messageUpdate, mockTelegram, repo, resetDb, T, tmaHeader, webhook } from './helpers.js';

const USER = 6001;
const OWNER = T + 1;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

const lastText = () => String(tg.sent().at(-1)?.payload.text ?? '');

describe('telegram webhook', () => {
  it('rejects requests without or with a wrong secret token (no Bot API calls)', async () => {
    expect((await webhook(commandUpdate(USER, '/start'), null)).status).toBe(401);
    expect((await webhook(commandUpdate(USER, '/start'), 'wrong')).status).toBe(401);
    expect(tg.calls).toHaveLength(0);
  });

  it('/start for a new user: greeting with ru+uz, request_contact keyboard and web_app button', async () => {
    const res = await webhook(commandUpdate(USER, '/start'));
    expect(res.status).toBe(200);
    const [greet, card] = tg.sent();
    expect(String(greet!.payload.text)).toMatch(/Здравствуйте, Амалия!/);
    expect(String(greet!.payload.text)).toMatch(/Assalomu alaykum/);
    expect(greet!.payload.reply_markup).toMatchObject({
      keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
    expect(card!.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🐝 Открыть медовую карту', web_app: { url: 'https://honey.example.workers.dev' } }]],
    });
    // getMe is called once and cached.
    await webhook(commandUpdate(USER, '/card'));
    expect(tg.calls.filter((c) => c.method === 'getMe')).toHaveLength(1);
  });

  it('registration via contact: client created, phone normalized, welcome bonus credited, keyboard removed', async () => {
    // Owner sets a welcome bonus first.
    await makeStaff(OWNER, 'owner');
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, welcomeBonus: 10_000 } });

    const res = await webhook(contactUpdate(USER, '998 90 765 43 21'));
    expect(res.status).toBe(200);
    const client = await repo().findClientByTelegramId(USER);
    expect(client).toMatchObject({ phone: '+998907654321', name: 'Амалия', language: 'ru' });
    expect(client!.code).toMatch(/^HF\d{4,6}$/);

    const [welcome, card] = tg.sent();
    expect(String(welcome!.payload.text)).toContain('начислено 10 000 мёда');
    expect(String(welcome!.payload.text)).toContain(client!.code);
    expect(welcome!.payload.reply_markup).toEqual({ remove_keyboard: true });
    expect(card!.payload.reply_markup).toMatchObject({ inline_keyboard: [[{ web_app: { url: 'https://honey.example.workers.dev' } }]] });

    const me = await json<MeDTO>(call('/api/me', { headers: await tmaHeader(USER) }));
    expect(me.registered).toBe(true);
    expect(me.client!.balance).toBe(10_000);
    expect(me.client!.history[0]).toMatchObject({ kind: 'welcome', points: 10_000 });

    // Sending the contact again does not credit twice.
    await webhook(contactUpdate(USER, '+998907654321'));
    expect(lastText()).toBe('Ваша медовая карта 👇');
    expect(String(tg.sent().at(-2)!.payload.text)).toContain('Вы уже участник');
    expect((await json<MeDTO>(call('/api/me', { headers: await tmaHeader(USER) }))).client!.balance).toBe(10_000);

    // /start for a registered user: no contact keyboard.
    await webhook(commandUpdate(USER, '/start'));
    expect(String(tg.sent().at(-2)!.payload.text)).toContain(client!.code);
    expect(tg.sent().at(-2)!.payload.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('accepts only the sender\'s own contact', async () => {
    await webhook(contactUpdate(USER, '+998901112233', USER + 1));
    expect(await repo().findClientByTelegramId(USER)).toBeNull();
    expect(lastText()).toMatch(/свой собственный номер/);
  });

  it('a phone already used by another account is refused', async () => {
    await webhook(contactUpdate(USER, '+998901112233'));
    await webhook(contactUpdate(USER + 1, '+998901112233'));
    expect(await repo().findClientByTelegramId(USER + 1)).toBeNull();
    expect(lastText()).toMatch(/уже привязан/);
  });

  it('/lang switches the language via inline buttons; texts follow it', async () => {
    await webhook(commandUpdate(USER, '/lang'));
    expect(tg.sent().at(-1)!.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }, { text: '🇺🇿 O‘zbekcha', callback_data: 'lang:uz' }]],
    });
    await webhook({
      callback_query: { id: 'cq1', from: { id: USER, is_bot: false, first_name: 'Амалия' }, chat_instance: '1', data: 'lang:uz', message: { message_id: 5, date: 1, chat: { id: USER, type: 'private' }, text: 'x' } },
    });
    expect(tg.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    expect(tg.calls.find((c) => c.method === 'editMessageText')!.payload.text).toBe('Til: o‘zbekcha 🇺🇿');
    await webhook(commandUpdate(USER, '/card'));
    expect(tg.sent().at(-1)!.payload.reply_markup).toMatchObject({ inline_keyboard: [[{ text: '🐝 Asal kartasini ochish' }]] });
  });

  it('web_app_data is ignored, unknown text gets help', async () => {
    await webhook(messageUpdate(USER, { web_app_data: { data: '{}', button_text: 'x' } }));
    expect(tg.sent()).toHaveLength(0);
    await webhook(messageUpdate(USER, { text: 'привет' }));
    expect(lastText()).toMatch(/\/card/);
  });

  it('a failing handler still answers 200 (Telegram would retry forever otherwise)', async () => {
    tg.restore();
    tg = mockTelegram({ failSendMessage: true });
    const res = await webhook(commandUpdate(USER, '/start'));
    expect(res.status).toBe(200);
  });
});
