import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_TG, FLORIST_TG, OWNER_TG, setup } from './helpers.js';

let ctx: ReturnType<typeof setup>;
afterEach(async () => {
  await ctx?.app.close();
});

describe('auth', () => {
  it('POST /auth/telegram registers on first visit and is idempotent', async () => {
    ctx = setup();
    const first = await ctx.app.inject({ method: 'POST', url: '/auth/telegram', headers: await ctx.tma(CLIENT_TG) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: true, staff: null, client: { language: 'ru', hasPhone: false } });
    const second = await ctx.app.inject({ method: 'POST', url: '/auth/telegram', headers: await ctx.tma(CLIENT_TG) });
    expect(second.json()).toMatchObject({ created: false, client: { id: first.json().client.id } });
  });

  it('accepts initData in the body as well', async () => {
    ctx = setup();
    const initData = (await ctx.tma(CLIENT_TG)).authorization.slice(4);
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/telegram', payload: { initData } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects requests without or with a forged signature', async () => {
    ctx = setup();
    const none = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(none.statusCode).toBe(401);
    const forged = (await ctx.tma(CLIENT_TG)).authorization.replace(/hash=[0-9a-f]{4}/, 'hash=0000');
    const bad = await ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: forged } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('BAD_HASH');
  });

  it('marks staff in the auth response', async () => {
    ctx = setup();
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/telegram', headers: await ctx.tma(OWNER_TG) });
    expect(res.json().staff).toMatchObject({ role: 'owner' });
  });
});

