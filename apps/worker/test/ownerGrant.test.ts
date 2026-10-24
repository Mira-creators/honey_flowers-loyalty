import type { MeDTO, OperationDTO, OwnerGrantResultDTO, PurchaseResultDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { buy, call, json, key, makeStaff, mockTelegram, register, repo, resetDb, T, testEnv, tmaHeader } from './helpers.js';

const FLORIST = T + 1001;
const OWNER = T + 1002;
const CLIENT = T + 5001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(FLORIST, 'florist', 'Флорист Нигора');
  await makeStaff(OWNER, 'owner', 'Владелец');
});
afterEach(() => tg.restore());

const grant = (clientId: string, body: Record<string, unknown>, opts: { user?: number; idem?: string | null } = {}) =>
  call(`/api/owner/clients/${clientId}/grant`, {
    user: opts.user ?? OWNER,
    body,
    headers: opts.idem === null ? {} : { 'idempotency-key': opts.idem ?? 'grant-key-0001' },
  });

describe('owner grants without a purchase', () => {
  it('gift: lands in «Подарки» with its reason, the client is told, the journal shows it; a replay changes nothing', async () => {
    const me = await register(CLIENT, '+998901234567', 'Амалия');
    const id = me.client!.id;
    const res = await grant(id, { kind: 'gift', giftId: 'card', reason: 'извинение за задержку' });
    expect(res.status).toBe(201);
    const body = await json<OwnerGrantResultDTO>(res);
    expect(body).toMatchObject({ replayed: false, points: 0, gift: { type: 'card', status: 'available', source: 'grant', reason: 'извинение за задержку' } });
    expect(body.client.gifts).toHaveLength(1);
    expect(body.client.history[0]).toMatchObject({ kind: 'gift_granted', reason: 'извинение за задержку', staffName: 'Владелец' });
    expect(body.client.card.filled).toBe(0); // the honeycomb does not move

    const msg = tg.sent().find((m) => m.payload.chat_id === CLIENT)!;
    expect(String(msg.payload.text)).toBe('🎁 Подарок от Honey Flowers: Открытка в подарок! Повод: извинение за задержку. Он ждёт вас в разделе «Подарки».');

    const again = await grant(id, { kind: 'gift', giftId: 'card', reason: 'извинение за задержку' });
    expect(again.status).toBe(200);
    expect((await json<OwnerGrantResultDTO>(again)).replayed).toBe(true);
    expect(tg.sent().filter((m) => m.payload.chat_id === CLIENT)).toHaveLength(1);
    // Same key in the body instead of the header is the same operation.
    expect((await grant(id, { kind: 'gift', giftId: 'card', reason: 'извинение за задержку', idempotencyKey: 'grant-key-0001' }, { idem: null })).status).toBe(200);

    const ops = await json<OperationDTO[]>(call('/api/owner/operations', { user: OWNER }));
    expect(ops[0]).toMatchObject({ kind: 'gift_granted', clientId: id, staffName: 'Владелец', reason: 'извинение за задержку', points: 0 });

    // The florist hands it out like any gift.
    const used = await call(`/api/staff/gift/${encodeURIComponent(body.gift!.id)}/use`, { user: FLORIST, body: {} });
    expect(used.status).toBe(200);
  });

  it('a granted discount gift works in the next purchase', async () => {
    const me = await register(CLIENT);
    const res = await json<OwnerGrantResultDTO>(grant(me.client!.id, { kind: 'gift', giftId: 'disc10', reason: 'день рождения' }));
    const p = await buy(FLORIST, me.client!.id, 300_000, { giftId: res.gift!.id });
    expect(p.preview).toMatchObject({ discount: 30_000, paid: 270_000, cashback: 2_700 });
  });

  it('honey: bonus мёд with a reason, normal message, journal entry; key conflicts are 409', async () => {
    const me = await register(CLIENT);
    const id = me.client!.id;
    await buy(FLORIST, id, 500_000); // 5 000
    const res = await grant(id, { kind: 'honey', points: 20_000, reason: 'день рождения' }, { idem: 'honey-key-001' });
    expect(res.status).toBe(201);
    const body = await json<OwnerGrantResultDTO>(res);
    expect(body).toMatchObject({ replayed: false, points: 20_000, gift: null, client: { balance: 25_000 } });
    expect(body.client.history[0]).toMatchObject({ kind: 'manual', points: 20_000, reason: 'день рождения', staffName: 'Владелец' });
    // Numbers use no-break spaces (\s matches them).
    expect(String(tg.sent().at(-1)!.payload.text)).toMatch(/^🍯 Вам начислено 20\s000 мёда от Honey Flowers\. Повод: день рождения\. Баланс: 25\s000 мёда\.$/);
    const ops = await json<OperationDTO[]>(call('/api/owner/operations', { user: OWNER }));
    expect(ops[0]).toMatchObject({ kind: 'manual', points: 20_000, reason: 'день рождения', staffName: 'Владелец' });

    expect((await grant(id, { kind: 'honey', points: 20_000, reason: 'день рождения' }, { idem: 'honey-key-001' })).status).toBe(200);
    expect((await grant(id, { kind: 'honey', points: 30_000, reason: 'день рождения' }, { idem: 'honey-key-001' })).status).toBe(409);
    expect((await grant(id, { kind: 'gift', giftId: 'card', reason: 'день рождения' }, { idem: 'honey-key-001' })).status).toBe(409);
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).client!.balance).toBe(25_000);

    // The same key for ANOTHER client is a different operation (keys are per client).
    const other = await register(CLIENT + 1);
    expect((await grant(other.client!.id, { kind: 'honey', points: 1_000, reason: 'подарок' }, { idem: 'honey-key-001' })).status).toBe(201);
  });

  it('validation and access', async () => {
    const me = await register(CLIENT);
    const id = me.client!.id;
    expect((await grant(id, { kind: 'honey', points: 1_000, reason: 'подарок' }, { user: FLORIST })).status).toBe(403);
    expect((await grant(id, { kind: 'honey', points: 1_000, reason: 'подарок' }, { idem: null })).status).toBe(400);
    expect((await grant(id, { kind: 'honey', points: 0, reason: 'подарок' })).status).toBe(400);
    expect((await grant(id, { kind: 'honey', points: 1_000, reason: 'x' })).status).toBe(400);
    // 'mini' is a valid code but the current rules have no such gift.
    const mini = await grant(id, { kind: 'gift', giftId: 'mini', reason: 'подарок' });
    expect(mini.status).toBe(400);
    expect((await json(mini)).error.message).toMatch(/нет в правилах/);
    expect((await grant('0b6f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', { kind: 'honey', points: 1_000, reason: 'подарок' })).status).toBe(404);
  });

  it('an owner cannot grant to their own card outside TEST_MODE (allowed for testers in TEST_MODE)', async () => {
    // TEST_MODE: the owner-tester may (they play every role on one account).
    const self = await register(OWNER, '+998907770000', 'Владелец');
    expect((await grant(self.client!.id, { kind: 'honey', points: 1_000, reason: 'тест' })).status).toBe(201);

    const REAL = 4300;
    await makeStaff(REAL, 'owner', 'Хозяйка');
    const client = await repo().createClient({ telegramId: REAL, name: 'Хозяйка', phone: '+998907771111', language: 'ru', consentAt: new Date(), createdAt: new Date() });
    const res = await app.request(
      `/api/owner/clients/${client.id}/grant`,
      { method: 'POST', headers: { ...(await tmaHeader(REAL)), 'content-type': 'application/json', 'idempotency-key': key() }, body: JSON.stringify({ kind: 'honey', points: 5_000, reason: 'себе' }) },
      { ...testEnv, TEST_MODE: '0' },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error).toEqual({ code: 'self_operation', message: 'Нельзя начислять подарки на свою карту — попросите другого владельца' });
  });
});

