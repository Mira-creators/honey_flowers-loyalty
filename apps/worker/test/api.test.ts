import type {
  EditableRulesDTO,
  MeDTO,
  OperationDTO,
  OwnerStatsDTO,
  PurchasePreviewDTO,
  PurchaseResultDTO,
  ReverseResultDTO,
  StaffClientLookupDTO,
  StaffDTO,
  UseGiftResultDTO,
} from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { buy, call, json, key, makeStaff, mockTelegram, moveClock, register, repo, resetDb, setRole, testEnv, tmaHeader } from './helpers.js';

const FLORIST = 1001;
const OWNER = 1002;
const CLIENT = 5001;

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(FLORIST, 'florist', 'Флорист Нигора');
  await makeStaff(OWNER, 'owner', 'Владелец');
});
afterEach(() => tg.restore());

describe('auth', () => {
  it('rejects requests without auth', async () => {
    const res = await call('/api/me');
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });

  it('accepts a correctly signed Telegram initData and rejects a bad signature', async () => {
    const good = await call('/api/me', { headers: await tmaHeader(CLIENT, { first_name: 'Амалия' }) });
    expect(good.status).toBe(200);
    const me = await json<MeDTO>(good);
    expect(me).toMatchObject({ telegramId: CLIENT, firstName: 'Амалия', role: 'client', registered: false, client: null, testMode: true });

    const forged = (await tmaHeader(CLIENT)).authorization.replace(/hash=[0-9a-f]{6}/, 'hash=000000');
    const bad = await call('/api/me', { headers: { authorization: forged } });
    expect(bad.status).toBe(401);
    expect((await json(bad)).error.message).toMatch(/BAD_HASH/);

    const stale = await call('/api/me', { headers: await tmaHeader(CLIENT, {}, new Date(Date.now() - 2 * 86_400_000)) });
    expect(stale.status).toBe(401);
    expect((await json(stale)).error.message).toMatch(/EXPIRED/);
  });

  it('X-Test-User works only in TEST_MODE; /api/test/* is 404 otherwise', async () => {
    const prodEnv = { ...testEnv, TEST_MODE: '0' };
    const r1 = await app.request('/api/me', { headers: { 'x-test-user': String(CLIENT) } }, prodEnv);
    expect(r1.status).toBe(401);
    const r2 = await app.request('/api/test/role', { method: 'POST', headers: { 'x-test-user': '1', 'content-type': 'application/json' }, body: '{"role":"owner"}' }, prodEnv);
    expect(r2.status).toBe(404);
    const r3 = await app.request('/api/me', { headers: await tmaHeader(CLIENT) }, prodEnv);
    expect(r3.status).toBe(200);
    expect((await json<MeDTO>(r3)).testMode).toBe(false);
  });

  it('effective role: staff table, else TEST_MODE override, else client', async () => {
    expect((await json<MeDTO>(call('/api/me', { user: FLORIST }))).role).toBe('florist');
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).role).toBe('client');
    await setRole(CLIENT, 'manager');
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).role).toBe('manager');
    await setRole(CLIENT, 'client');
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).role).toBe('client');
  });
});

describe('client', () => {
  it('/api/test/register creates a client with a short code; /api/me shows the card', async () => {
    const me = await register(CLIENT, '+998 90 123-45-67', 'Амалия');
    expect(me.registered).toBe(true);
    expect(me.client).toMatchObject({
      name: 'Амалия',
      phoneMasked: '+998 90 ••• •• 67',
      lang: 'ru',
      balance: 0,
      spent: 0,
      level: { id: 'bee', name: 'Пчёлка', pct: 1, from: 0 },
      next: { id: 'honey', pct: 3, from: 2_000_000, left: 2_000_000 },
      card: { cycle: 1, filled: 0, cells: 10, gifts: { '3': 'card', '6': 'delivery', '10': 'disc10' } },
      expiresAt: null,
      gifts: [],
      history: [],
    });
    expect(me.client!.code).toMatch(/^HF\d{4,6}$/);
    expect(me.rules).toMatchObject({ minPurchaseForCell: 100_000, maxRedeemPct: 50, expiryDays: 90, cells: 10 });
    expect(me.clockOffsetDays).toBe(0);
    expect(Math.abs(Date.parse(me.now) - Date.now())).toBeLessThan(60_000);
  });

  it('POST /api/me/lang switches the language', async () => {
    await register(CLIENT);
    const res = await call('/api/me/lang', { user: CLIENT, body: { lang: 'uz' } });
    expect(res.status).toBe(200);
    expect((await json<MeDTO>(res)).client!.lang).toBe('uz');
    expect((await call('/api/me/lang', { user: CLIENT, body: { lang: 'en' } })).status).toBe(400);
  });

  it('a phone cannot be taken by another Telegram account', async () => {
    await register(CLIENT, '+998901112233');
    const res = await call('/api/test/register', { user: CLIENT + 1, body: { phone: '901112233', name: 'X' } });
    expect(res.status).toBe(409);
  });

  it('/api/test/reset-me removes the caller data', async () => {
    const me = await register(CLIENT);
    await buy(FLORIST, me.client!.id, 200_000);
    const res = await json<MeDTO>(call('/api/test/reset-me', { user: CLIENT, body: {} }));
    expect(res.registered).toBe(false);
    expect(res.client).toBeNull();
  });
});

