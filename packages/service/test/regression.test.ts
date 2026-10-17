/** Regression tests for the service-layer audit findings (E3, E6, E14). */
import { describe, expect, it } from 'vitest';
import { defaultRules, parseRules, type Outcome } from '@honey/core';
import { ConcurrencyError, InMemoryRepository, LoyaltyService, MemoryNotifier, validateInitData, buildInitData, InitDataError } from '../src/index.js';

const rules = parseRules({ ...defaultRules, welcomeBonus: 10_000 });

describe('E6: daily expiry job isolates failures per client', () => {
  it('one client that keeps failing does not stop expiry for the others', async () => {
    let now = new Date('2026-11-01T05:00:00Z');
    const repo = new InMemoryRepository({ rules });
    const svc = new LoyaltyService(repo, new MemoryNotifier(), () => now, { retryDelayMs: 0 });
    const a = await svc.registerWithPhone({ telegramId: 1, name: 'A', phone: '+998900000001', language: 'ru' });
    const b = await svc.registerWithPhone({ telegramId: 2, name: 'B', phone: '+998900000002', language: 'ru' });
    const orig = repo.saveOutcome.bind(repo);
    repo.saveOutcome = async (id: string, o: Outcome, v: number) => {
      if (id === a.client.id) throw new ConcurrencyError();
      return orig(id, o, v);
    };
    now = new Date('2027-02-01T04:00:00Z');
    const failed: string[] = [];
    const events = await svc.runExpiryForAll((id) => failed.push(id));
    expect(failed).toEqual([a.client.id]);
    expect(events.map((e) => e.type)).toEqual(['points_expired']);
    expect(repo.peekState(b.client.id)!.ledger.map((e) => e.type)).toEqual(['welcome', 'expire']);
  });
});

describe('E3: welcome bonus is credited only when registration completes', () => {
  it('re-sharing the contact later does not claim a bonus enabled after signup', async () => {
    let now = new Date('2026-07-01T05:00:00Z');
    const repo = new InMemoryRepository({ rules: defaultRules });
    const svc = new LoyaltyService(repo, new MemoryNotifier(), () => now, { retryDelayMs: 0 });
    const first = await svc.registerWithPhone({ telegramId: 9, name: 'Y', phone: '+998901112299', language: 'ru' });
    expect(first.welcomeBonus).toBe(0);
    repo.addRulesVersion({ id: 2, rules: parseRules({ ...defaultRules, version: 2, welcomeBonus: 10_000 }), activeFrom: new Date('2026-10-01T00:00:00Z'), createdBy: null });
    now = new Date('2026-11-01T05:00:00Z');
    const again = await svc.registerWithPhone({ telegramId: 9, name: 'Y', phone: '+998901112299', language: 'ru' });
    expect(again.welcomeBonus).toBe(0);
    expect(again.created).toBe(false);
    expect(repo.peekState(first.client.id)!.ledger).toHaveLength(0);
  });

  it('a client created without a phone gets the bonus when the phone is attached (registration completes)', async () => {
    const repo = new InMemoryRepository({ rules });
    const svc = new LoyaltyService(repo, new MemoryNotifier(), () => new Date('2026-11-01T05:00:00Z'), { retryDelayMs: 0 });
    const client = await repo.createClient({ telegramId: 5, name: 'Z', phone: null, language: 'ru', consentAt: null, createdAt: new Date('2026-11-01T05:00:00Z') });
    const res = await svc.registerWithPhone({ telegramId: 5, name: 'Z', phone: '+998901112255', language: 'ru' });
    expect(res.client.id).toBe(client.id);
    expect(res.welcomeBonus).toBe(10_000);
    expect((await svc.registerWithPhone({ telegramId: 5, name: 'Z', phone: '+998901112255', language: 'ru' })).welcomeBonus).toBe(0);
  });

  it('new registration still credits the bonus once', async () => {
    const repo = new InMemoryRepository({ rules });
    const svc = new LoyaltyService(repo, new MemoryNotifier(), () => new Date('2026-11-01T05:00:00Z'), { retryDelayMs: 0 });
    const res = await svc.registerWithPhone({ telegramId: 6, name: 'W', phone: '+998901112266', language: 'ru' });
    expect(res.welcomeBonus).toBe(10_000);
  });
});

describe('replay of a reversed purchase', () => {
  it('purchase() reports the stored status so the API can surface it', async () => {
    const repo = new InMemoryRepository({ rules: defaultRules, staff: [{ telegramId: 100, name: 'F', role: 'florist', active: true }] });
    const svc = new LoyaltyService(repo, new MemoryNotifier(), () => new Date('2026-11-01T05:00:00Z'), { retryDelayMs: 0 });
    const staff = (await repo.findStaffByTelegramId(100))!;
    const { client } = await svc.registerWithPhone({ telegramId: 7, name: 'Q', phone: '+998901112277', language: 'ru' });
    const input = { clientId: client.id, idempotencyKey: 'order-1', lines: [{ category: 'flowers' as const, amount: 150_000 }], channel: 'store' as const };
    const first = await svc.purchase(staff, input);
    expect(first.status).toBe('active');
    await svc.reverse(staff, { purchaseId: first.purchase.id, reason: 'ошибка' });
    const replay = await svc.purchase(staff, input);
    expect(replay).toMatchObject({ replayed: true, status: 'reversed' });
  });
});

describe('E14: initData freshness cannot be disabled by a bad config', () => {
  const BOT_TOKEN = '7000000001:AAH-test-token-for-unit-tests';
  const now = new Date('2026-11-01T10:00:00Z');
  const user = JSON.stringify({ id: 1, first_name: 'A' });
  it('NaN maxAgeSeconds falls back to the 24 h default', async () => {
    const old = String(Math.floor(now.getTime() / 1000) - 90_000);
    const raw = await buildInitData({ auth_date: old, user }, BOT_TOKEN);
    await expect(validateInitData(raw, BOT_TOKEN, { now, maxAgeSeconds: Number.NaN })).rejects.toBeInstanceOf(InitDataError);
    const fresh = await buildInitData({ auth_date: String(Math.floor(now.getTime() / 1000) - 60), user }, BOT_TOKEN);
    expect((await validateInitData(fresh, BOT_TOKEN, { now, maxAgeSeconds: Number.NaN })).user.id).toBe(1);
  });
});
