/** A Telegram user sharing the phone of a client imported from the old base takes that client over. */
import { describe, expect, it } from 'vitest';
import { balanceFromLedger, defaultRules, manualAdjust, parseRules } from '@honey/core';
import { InMemoryRepository, isUnlinkedTelegramId, LoyaltyService, MemoryNotifier, PhoneTakenError, placeholderTelegramId } from '../src/index.js';

const rules = parseRules({ ...defaultRules, welcomeBonus: 5_000 });
const now = new Date('2026-10-01T07:00:00Z');

async function setup() {
  const repo = new InMemoryRepository({ rules });
  const svc = new LoyaltyService(repo, new MemoryNotifier(), () => now, { retryDelayMs: 0 });
  const imported = await repo.importClient({ phone: '+998901234567', name: 'Нигора (из базы)', createdAt: now });
  await svc.execute(imported.id, ({ rules: r, state, now: n }) =>
    manualAdjust(r, state, { idempotencyKey: 'import:b1:+998901234567', staffId: 'owner', amount: 40_000, reason: 'Импорт базы' }, n),
  );
  return { repo, svc, imported };
}

describe('placeholder Telegram ids', () => {
  it('are negative, derived from the phone, and never collide with real ids', () => {
    expect(placeholderTelegramId('+998901234567')).toBe(-998901234567);
    expect(isUnlinkedTelegramId(-998901234567)).toBe(true);
    expect(isUnlinkedTelegramId(123456789)).toBe(false);
  });
});

describe('registerWithPhone claims an imported client', () => {
  it('keeps the same client, balance and history; no duplicate; welcome bonus once', async () => {
    const { repo, svc, imported } = await setup();
    const res = await svc.registerWithPhone({ telegramId: 555, name: 'Нигора', phone: '+998901234567', language: 'uz' });
    expect(res).toMatchObject({ claimed: true, created: false, welcomeBonus: 5_000 });
    expect(res.client.id).toBe(imported.id);
    expect(res.client.telegramId).toBe(555);
    expect(res.client.name).toBe('Нигора (из базы)'); // the shop's name is kept
    expect(res.client.language).toBe('uz');
    expect(await repo.allClientIds()).toEqual([imported.id]);
    expect(balanceFromLedger(repo.peekState(imported.id)!.ledger)).toBe(45_000);
    // Sharing the contact again is a no-op.
    const again = await svc.registerWithPhone({ telegramId: 555, name: 'Нигора', phone: '+998901234567', language: 'uz' });
    expect(again).toMatchObject({ claimed: false, created: false, welcomeBonus: 0 });
    expect(balanceFromLedger(repo.peekState(imported.id)!.ledger)).toBe(45_000);
  });

  it('a second Telegram account cannot take the client once it is claimed', async () => {
    const { svc } = await setup();
    await svc.registerWithPhone({ telegramId: 555, name: 'A', phone: '+998901234567', language: 'ru' });
    await expect(svc.registerWithPhone({ telegramId: 777, name: 'B', phone: '+998901234567', language: 'ru' })).rejects.toBeInstanceOf(PhoneTakenError);
  });

  it('never hands a demo client (negative id too) to a real person; a client with a negative id but no import record is not claimable', async () => {
    const { repo, svc } = await setup();
    const demo = await repo.demoClient({ telegramId: -990_000_007, phone: '+998935550007', name: 'Демо', createdAt: now });
    await expect(svc.registerWithPhone({ telegramId: 555, name: 'A', phone: '+998935550007', language: 'ru' })).rejects.toBeInstanceOf(PhoneTakenError);
    expect((await repo.findClientById(demo.id))!.telegramId).toBe(-990_000_007);
    // Negative id without the import flag (e.g. created some other way): refused as well.
    const odd = await repo.createClient({ telegramId: -998_935_550_008, phone: '+998935550008', name: 'X', language: 'ru', consentAt: null, createdAt: now });
    await expect(svc.registerWithPhone({ telegramId: 556, name: 'B', phone: '+998935550008', language: 'ru' })).rejects.toBeInstanceOf(PhoneTakenError);
    expect((await repo.findClientById(odd.id))!.telegramId).toBeLessThan(0);
    expect(await repo.findClientByTelegramId(555)).toBeNull();
  });

  it('import placeholders (−998…, 12 digits) can never equal demo ids (−990 000 000 − i)', () => {
    // Every valid Uzbek number is +998 + 9 digits → |placeholder| >= 998 000 000 000.
    expect(placeholderTelegramId('+998000000000')).toBeLessThan(-997_999_999_999);
    expect(-(990_000_000 + 1_000_000)).toBeGreaterThan(placeholderTelegramId('+998000000000'));
  });

  it('refuses when the caller already has a card of their own (two cards are merged by hand)', async () => {
    const { repo, svc, imported } = await setup();
    await svc.registerWithPhone({ telegramId: 555, name: 'A', phone: '+998909999999', language: 'ru' });
    await expect(svc.registerWithPhone({ telegramId: 555, name: 'A', phone: '+998901234567', language: 'ru' })).rejects.toBeInstanceOf(PhoneTakenError);
    expect((await repo.findClientById(imported.id))!.telegramId).toBeLessThan(0);
  });
});
