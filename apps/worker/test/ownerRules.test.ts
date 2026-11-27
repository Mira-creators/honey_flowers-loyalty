import type { EditableRulesDTO, LegalDTO, MeDTO, OperationDTO, OwnerClientDTO, PhoneCreditDTO, PurchaseResultDTO, StaffClientLookupDTO } from '@honey/contracts';
import { dayNumberFromKey, defaultRules, keyFromDayNumber, localDateKey, RULES_V1_PLACEHOLDER } from '@honey/core';
import { placeholderTelegramId } from '@honey/service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration0011 from '../migrations/0011_owner_rules.sql?raw';
import { createContext } from '../src/context.js';
import { runDailyJob } from '../src/cron.js';
import { nextCheckOn, nextChecksSql } from '../src/lib/expirySchedule.js';
import { CONSENT_VERSION } from '../src/lib/legal.js';
import {
  buy,
  call,
  contactUpdate,
  json,
  key,
  makeStaff,
  mockTelegram,
  moveClock,
  register,
  repo,
  resetDb,
  seedRules,
  T,
  testEnv,
  tmaHeader,
  webhook,
} from './helpers.js';

/**
 * The owner's rules (docs/Спорные вопросы.md Л1–Л9, Д1) through the API: levels by count with a
 * sticky reset timer, welcome bonus, consent gate, credit by phone + claim, reversal switch,
 * birthday gift, migration 0011.
 */

const OWNER = T + 1;
const FLORIST = T + 2;
const C1 = T + 10;
const TG_REAL = 777_100_200; // a real Telegram account (initData / bot)
const DB = () => testEnv.DB;
const today = async () => localDateKey((await createContext(testEnv)).now(), 'Asia/Tashkent');
const plus = (day: string, n: number) => keyFromDayNumber(dayNumberFromKey(day) + n);
const nextOf = async (id: string) => (await DB().prepare('SELECT next_check_on AS n FROM clients WHERE id = ?').bind(id).first<{ n: string | null }>())!.n;
const me = (user: number) => json<MeDTO>(call('/api/me', { user }));
const job = async () => runDailyJob(await createContext(testEnv));

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  await seedRules(defaultRules);
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
  await makeStaff(FLORIST, 'florist');
});
afterEach(() => tg.restore());

// ---------------------------------------------------------------- migration 0011