describe('staff routes', () => {
  it('reject non-staff and inactive staff', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    const payload = { clientId, idempotencyKey: 'order-0001', amount: 200_000 };
    const asClient = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(CLIENT_TG), payload });
    expect(asClient.statusCode).toBe(403);
    const asInactive = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(1003), payload });
    expect(asInactive.statusCode).toBe(403);
  });

  it('purchase → /me shows balance, level progress, card and expiry; replay is idempotent', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    const payload = { clientId, idempotencyKey: 'order-0001', amount: 450_000 };
    const res = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(FLORIST_TG), payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().purchase.result).toMatchObject({ cashback: 4_500, cell: 1, cellAdvanced: true });
    expect(ctx.notifier.sent.map((e) => e.type)).toEqual(['points_accrued', 'card_advanced']);

    const replay = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(FLORIST_TG), payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().purchase.id).toBe(res.json().purchase.id);

    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: await ctx.tma(CLIENT_TG) });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.balance).toBe(4_500);
    expect(body.level).toMatchObject({ id: 'bee', cashbackPct: 1, metric: 450_000 });
    expect(body.level.next).toMatchObject({ id: 'honey', remaining: 1_550_000 });
    expect(body.card).toMatchObject({ cycle: 1, filled: 1, cellsTotal: 10, purchasesToNextReward: 2 });
    expect(body.card.cells[2]).toMatchObject({ cell: 3, hasGift: true, gift: null });
    expect(body.expiry).toEqual({ expiresOn: '2027-01-30', daysLeft: 90 });
  });

  it('search by phone works with any formatting and needs 4+ digits', async () => {
    ctx = setup();
    await ctx.registerClient(CLIENT_TG, '+998 90 123-45-67');
    const found = await ctx.app.inject({ method: 'GET', url: '/staff/clients/search?phone=901234567', headers: await ctx.tma(FLORIST_TG) });
    expect(found.json().clients).toHaveLength(1);
    expect(found.json().clients[0]).toMatchObject({ balance: 0, level: 'bee' });
    const full = await ctx.app.inject({ method: 'GET', url: `/staff/clients/search?phone=${encodeURIComponent('+998901234567')}`, headers: await ctx.tma(FLORIST_TG) });
    expect(full.json().clients).toHaveLength(1);
    const short = await ctx.app.inject({ method: 'GET', url: '/staff/clients/search?phone=12', headers: await ctx.tma(FLORIST_TG) });
    expect(short.statusCode).toBe(400);
  });

  it('redeem over the cap returns 422; within the cap reduces the balance', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    const h = await ctx.tma(FLORIST_TG);
    await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: h, payload: { clientId, idempotencyKey: 'order-0001', amount: 5_000_000 } });
    const tooMuch = await ctx.app.inject({
      method: 'POST',
      url: '/staff/redeem',
      headers: h,
      payload: { clientId, idempotencyKey: 'redeem-0001', points: 30_000, orderAmount: 50_000 },
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error).toBe('REDEEM_CAP_EXCEEDED');
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/staff/redeem',
      headers: h,
      payload: { clientId, idempotencyKey: 'redeem-0002', points: 25_000, orderAmount: 50_000 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().balance).toBe(25_000);
  });

  it('reverse requires a reason; refused (409) while the gift of the purchase is used', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    const ids: string[] = [];
    for (let d = 1; d <= 3; d++) {
      ctx.clock.set(`2026-11-0${d} 12:00`);
      const r = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(FLORIST_TG), payload: { clientId, idempotencyKey: `order-000${d}`, amount: 150_000 } });
      ids.push(r.json().purchase.id);
    }
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: await ctx.tma(CLIENT_TG) });
    const gift = me.json().gifts[0];
    expect(gift).toMatchObject({ type: 'free_card', status: 'available' });
    const p4 = await ctx.app.inject({
      method: 'POST',
      url: '/staff/purchases',
      headers: await ctx.tma(FLORIST_TG),
      payload: { clientId, idempotencyKey: 'order-0004', lines: [{ category: 'cards', amount: 20_000 }, { category: 'flowers', amount: 200_000 }], useRewardId: gift.id },
    });

    const noReason = await ctx.app.inject({ method: 'POST', url: `/staff/purchases/${ids[2]}/reverse`, headers: await ctx.tma(OWNER_TG), payload: {} });
    expect(noReason.statusCode).toBe(400);
    const reverse = async (id: string) => ctx.app.inject({ method: 'POST', url: `/staff/purchases/${id}/reverse`, headers: await ctx.tma(OWNER_TG), payload: { reason: 'клиент вернул букет' } });
    const refused = await reverse(ids[2]!);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('REVERSAL_GIFT_USED');
    // reversing the purchase that used the gift returns it; then the unlocking purchase may be reversed (gift revoked)
    expect((await reverse(p4.json().purchase.id)).statusCode).toBe(200);
    const rev = await reverse(ids[2]!);
    expect(rev.statusCode).toBe(200);
    expect(rev.json().purchase.status).toBe('reversed');
    const after = await ctx.app.inject({ method: 'GET', url: '/me', headers: await ctx.tma(CLIENT_TG) });
    expect(after.json().gifts.find((g: { id: string }) => g.id === gift.id)?.status ?? 'revoked').toBe('revoked');
  });

  it('returns 404 for an unknown client or purchase', async () => {
    ctx = setup();
    const h = await ctx.tma(FLORIST_TG);
    const p = await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: h, payload: { clientId: 'nope', idempotencyKey: 'order-0001', amount: 1000 } });
    expect(p.statusCode).toBe(404);
    const r = await ctx.app.inject({ method: 'POST', url: '/staff/purchases/nope/reverse', headers: h, payload: { reason: 'тест' } });
    expect(r.statusCode).toBe(404);
  });

  it('validates the purchase body', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/staff/purchases',
      headers: await ctx.tma(FLORIST_TG),
      payload: { clientId, idempotencyKey: 'order-0001', amount: 100.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('parallel requests cannot double-spend points (per-client lock)', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(FLORIST_TG), payload: { clientId, idempotencyKey: 'order-0001', amount: 1_000_000 } });
    // Balance 10 000; two parallel redeems of 10 000 each.
    const req = async (k: string) =>
      ctx.app.inject({ method: 'POST', url: '/staff/redeem', headers: await ctx.tma(FLORIST_TG), payload: { clientId, idempotencyKey: k, points: 10_000, orderAmount: 100_000 } });
    const [a, b] = await Promise.all([req('redeem-aaaa'), req('redeem-bbbb')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 422]);
  });
});

describe('scheduler job', () => {
  it('runExpiryForAll sends warnings and expires points', async () => {
    ctx = setup();
    const clientId = await ctx.registerClient();
    await ctx.app.inject({ method: 'POST', url: '/staff/purchases', headers: await ctx.tma(FLORIST_TG), payload: { clientId, idempotencyKey: 'order-0001', amount: 500_000 } });
    ctx.clock.set('2027-01-16 10:00');
    expect((await ctx.service.runExpiryForAll()).map((e) => e.type)).toEqual(['expiry_warning']);
    expect(await ctx.service.runExpiryForAll()).toEqual([]);
    ctx.clock.set('2027-01-30 10:00');
    expect((await ctx.service.runExpiryForAll()).map((e) => e.type)).toEqual(['points_expired']);
  });
});