describe('staff', () => {
  it('client gets 403 on staff and owner routes unless TEST_MODE role switch', async () => {
    expect((await call('/api/staff/recent', { user: CLIENT })).status).toBe(403);
    expect((await call('/api/owner/stats', { user: CLIENT })).status).toBe(403);
    expect((await call('/api/owner/stats', { user: FLORIST })).status).toBe(403);
    await setRole(CLIENT, 'florist');
    expect((await call('/api/staff/recent', { user: CLIENT })).status).toBe(200);
    expect((await call('/api/owner/stats', { user: CLIENT })).status).toBe(403);
    await setRole(CLIENT, 'owner');
    expect((await call('/api/owner/stats', { user: CLIENT })).status).toBe(200);
  });

  it('lookup by short code, scanned QR payload and phone digits', async () => {
    const me = await register(CLIENT, '+998901234567', 'Амалия');
    await register(CLIENT + 1, '+998911234567', 'Бобур');
    const code = me.client!.code;
    const look = (q: string) => json<StaffClientLookupDTO>(call(`/api/staff/client?q=${encodeURIComponent(q)}`, { user: FLORIST }));

    expect((await look(code)).client?.id).toBe(me.client!.id);
    expect((await look(code.toLowerCase())).client?.id).toBe(me.client!.id);
    expect((await look(`HF:${code}`)).client?.id).toBe(me.client!.id);
    expect((await look(`HF:${code.slice(2)}`)).client?.id).toBe(me.client!.id);
    expect((await look('+998 90 123-45-67')).client?.id).toBe(me.client!.id);
    expect((await look('901234567')).client?.id).toBe(me.client!.id);

    const partial = await look('1234567');
    expect(partial.client).toBeNull();
    expect(partial.matches.map((m) => m.name).sort()).toEqual(['Амалия', 'Бобур']);
    expect(partial.matches[0]!.phoneMasked).toMatch(/^\+998 9\d ••• •• 67$/);

    expect((await look('HF0000')).client).toBeNull();
    expect((await call('/api/staff/client?q=12', { user: FLORIST })).status).toBe(400);
  });

  it('preview equals what the purchase applies; notifications are sent after commit', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const preview = await json<PurchasePreviewDTO>(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId, amount: 450_000, redeem: false } }));
    expect(preview).toEqual({
      amount: 450_000, maxRedeem: 0, redeemed: 0, discount: 0, paid: 450_000, cashback: 4_500, pct: 1,
      cell: 1, cellBlockedReason: null, unlocksGift: false, giftType: null,
    });
    // Preview saves nothing.
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).client!.balance).toBe(0);

    const res = await call('/api/staff/purchase', { user: FLORIST, body: { clientId, amount: 450_000, redeem: false, idempotencyKey: key() } });
    expect(res.status).toBe(201);
    const p = await json<PurchaseResultDTO>(res);
    expect(p.preview).toEqual(preview);
    expect(p).toMatchObject({ replayed: false, giftsUnlocked: [], levelUp: null, newCard: false, warnings: [] });
    expect(p.client).toMatchObject({ balance: 4_500, spent: 450_000, card: { filled: 1 } });
    expect(p.client.history[0]).toMatchObject({ kind: 'purchase', points: 4_500, purchaseAmount: 450_000, pct: 1, cell: 1, status: 'active', staffName: 'Флорист Нигора' });
    expect(p.client.expiresAt).not.toBeNull();

    const msgs = tg.sent();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload.chat_id).toBe(CLIENT);
    expect(String(msgs[0]!.payload.text)).toContain('+4 500 мёда');
    expect(msgs[0]!.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: '🐝 Открыть медовую карту', web_app: { url: 'https://honey.example.workers.dev' } }]] });

    // Second purchase the same day: daily limit for the card.
    const second = await json<PurchasePreviewDTO>(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId, amount: 150_000, redeem: false } }));
    expect(second).toMatchObject({ cell: null, cellBlockedReason: 'daily_limit' });
    const small = await json<PurchasePreviewDTO>(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId, amount: 50_000, redeem: false } }));
    expect(small).toMatchObject({ cell: null, cellBlockedReason: 'below_min' });
  });

  it('idempotent replay returns the original result; same key with another amount is 409', async () => {
    const me = await register(CLIENT);
    const body = { clientId: me.client!.id, amount: 300_000, redeem: false, idempotencyKey: key() };
    const first = await call('/api/staff/purchase', { user: FLORIST, body });
    expect(first.status).toBe(201);
    const a = await json<PurchaseResultDTO>(first);
    const second = await call('/api/staff/purchase', { user: FLORIST, body });
    expect(second.status).toBe(200);
    const b = await json<PurchaseResultDTO>(second);
    expect(b.replayed).toBe(true);
    expect(b.purchaseId).toBe(a.purchaseId);
    expect(b.preview).toEqual(a.preview);
    expect(b.client.balance).toBe(3_000);
    expect(tg.sent()).toHaveLength(1); // no second notification

    const conflict = await call('/api/staff/purchase', { user: FLORIST, body: { ...body, amount: 300_001 } });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe('conflict');
    const other = await register(CLIENT + 1);
    const cross = await call('/api/staff/purchase', { user: FLORIST, body: { ...body, clientId: other.client!.id } });
    expect(cross.status).toBe(409);
  });

  it('redeem is capped by maxRedeemPct and by the balance', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const big = await buy(FLORIST, clientId, 5_000_000); // 1% = 50 000, level up to "honey"
    expect(big.client.balance).toBe(50_000);
    expect(big.levelUp).toMatchObject({ id: 'honey', pct: 3 });

    const preview = await json<PurchasePreviewDTO>(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId, amount: 60_000, redeem: true } }));
    expect(preview).toMatchObject({ maxRedeem: 30_000, redeemed: 30_000, paid: 30_000, pct: 3, cashback: 900 });
    const p = await buy(FLORIST, clientId, 60_000, { redeem: true });
    expect(p.preview).toEqual(preview);
    expect(p.client.balance).toBe(50_000 - 30_000 + 900);

    // Large order: capped by the balance.
    const p2 = await buy(FLORIST, clientId, 1_000_000, { redeem: true });
    expect(p2.preview).toMatchObject({ maxRedeem: 20_900, redeemed: 20_900 });
    expect(p2.client.balance).toBe(percent(1_000_000 - 20_900, 3));
  });

  it('reversal restores the balance; second reversal → 409 already_reversed; reason required', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const p = await buy(FLORIST, clientId, 400_000);
    expect((await call(`/api/staff/purchase/${p.purchaseId}/reverse`, { user: FLORIST, body: {} })).status).toBe(400);

    const res = await call(`/api/staff/purchase/${p.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'клиент вернул букет' } });
    expect(res.status).toBe(200);
    const r = await json<ReverseResultDTO>(res);
    expect(r.client.balance).toBe(0);
    expect(r.client.card.filled).toBe(0);
    expect(r.client.history[0]).toMatchObject({ kind: 'reversal', points: -4_000, reason: 'клиент вернул букет', staffName: 'Флорист Нигора' });
    expect(r.client.history[1]).toMatchObject({ kind: 'purchase', status: 'reversed' });
    expect(String(tg.sent().at(-1)!.payload.text)).toContain('Покупка отменена');

    const again = await call(`/api/staff/purchase/${p.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ещё раз' } });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe('already_reversed');
    expect((await call('/api/staff/purchase/nope/reverse', { user: FLORIST, body: { reason: 'тест' } })).status).toBe(404);

    const ops = await json<OperationDTO[]>(call('/api/staff/recent', { user: FLORIST }));
    expect(ops.slice(0, 2).map((o) => o.kind)).toEqual(['reversal', 'purchase']);
    expect(ops[0]).toMatchObject({ clientId, purchaseId: p.purchaseId, status: 'reversed', staffName: 'Флорист Нигора', points: -4_000 });
  });

  it('gifts: unlocked on cell 3, handed out via /gift/:id/use (idempotent), used gift cannot be used again', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    let last!: PurchaseResultDTO;
    for (let d = 0; d < 3; d++) {
      if (d) await moveClock(1);
      last = await buy(FLORIST, clientId, 150_000);
    }
    expect(last.preview).toMatchObject({ cell: 3, unlocksGift: true, giftType: 'card' });
    expect(last.giftsUnlocked).toHaveLength(1);
    const gift = last.giftsUnlocked[0]!;
    expect(gift).toMatchObject({ type: 'card', cycle: 1, cell: 3, status: 'available', usedAt: null });
    expect(tg.sent().some((m) => String(m.payload.text).includes('Открыт подарок: Открытка в подарок'))).toBe(true);

    const use = await call(`/api/staff/gift/${gift.id}/use`, { user: FLORIST, body: {} });
    expect(use.status).toBe(200);
    const used = await json<UseGiftResultDTO>(use);
    expect(used.client.gifts[0]).toMatchObject({ id: gift.id, status: 'used' });
    expect(used.client.history[0]).toMatchObject({ kind: 'gift_used', points: 0 });
    expect((await call(`/api/staff/gift/${gift.id}/use`, { user: FLORIST, body: {} })).status).toBe(200);

    const inPurchase = await call('/api/staff/purchase', { user: FLORIST, body: { clientId, amount: 200_000, redeem: false, giftId: gift.id, idempotencyKey: key() } });
    expect(inPurchase.status).toBe(409);
    expect((await call('/api/staff/gift/nope/use', { user: FLORIST, body: {} })).status).toBe(404);
  });
});