/** The «1. rules» part of migration 0011 as statements. */
function rulesSection(): string[] {
  const part = migration0011.slice(migration0011.indexOf('-- ---------------------------------------------------------------- 1. rules'));
  return part
    .split(/;\s*\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

describe('migration 0011', () => {
  it('embeds exactly packages/core defaultRules', () => {
    const m = /json_set\('(\{.*\})', '\$\.version'/.exec(migration0011);
    expect(m).toBeTruthy();
    expect(JSON.parse(m![1]!)).toEqual(JSON.parse(JSON.stringify(defaultRules)));
  });

  it('switches a database that still runs the placeholder rules; never touches owner edits', async () => {
    await seedRules(RULES_V1_PLACEHOLDER);
    const c = (await register(C1)).client!;
    for (const s of rulesSection()) await DB().prepare(s).run();
    const active = await repo().getActiveRules();
    expect(active.id).toBe(2);
    expect({ ...active.rules, version: 1 }).toEqual(JSON.parse(JSON.stringify(defaultRules)));
    expect(await nextOf(c.id)).toBe(localDateKey(new Date(), 'Asia/Tashkent')); // the daily job looks at everybody once
    // run again: nothing new (the active rules are not the placeholder any more)
    for (const s of rulesSection()) await DB().prepare(s).run();
    expect((await repo().getActiveRules()).id).toBe(2);

    // owner-edited placeholder rules stay
    await resetDb();
    await seedRules({ ...RULES_V1_PLACEHOLDER, welcomeBonus: 5_000 });
    for (const s of rulesSection()) await DB().prepare(s).run();
    const kept = await repo().getActiveRules();
    expect([kept.id, kept.rules.welcomeBonus, kept.rules.levels.criterion]).toEqual([1, 5_000, 'sum']);
  });
});

// ---------------------------------------------------------------- Л1, Л2, Л5: levels by count, sticky, welcome bonus

describe('owner rules through the API', () => {
  it('welcome 15 000 spendable at once within 50 %; levels by purchase days; level kept until …', async () => {
    const reg = await register(C1);
    expect(reg.client!.balance).toBe(15_000);
    expect(reg.rules).toMatchObject({ levelBy: 'count', levelMode: 'sticky', levelWindowDays: 90, levelResetDays: 90, welcomeBonus: 15_000, birthdayPct: 10, minPurchaseForCell: 0 });
    const id = reg.client!.id;
    // first order: 40 000, мёд up to 50 % = 20 000, balance 15 000 → 15 000
    const p1 = await buy(FLORIST, id, 40_000, { redeem: true });
    expect(p1.preview).toMatchObject({ redeemed: 15_000, paid: 25_000, cashback: 250, pct: 1, cell: 1 });
    // a second order the same day: no cell, does not count for the level
    const p2 = await buy(FLORIST, id, 30_000);
    expect(p2.preview.cell).toBeNull();
    expect(p2.client.spent).toBe(1);
    await moveClock(2);
    await buy(FLORIST, id, 30_000);
    await moveClock(3);
    const p4 = await buy(FLORIST, id, 30_000);
    expect(p4.levelUp).toMatchObject({ id: 'queen', name: 'Королева улья', pct: 3 });
    expect(p4.client).toMatchObject({ levelBy: 'count', spent: 3, level: { id: 'queen' }, next: { id: 'gold', left: 7 } });
    const t = await today();
    expect(p4.client.levelKeptUntil).toBe(plus(t, 89));
    // the honey date is separate: 180 days after the last purchase
    expect(p4.client.expiresOn).toBe(plus(t, 179));
    // 3 % from the next purchase
    await moveClock(1);
    expect((await buy(FLORIST, id, 100_000)).preview.pct).toBe(3);
  });

  it('daily job: two timers — level reminders 7/1 days and the reset message, then the мёд reminders; SQL schedule never later than the engine', async () => {
    const id = (await register(C1)).client!.id;
    for (let i = 0; i < 3; i++) {
      await buy(FLORIST, id, 50_000);
      await moveClock(1);
    }
    // last purchase was yesterday: the level resets on day +89 from now, its first reminder 7 days before
    let t = await today();
    const lastBuy = plus(t, -1);
    expect(await nextOf(id)).toBe(plus(lastBuy, 90 - 7));
    // SQL recompute (rules change / clock move) is never later than the engine
    const { rules } = await repo().getActiveRules();
    await DB().prepare(nextChecksSql('?1', '?2')).bind(JSON.stringify(rules), t).run();
    const engine = nextCheckOn(rules, (await repo().loadClientState(id)).state, (await createContext(testEnv)).now());
    expect((await nextOf(id))! <= engine!).toBe(true);

    await moveClock(82); // = lastBuy + 83
    t = await today();
    expect(t).toBe(plus(lastBuy, 83));
    expect(await nextOf(id)).toBe(t);
    tg.calls.length = 0;
    await job();
    const warn = tg.sent().map((m) => String(m.payload.text)).join('\n');
    expect(warn).toContain('Ваш уровень «Королева улья» сохранится до');
    expect(await nextOf(id)).toBe(plus(lastBuy, 89)); // the 1-day reminder

    await moveClock(7); // reset day
    tg.calls.length = 0;
    await job(); // the 1-day reminder was missed: the reset message itself
    const reset = tg.sent().map((m) => String(m.payload.text)).join('\n');
    expect(reset).toContain('Уровень сброшен до «Пчёлка»');
    const after = await me(C1);
    expect(after.client).toMatchObject({ level: { id: 'bee' }, levelKeptUntil: null });
    expect(after.client!.balance).toBeGreaterThan(0); // мёд stays (separate timer)
    // next: the мёд reminder 14 days before day 180
    expect(await nextOf(id)).toBe(plus(lastBuy, 180 - 14));
    const stats = await DB().prepare('SELECT level_id FROM client_stats WHERE client_id = ?').bind(id).first<{ level_id: string }>();
    expect(stats!.level_id).toBe('bee');
  });
});

// ---------------------------------------------------------------- Д1: consent

describe('consent before registration (Д1)', () => {
  it('no card without «Принимаю»; the version and time are stored; GET /api/legal', async () => {
    const before = await me(C1);
    expect(before.consent).toEqual({ required: true, version: CONSENT_VERSION, acceptedAt: null });
    const refused = await call('/api/test/register', { user: C1, body: { phone: '+998901234500', name: 'Без согласия' } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('consent_required');
    expect(await repo().findClientByTelegramId(C1)).toBeNull();

    expect((await call('/api/me/consent', { user: C1, body: { version: 'old' } })).status).toBe(409);
    const ok = await json<MeDTO>(call('/api/me/consent', { user: C1, body: { version: CONSENT_VERSION } }));
    expect(ok.consent.required).toBe(false);
    expect(ok.consent.acceptedAt).toBeTruthy();
    expect((await call('/api/test/register', { user: C1, body: { phone: '+998901234500', name: 'С согласием' } })).status).toBe(201);
    const row = await DB().prepare('SELECT consent_version, consent_at FROM clients WHERE telegram_id = ?').bind(C1).first<Record<string, string>>();
    expect(row!.consent_version).toBe(CONSENT_VERSION);
    expect(row!.consent_at).toBeTruthy();

    const legal = await json<LegalDTO>(call('/api/legal', { user: C1 }));
    expect(legal).toMatchObject({ version: CONSENT_VERSION, draft: true });
    expect(legal.summary).toHaveLength(4);
    expect(legal.summary.join(' ')).toContain('15 000');
    expect(legal.summary.join(' ')).toContain('180 дней');
    expect(legal.rules.paragraphs.join(' ')).toContain('[ФИО ИП]');
    expect(legal.consent.paragraphs.join(' ')).toContain('[ИНН]');
  });

  it('an existing client without a stored consent is asked once on the next open', async () => {
    const id = (await register(C1)).client!.id;
    await DB().prepare('UPDATE clients SET consent_version = NULL WHERE id = ?').bind(id).run();
    expect((await me(C1)).consent.required).toBe(true);
    await call('/api/me/consent', { user: C1, body: { version: CONSENT_VERSION } });
    expect((await me(C1)).consent.required).toBe(false);
  });
});

// ---------------------------------------------------------------- Л9: credit by phone + claim

async function lookup(q: string) {
  return json<StaffClientLookupDTO>(call(`/api/staff/client?q=${encodeURIComponent(q)}`, { user: FLORIST }));
}
async function creditPhone(phone: string) {
  const res = await call('/api/staff/client/by-phone', { user: FLORIST, body: { phone } });
  return { status: res.status, body: (await res.json()) as PhoneCreditDTO };
}

describe('credit by phone for clients not in the bot (Л9)', () => {
  const PHONE = '+998935550011';

  it('opens a claimable card, accrues normally, sends nothing; the Telegram user who shares the phone claims it (+ welcome)', async () => {
    const found = await lookup('93 555 00 11');
    expect(found).toMatchObject({ client: null, matches: [], phoneCandidate: PHONE });
    const made = await creditPhone('93 555 00 11');
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ created: true, client: { unclaimed: true, balance: 0 } });
    const id = made.body.client.id;
    const row = await DB().prepare('SELECT telegram_id, demo FROM clients WHERE id = ?').bind(id).first<{ telegram_id: number; demo: number }>();
    expect(row).toEqual({ telegram_id: placeholderTelegramId(PHONE), demo: 0 });
    expect(row!.telegram_id).toBeLessThan(-990_999_999); // far from the demo range −990 000 000…
    // again → the same card
    expect(await creditPhone(PHONE)).toMatchObject({ status: 200, body: { created: false, client: { id } } });

    tg.calls.length = 0;
    const p = await buy(FLORIST, id, 200_000);
    expect(p.preview).toMatchObject({ cashback: 2_000, cell: 1 });
    await moveClock(1);
    await buy(FLORIST, id, 200_000);
    expect(tg.sent()).toHaveLength(0); // nobody to message

    // the person shares this phone in the bot → claims the card with all accruals + welcome bonus
    await webhook(contactUpdate(TG_REAL, '+998 93 555 00 11'));
    const claimed = await repo().findClientByTelegramId(TG_REAL);
    expect(claimed?.id).toBe(id);
    expect(String(tg.sent().at(-2)?.payload.text ?? tg.sent().at(-1)?.payload.text)).toMatch(/нашли вас/);
    const card = await json<OwnerClientDTO>(call(`/api/owner/clients/${id}`, { user: OWNER }));
    expect(card).toMatchObject({ telegramId: TG_REAL, balance: 2_000 + 2_000 + 15_000, card: { filled: 2 } });
    expect(card.unclaimed).toBeUndefined();
    const pc = await DB().prepare('SELECT claimed_at FROM phone_credits WHERE client_id = ?').bind(id).first<{ claimed_at: string | null }>();
    expect(pc!.claimed_at).toBeTruthy();

    // a second Telegram account with the same phone cannot take it (double claim)
    await webhook(contactUpdate(TG_REAL + 1, PHONE));
    expect(await repo().findClientByTelegramId(TG_REAL + 1)).toBeNull();
    expect(String(tg.sent().at(-1)!.payload.text)).toContain('уже привязан');
  });

  it('the TEST_MODE register shortcut claims too; a concurrent double claim gives the card to one account only', async () => {
    const id = (await creditPhone(PHONE)).body.client.id;
    await buy(FLORIST, id, 100_000);
    const [a, b] = await Promise.all([
      call('/api/test/register', { user: C1, body: { consent: true, phone: PHONE, name: 'Анна' } }),
      call('/api/test/register', { user: C1 + 1, body: { consent: true, phone: PHONE, name: 'Борис' } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const owners = await DB().prepare('SELECT COUNT(*) AS n FROM clients WHERE phone = ?').bind(PHONE).first<{ n: number }>();
    expect(owners!.n).toBe(1);
    const winner = a.status === 201 ? C1 : C1 + 1;
    expect((await me(winner)).client).toMatchObject({ id, balance: 1_000 + 15_000 });
  });

  it('collisions: a demo client or an imported client keeps its phone; demo cards are never claimable', async () => {
    // demo client (TEST_MODE seeding: demo = 1, id in −990 000 000…)
    const demoPhone = '+998935550099';
    const demo = await repo().createClient({ telegramId: -990_000_123, name: 'Демо', phone: demoPhone, language: 'ru', consentAt: null, createdAt: new Date() });
    await DB().prepare('UPDATE clients SET demo = 1 WHERE id = ?').bind(demo.id).run();
    expect(await creditPhone(demoPhone)).toMatchObject({ status: 200, body: { created: false, client: { id: demo.id } } });
    expect((await call('/api/test/register', { user: C1, body: { consent: true, phone: demoPhone, name: 'X' } })).status).toBe(409);
    // imported client (client_imports): staff finds it, no second card, no phone_credits row
    const imp = await call('/api/owner/import', {
      user: OWNER,
      body: { batchId: 'batch-0011-a', fileName: 'x.csv', dryRun: false, options: { creditBalance: true, levelFromTotal: false, cellsFromCount: false }, rows: [{ line: 2, phone: '+998935550077', name: 'Импорт', balance: 5_000 }] },
    });
    expect(imp.status).toBeLessThan(300);
    const r = await creditPhone('+998935550077');
    expect(r).toMatchObject({ status: 200, body: { created: false } });
    expect(await DB().prepare('SELECT COUNT(*) AS n FROM phone_credits').first<{ n: number }>()).toEqual({ n: 0 });
    // a phone-credit card is NOT counted as an import, and an import of its phone does not credit мёд twice
    const pc = (await creditPhone(PHONE)).body.client.id;
    const imp2 = await call('/api/owner/import', {
      user: OWNER,
      body: { batchId: 'batch-0011-b', fileName: 'y.csv', dryRun: false, options: { creditBalance: true, levelFromTotal: false, cellsFromCount: false }, rows: [{ line: 2, phone: PHONE, name: 'Позже из базы', balance: 7_000 }] },
    });
    expect(imp2.status).toBeLessThan(300);
    const bal = await DB().prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM points_ledger WHERE client_id = ?').bind(pc).first<{ b: number }>();
    expect(bal!.b).toBe(0);
    // validation: a partial number is refused
    expect((await call('/api/staff/client/by-phone', { user: FLORIST, body: { phone: '90 123' } })).status).toBe(400);
    expect((await call('/api/staff/client/by-phone', { user: C1, body: { phone: PHONE } })).status).toBe(403);
  });
});

// ---------------------------------------------------------------- Л8: reversal switch

describe('«Сотрудники могут отменять покупки» (Л8)', () => {
  it('off: only the owner reverses, the florist sees why; on again: the florist may', async () => {
    const id = (await register(C1)).client!.id;
    const a = await buy(FLORIST, id, 100_000);
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    expect(rules.staffCanReverse).toBe(true);
    const off = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, staffCanReverse: false } });
    expect(off.status).toBe(200);
    const res = await call(`/api/staff/purchase/${a.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка кассы' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('только владелец');
    const recent = await json<OperationDTO[]>(call('/api/staff/recent', { user: FLORIST }));
    expect(recent.find((o) => o.purchaseId === a.purchaseId)).toMatchObject({ reversible: false, reverseBlocked: expect.stringContaining('только владелец') });
    const ownerView = await json<OperationDTO[]>(call('/api/owner/operations', { user: OWNER }));
    expect(ownerView.find((o) => o.purchaseId === a.purchaseId)?.reversible).toBe(true);
    expect((await call(`/api/staff/purchase/${a.purchaseId}/reverse`, { user: OWNER, body: { reason: 'ошибка кассы' } })).status).toBe(200);

    const b = await buy(FLORIST, id, 100_000, { idempotencyKey: key() });
    const cur = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...cur, staffCanReverse: true } });
    expect((await call(`/api/staff/purchase/${b.purchaseId}/reverse`, { user: FLORIST, body: { reason: 'ошибка кассы' } })).status).toBe(200);
  });

  it('rules editor: level mode, window and reset are switchable and validated', async () => {
    const rules = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER }));
    expect(rules).toMatchObject({ levelMode: 'sticky', levelBy: 'count', levelWindowDays: 90, levelResetDays: 90, levelResetWarnDays: [7, 1], birthdayEnabled: true, birthdayPct: 10 });
    const rolling = await json<EditableRulesDTO>(call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rules, levelMode: 'rolling' } }));
    expect(rolling.levelMode).toBe('rolling');
    const bad = await call('/api/owner/rules', { user: OWNER, method: 'PUT', body: { ...rolling, levelMode: 'sticky', levelResetDays: 5, levelResetWarnDays: [7] } });
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------- Л6: birthday

describe('birthday gift (Л6)', () => {
  it('entered once by the client; inside the window the gift appears at once; not with мёд; revoked after the last day', async () => {
    const id = (await register(C1)).client!.id;
    const t = await today();
    const year = Number(t.slice(0, 4)) - 30;
    const bday = `${year}${plus(t, 2).slice(4)}`; // birthday in 2 days
    const r = await json<MeDTO>(call('/api/me/birthday', { user: C1, body: { birthday: bday } }));
    expect(r.client!.birthday).toBe(bday);
    const gift = r.client!.gifts.find((g) => g.source === 'birthday')!;
    expect(gift).toMatchObject({ type: 'disc10', status: 'available', validUntil: plus(t, 5) });
    // only once; the owner may change it
    expect((await call('/api/me/birthday', { user: C1, body: { birthday: '1990-01-01' } })).status).toBe(409);
    expect((await call('/api/me/birthday', { user: C1, body: { birthday: '1990-02-31' } })).status).toBe(400);
    expect((await call('/api/me/birthday', { user: C1, body: null })).status).toBe(400); // QA fuzz: a JSON null body
    // not together with мёд; alone it gives −10 %
    const withHoney = await json(call('/api/staff/purchase/preview', { user: FLORIST, body: { clientId: id, amount: 100_000, redeem: true, giftId: gift.id } }));
    expect(withHoney).toMatchObject({ maxRedeem: 0, redeemed: 0, discount: 10_000 });
    const used = await json<PurchaseResultDTO>(call('/api/staff/purchase', { user: FLORIST, body: { clientId: id, amount: 100_000, redeem: false, giftId: gift.id, idempotencyKey: key() } }));
    expect(used.preview.discount).toBe(10_000);
    // once a year: the job does not give it again
    await job();
    expect((await me(C1)).client!.gifts.filter((g) => g.source === 'birthday')).toHaveLength(1);
  });

  it('the daily job unlocks it 3 days before and revokes it after 3 days after; the owner changes the date', async () => {
    const id = (await register(C1)).client!.id;
    const t = await today();
    const bday = `1990${plus(t, 10).slice(4)}`;
    await call('/api/me/birthday', { user: C1, body: { birthday: bday } });
    expect((await me(C1)).client!.gifts).toHaveLength(0);
    expect(await nextOf(id)).toBe(plus(t, 7));
    await moveClock(7);
    tg.calls.length = 0;
    await job();
    expect(tg.sent().map((m) => String(m.payload.text)).join('\n')).toContain('С наступающим днём рождения');
    expect((await me(C1)).client!.gifts[0]).toMatchObject({ source: 'birthday', status: 'available', validUntil: plus(t, 13) });
    expect(await nextOf(id)).toBe(plus(t, 14));
    await moveClock(7);
    await job();
    expect((await me(C1)).client!.gifts[0]).toMatchObject({ source: 'birthday', status: 'revoked' });
    // owner changes the date → the card shows it; the client cannot
    const card = await json<OwnerClientDTO>(call(`/api/owner/clients/${id}/birthday`, { user: OWNER, method: 'PUT', body: { birthday: '1990-03-08' } }));
    expect(card.birthday).toBe('1990-03-08');
    expect((await call(`/api/owner/clients/${id}/birthday`, { user: FLORIST, method: 'PUT', body: { birthday: '1990-03-09' } })).status).toBe(403);
  });

  it('a real Telegram user (initData) sets it too; unregistered callers cannot', async () => {
    expect((await call('/api/me/birthday', { headers: await tmaHeader(TG_REAL), body: { birthday: '1991-05-05' } })).status).toBe(403);
  });
});