describe('staff cannot operate on their own card («Моя карта»)', () => {
  const MSG = 'Нельзя проводить покупку на свою карту — попросите коллегу';

  it('purchase, preview and gift hand-out on the own card are refused; a colleague can do them', async () => {
    const mine = await register(FLORIST, '+998901110001', 'Нигора');
    const id = mine.client!.id;
    // /api/me of a florist carries their own client card (the «Моя карта» view).
    const me = await json<MeDTO>(call('/api/me', { user: FLORIST }));
    expect(me).toMatchObject({ role: 'florist', registered: true, client: { id } });

    const self = await call('/api/staff/purchase', { user: FLORIST, body: { clientId: id, amount: 200_000, redeem: false, idempotencyKey: key() } });
    expect(self.status).toBe(403);
    expect((await json(self)).error).toEqual({ code: 'self_operation', message: MSG });
    const preview = await call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId: id, amount: 200_000, redeem: false } });
    expect(preview.status).toBe(403);
    expect((await json(preview)).error.code).toBe('self_operation');

    const COLLEAGUE = T + 1003;
    await makeStaff(COLLEAGUE, 'florist', 'Дилноза');
    const ok = await call('/api/staff/purchase', { user: COLLEAGUE, body: { clientId: id, amount: 200_000, redeem: false, idempotencyKey: key() } });
    expect(ok.status).toBe(201);

    const gift = await json<OwnerGrantResultDTO>(grant(id, { kind: 'gift', giftId: 'card', reason: 'лучший флорист' }));
    const use = await call(`/api/staff/gift/${encodeURIComponent(gift.gift!.id)}/use`, { user: FLORIST, body: {} });
    expect(use.status).toBe(403);
    expect((await json(use)).error.code).toBe('self_operation');
    expect((await call(`/api/staff/gift/${encodeURIComponent(gift.gift!.id)}/use`, { user: COLLEAGUE, body: {} })).status).toBe(200);
  });

  it('a TEST_MODE tester switched to florist is refused too; as owner in TEST_MODE it is allowed', async () => {
    const TESTER = T + 9001;
    const me = await register(TESTER);
    await call('/api/test/role', { user: TESTER, body: { role: 'florist' } });
    const body = { clientId: me.client!.id, amount: 200_000, redeem: false };
    expect((await call('/api/staff/purchase', { user: TESTER, body: { ...body, idempotencyKey: key() } })).status).toBe(403);
    await call('/api/test/role', { user: TESTER, body: { role: 'owner' } });
    const res = await call('/api/staff/purchase', { user: TESTER, body: { ...body, idempotencyKey: key() } });
    expect(res.status).toBe(201);
    expect((await json<PurchaseResultDTO>(res)).client.balance).toBe(2_000);
  });

  it('outside TEST_MODE even the owner cannot charge their own card', async () => {
    const REAL = 4301;
    await makeStaff(REAL, 'owner', 'Хозяйка');
    const client = await repo().createClient({ telegramId: REAL, name: 'Хозяйка', phone: '+998907772222', language: 'ru', consentAt: new Date(), createdAt: new Date() });
    const res = await app.request(
      '/api/staff/purchase',
      { method: 'POST', headers: { ...(await tmaHeader(REAL)), 'content-type': 'application/json' }, body: JSON.stringify({ clientId: client.id, amount: 200_000, redeem: false, idempotencyKey: key() }) },
      { ...testEnv, TEST_MODE: '0' },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error).toEqual({ code: 'self_operation', message: MSG });
  });
});