function percent(amount: number, pct: number) {
  return Math.floor((amount * pct) / 100);
}

describe('owner', () => {
  it('PUT /api/owner/rules creates a new version that affects the next purchase only', async () => {
    const me = await register(CLIENT);
    const clientId = me.client!.id;
    const before = await buy(FLORIST, clientId, 200_000);
    expect(before.preview.pct).toBe(1);

    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    expect(rules).toMatchObject({ version: 1, cells: 10, maxRedeemPct: 50, gifts: { '3': 'card', '6': 'delivery', '10': 'disc10' } });
    expect(rules.levels.map((l) => l.pct)).toEqual([1, 3, 5]);

    const edited: EditableRulesDTO = {
      ...rules,
      levels: rules.levels.map((l, i) => (i === 0 ? { ...l, pct: 10 } : l)),
      gifts: { '2': 'disc15', '5': 'mini' },
      maxCellsPerDay: 5,
      welcomeBonus: 5_000,
    };
    const put = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: edited });
    expect(put.status).toBe(200);
    const saved = await json<EditableRulesDTO>(put);
    expect(saved).toMatchObject({ version: 2, gifts: { '2': 'disc15', '5': 'mini' }, welcomeBonus: 5_000, maxCellsPerDay: 5 });

    const after = await buy(FLORIST, clientId, 200_000);
    expect(after.preview).toMatchObject({ pct: 10, cashback: 20_000, cell: 2, unlocksGift: true, giftType: 'disc15' });
    // The old purchase keeps its rules version.
    const versions = await testEnv.DB.prepare('SELECT id, rules_version_id FROM purchases ORDER BY created_at').all<{ id: string; rules_version_id: number }>();
    expect(versions.results.map((r) => r.rules_version_id)).toEqual([1, 2]);

    // The discount gift works in the next purchase and cannot be combined with points.
    const disc = after.giftsUnlocked[0]!;
    const withDisc = await json<PurchasePreviewDTO>(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId, amount: 100_000, redeem: true, giftId: disc.id } }));
    expect(withDisc).toMatchObject({ discount: 15_000, redeemed: 0, maxRedeem: 0, paid: 85_000 });

    const me2 = await json<MeDTO>(call('/api/me', { user: CLIENT }));
    expect(me2.rules.welcomeBonus).toBe(5_000);
    expect(me2.client!.card.gifts).toEqual({ '2': 'disc15', '5': 'mini' });

    // Stale version → 409; invalid → 400.
    expect((await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: edited })).status).toBe(409);
    const bad = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...saved, levels: [{ id: 'a', name: 'A', pct: 1, from: 100 }] } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe('validation');
    const badGift = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...saved, gifts: { '11': 'card' } } });
    expect(badGift.status).toBe(400);
    expect((await call('/api/owner/rules', { user: FLORIST, method: 'PUT', body: saved })).status).toBe(403);
  });

  it('staff management: add by telegram id or phone, deactivate', async () => {
    const add = await call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: 7777, role: 'florist' } });
    expect(add.status).toBe(201);
    const member = await json<StaffDTO>(add);
    expect(member).toMatchObject({ telegramId: 7777, role: 'florist', active: true });
    expect((await json<MeDTO>(call('/api/me', { user: 7777 }))).role).toBe('florist');

    // Added by phone before the person ever opened the bot: linked when they share the phone.
    const byPhone = await json<StaffDTO>(call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: '+998 93 555 44 33', role: 'manager', name: 'Менеджер' } }));
    expect(byPhone).toMatchObject({ telegramId: null, role: 'manager', name: 'Менеджер' });
    await register(8888, '+998935554433');
    expect((await json<MeDTO>(call('/api/me', { user: 8888 }))).role).toBe('manager');

    const list = await json<StaffDTO[]>(call('/api/owner/staff', { user: OWNER }));
    expect(list.map((s) => s.name)).toEqual(expect.arrayContaining(['Флорист Нигора', 'Владелец', 'Менеджер']));

    const del = await call(`/api/owner/staff/${member.id}`, { user: OWNER, method: 'DELETE' });
    expect((await json<StaffDTO>(del)).active).toBe(false);
    expect((await json<MeDTO>(call('/api/me', { user: 7777 }))).role).toBe('client');
  });

  it('stats and operations', async () => {
    const a = await register(CLIENT);
    const b = await register(CLIENT + 1);
    await buy(FLORIST, a.client!.id, 300_000);
    await buy(FLORIST, b.client!.id, 500_000);
    await moveClock(1);
    await buy(FLORIST, a.client!.id, 200_000, { redeem: true });

    const s = await json<OwnerStatsDTO>(call('/api/owner/stats', { user: OWNER }));
    expect(s).toMatchObject({
      clients: 2,
      clientsNew7d: 2,
      purchases: 3,
      purchases7d: 3,
      revenueWithCard: 1_000_000,
      repeatRate90d: 0.5,
      giftsUnlocked: 0,
      giftsUsed: 0,
    });
    expect(s.points).toEqual({ accrued: 3_000 + 5_000 + 1_970, redeemed: 3_000, expired: 0, outstanding: 6_970 });
    expect(s.perWeek).toHaveLength(8);
    expect(s.perWeek.reduce((n, w) => n + w.purchases, 0)).toBe(3);

    const ops = await json<OperationDTO[]>(call('/api/owner/operations?limit=2', { user: OWNER }));
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: 'purchase', clientId: a.client!.id, purchaseAmount: 200_000, points: 1_970 - 3_000 });
  });
});

describe('test clock and expiry', () => {
  it('moves the clock, warns 14 days before and burns points on day 90', async () => {
    const me = await register(CLIENT);
    await buy(FLORIST, me.client!.id, 500_000); // balance 5 000

    await moveClock(76);
    const meMoved = await json<MeDTO>(call('/api/me', { user: CLIENT }));
    expect(meMoved.clockOffsetDays).toBe(76);
    expect(Date.parse(meMoved.now) - Date.now()).toBeGreaterThan(75 * 86_400_000);

    const warn = await json(call('/api/test/run-expiry', { user: CLIENT, body: {} }));
    expect(warn).toEqual({ expired: 0, warned: 1 });
    expect(String(tg.sent().at(-1)!.payload.text)).toMatch(/Через 14 дней сгорит 5 000 мёда/);
    expect(await json(call('/api/test/run-expiry', { user: CLIENT, body: {} }))).toEqual({ expired: 0, warned: 0 });

    await moveClock(14);
    expect(await json(call('/api/test/run-expiry', { user: CLIENT, body: {} }))).toEqual({ expired: 1, warned: 0 });
    const after = await json<MeDTO>(call('/api/me', { user: CLIENT }));
    expect(after.client!.balance).toBe(0);
    expect(after.client!.expiresAt).toBeNull();
    expect(after.client!.history[0]).toMatchObject({ kind: 'expire', points: -5_000 });
    expect(String(tg.sent().at(-1)!.payload.text)).toContain('Сгорело 5 000 мёда');

    const reset = await json<MeDTO>(call('/api/test/clock', { user: CLIENT, body: { reset: true } }));
    expect(reset.clockOffsetDays).toBe(0);
    expect((await call('/api/test/clock', { user: CLIENT, body: { days: -1 } })).status).toBe(400);
  });

  it('the cron handler runs the same job', async () => {
    const me = await register(CLIENT);
    await buy(FLORIST, me.client!.id, 500_000);
    await moveClock(90);
    const worker = (await import('../src/index.js')).default;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: '0 4 * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      testEnv,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).client!.balance).toBe(0);
    expect(tg.sent().some((m) => String(m.payload.text).includes('Сгорело'))).toBe(true);
  });
});

describe('notifications never break a purchase', () => {
  it('a failing sendMessage is logged, the purchase succeeds', async () => {
    tg.restore();
    tg = mockTelegram({ failSendMessage: true });
    const me = await register(CLIENT);
    const res = await call('/api/staff/purchase', { user: FLORIST, body: { clientId: me.client!.id, amount: 200_000, redeem: false, idempotencyKey: key() } });
    expect(res.status).toBe(201);
    const log = await testEnv.DB.prepare('SELECT status, error FROM notifications_log').all<{ status: string; error: string }>();
    expect(log.results).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(log.results[0]!.error).toMatch(/blocked/);
  });
});

describe('setup and misc', () => {
  it('GET /setup checks the key and configures the webhook, commands and menu button', async () => {
    expect((await call('/setup?key=wrong')).status).toBe(403);
    const res = await call('/setup?key=test-setup-key');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ ok: true, origin: 'https://honey.example.workers.dev', bot: 'https://t.me/honey_flowers_test_bot' });
    const hook = tg.calls.find((c) => c.method === 'setWebhook')!;
    expect(hook.payload).toMatchObject({
      url: 'https://honey.example.workers.dev/telegram/webhook',
      secret_token: 'test-webhook-secret',
      allowed_updates: ['message', 'callback_query'],
    });
    expect(tg.calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(2);
    expect(tg.calls.find((c) => c.method === 'setChatMenuButton')!.payload).toEqual({
      menu_button: { type: 'web_app', text: 'Медовая карта', web_app: { url: 'https://honey.example.workers.dev' } },
    });
    expect(await repo().getSetting('public_url')).toBe('https://honey.example.workers.dev');
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).botUsername).toBe('honey_flowers_test_bot');

    // First owner by phone: linked when that person shares the phone with the bot.
    const withOwner = await json(call('/setup?key=test-setup-key&owner=%2B998901110000'));
    expect(withOwner.steps.at(-1)).toMatchObject({ step: 'addOwner', ok: true });
    await register(CLIENT, '+998901110000');
    expect((await json<MeDTO>(call('/api/me', { user: CLIENT }))).role).toBe('owner');
    const byId = await json(call('/setup?key=test-setup-key&owner=4242'));
    expect(byId.steps.at(-1)).toMatchObject({ step: 'addOwner', ok: true, detail: { telegramId: 4242 } });
  });

  it('health, unknown API routes and CORS for localhost in TEST_MODE', async () => {
    expect(await json(call('/health'))).toEqual({ ok: true, testMode: true });
    expect((await call('/api/nope', { user: CLIENT })).status).toBe(404);
    const pre = await app.request('/api/me', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } }, testEnv);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const evil = await app.request('/api/me', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } }, testEnv);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
