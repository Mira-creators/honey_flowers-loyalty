// The owner's rules (packages/core defaultRules; docs/Спорные вопросы.md Л1–Л9, Д1) end to end over
// HTTP, with invariants after every step: levels by purchase days in 90 days, sticky level with its
// own reset timer next to the 180-day мёд timer (daily job), welcome bonus within the 50 % cap,
// consent gate, credit by phone + claim (and a double claim), the staff reversal switch, the
// birthday gift. Restores the placeholder rules for the suites that follow.
import { as, clock, newKey, runExpiryAll, setRole, sql, useRules, wipe } from '../lib/api.mjs';
import { area } from '../lib/report.mjs';
import { addDays, checkInvariants, tashkentDay } from '../lib/invariants.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101;
const A = 900_002_001, B = 900_002_002, C = 900_002_003, D = 900_002_004, E = 900_002_005;

async function inv(s, label) {
  const v = await checkInvariants();
  s.check(`invariants after: ${label}`, v.length === 0, v.slice(0, 5));
}

async function buy(clientId, amount, extra = {}) {
  const r = await as(FLORIST).post('/api/staff/purchase', { clientId, amount, redeem: false, idempotencyKey: newKey('own'), ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`purchase ${amount}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}

const today = async () => tashkentDay((await as(OWNER).get('/api/me')).body.now);

export async function run() {
  const s = area('owner rules');
  await useRules('owner');
  try {
    await wipe();
    await clock('reset');
    await setRole(OWNER, 'owner');
    await setRole(FLORIST, 'florist');
    const rules = (await as(OWNER).get('/api/owner/rules')).body;
    s.eq('rules: levels by count 0 / 3 / 10, sticky, 90 days', [rules.levels.map((l) => [l.id, l.pct, l.from]), rules.levelBy, rules.levelMode, rules.levelWindowDays, rules.levelResetDays, rules.levelResetWarnDays],
      [[['bee', 1, 0], ['queen', 3, 3], ['gold', 5, 10]], 'count', 'sticky', 90, 90, [7, 1]]);
    s.eq('rules: мёд, bonus, cells, birthday, reversal', [rules.expiryDays, rules.expiryWarnDays, rules.welcomeBonus, rules.minPurchaseForCell, rules.maxCellsPerDay, rules.maxRedeemPct, rules.birthdayEnabled, rules.birthdayPct, rules.staffCanReverse],
      [180, [14, 7, 1], 15_000, 0, 1, 50, true, 10, true]);

    // ---------------------------------------------------------------- Д1 consent gate
    const noConsent = await as(A).post('/api/test/register', { phone: '+998 97 100 00 01', name: 'Без согласия' });
    s.eq('consent: registration refused without «Принимаю»', [noConsent.status, noConsent.body?.error?.code], [409, 'consent_required']);
    const legal = (await as(A).get('/api/legal')).body;
    s.check('consent: 4 bullets from the rules, draft templates with placeholders', legal.summary.length === 4 && legal.draft === true && legal.rules.paragraphs.join(' ').includes('[ИНН]'), legal.summary);
    await as(A).post('/api/me/consent', { version: legal.version });
    const regA = await as(A).post('/api/test/register', { phone: '+998 97 100 00 01', name: 'Азиза' });
    s.eq('Л5: registered with 15 000 мёда, consent stored', [regA.status, regA.body.client.balance, regA.body.consent.required], [201, 15_000, false]);
    const a = regA.body.client.id;

    // ---------------------------------------------------------------- Л5 + cap, Л2 one purchase per day
    const p1 = await buy(a, 20_000, { redeem: true });
    s.eq('Л5: welcome bonus spendable at once within 50 % (20 000 → 10 000)', [p1.preview.redeemed, p1.preview.paid, p1.preview.cashback, p1.preview.cell], [10_000, 10_000, 100, 1]);
    const p2 = await buy(a, 500_000);
    s.eq('Л2: the same day counts once (no cell, level metric 1)', [p2.preview.cell, p2.client.spent], [null, 1]);
    await clock(1);
    await buy(a, 30_000);
    await clock(1);
    const p4 = await buy(a, 30_000);
    s.eq('Л1: Королева улья at the 3rd purchase day; 1 % on that purchase', [p4.preview.pct, p4.levelUp?.id, p4.client.level.id, p4.client.next?.left], [1, 'queen', 'queen', 7]);
    const t0 = await today();
    s.eq('Л3: level kept until last purchase + 89, мёд until + 179', [p4.client.levelKeptUntil, p4.client.expiresOn], [addDays(t0, 89), addDays(t0, 179)]);
    await inv(s, 'levels by count');

    // ---------------------------------------------------------------- Л1 sticky + two timers in the daily job
    await clock(85);
    const p5 = await buy(a, 100_000);
    s.eq('Л1: after 85 days (90-day count 1) the level is kept: 3 %', [p5.preview.pct, p5.client.level.id], [3, 'queen']);
    const t1 = await today();
    await clock(83);
    const w = await runExpiryAll();
    s.check('Л3: daily job sends the 7-day level reminder (мёд not due yet)', w.warned === 0 && w.checked >= 1, w);
    const keys = await sql(`SELECT key FROM notification_keys WHERE client_id = ? ORDER BY key`, [a]);
    s.check('Л3: level reminder key stored', keys.some((k) => k.key === `level_warning:${t1}:7`), keys);
    const next = (await sql('SELECT next_check_on AS n FROM clients WHERE id = ?', [a]))[0].n;
    s.eq('schedule: next check = the 1-day level reminder', next, addDays(t1, 89));
    await clock(7);
    await runExpiryAll();
    const meA = (await as(A).get('/api/me')).body.client;
    s.eq('Л1: reset to Пчёлка after 90 days without purchases; мёд stays', [meA.level.id, meA.levelKeptUntil, meA.balance > 0], ['bee', null, true]);
    s.check('Л1: one level_reset key', (await sql(`SELECT COUNT(*) AS n FROM notification_keys WHERE client_id = ? AND key = ?`, [a, `level_reset:${t1}`]))[0].n === 1, '');
    s.eq('schedule: next check = the 14-day мёд reminder', (await sql('SELECT next_check_on AS n FROM clients WHERE id = ?', [a]))[0].n, addDays(t1, 180 - 14));
    await inv(s, 'sticky reset');
    await clock(90);
    await runExpiryAll();
    const burnt = (await as(A).get('/api/me')).body.client;
    s.eq('Л4: мёд burns 180 days after the last purchase', burnt.balance, 0);
    await inv(s, 'мёд expiry');
    await clock('reset');

    // ---------------------------------------------------------------- Л9 credit by phone + claim
    const PHONE = '+998971000002';
    const look = (await as(FLORIST).get(`/api/staff/client?q=${encodeURIComponent('97 100 00 02')}`)).body;
    s.eq('Л9: an unknown full number is offered', [look.client, look.phoneCandidate], [null, PHONE]);
    const made = await as(FLORIST).post('/api/staff/client/by-phone', { phone: PHONE });
    s.eq('Л9: claimable card opened', [made.status, made.body.created, made.body.client.unclaimed], [201, true, true]);
    const pc = made.body.client.id;
    await buy(pc, 300_000);
    const again = await as(FLORIST).post('/api/staff/client/by-phone', { phone: PHONE });
    s.eq('Л9: the same phone → the same card', [again.status, again.body.client.id], [200, pc]);
    const [c1, c2] = await Promise.all([
      as(B).post('/api/test/register', { consent: true, phone: PHONE, name: 'Борис' }),
      as(C).post('/api/test/register', { consent: true, phone: PHONE, name: 'Вика' }),
    ]);
    s.eq('Л9: a double claim gives the card to one account', [c1.status, c2.status].sort(), [201, 409]);
    const winner = c1.status === 201 ? c1 : c2;
    s.eq('Л9: claimed with accruals + welcome bonus', [winner.body.client.id, winner.body.client.balance], [pc, 3_000 + 15_000]);
    s.check('Л9: phone_credits marked claimed', (await sql('SELECT claimed_at FROM phone_credits WHERE client_id = ?', [pc]))[0]?.claimed_at, '');
    await inv(s, 'credit by phone + claim');

    // ---------------------------------------------------------------- Л8 reversal switch
    const regD = await as(D).post('/api/test/register', { consent: true, phone: '+998 97 100 00 04', name: 'Дилшод' });
    const d = regD.body.client.id;
    const pd = await buy(d, 100_000);
    const off = await as(OWNER).put('/api/owner/rules', { ...rules, staffCanReverse: false });
    s.eq('Л8: switch saved', [off.status, off.body.staffCanReverse], [200, false]);
    const byFlorist = await as(FLORIST).post(`/api/staff/purchase/${pd.purchaseId}/reverse`, { reason: 'ошибка' });
    s.eq('Л8: florist refused when off', byFlorist.status, 403);
    const byOwner = await as(OWNER).post(`/api/staff/purchase/${pd.purchaseId}/reverse`, { reason: 'ошибка' });
    s.eq('Л8: owner may', byOwner.status, 200);
    await inv(s, 'reversal switch');

    // ---------------------------------------------------------------- Л6 birthday
    const regE = await as(E).post('/api/test/register', { consent: true, phone: '+998 97 100 00 05', name: 'Евгения' });
    const e = regE.body.client.id;
    const t2 = await today();
    const bd = `1992${addDays(t2, 5).slice(4)}`;
    const setB = await as(E).post('/api/me/birthday', { birthday: bd });
    s.eq('Л6: birthday set once; no gift yet (5 days ahead)', [setB.status, setB.body.client.birthday, setB.body.client.gifts.length], [200, bd, 0]);
    s.eq('Л6: second entry refused', (await as(E).post('/api/me/birthday', { birthday: '1992-01-01' })).status, 409);
    await clock(2);
    await runExpiryAll();
    const gift = (await as(E).get('/api/me')).body.client.gifts.find((g) => g.source === 'birthday');
    s.check('Л6: the daily job unlocks −10 % three days before, valid 3 days after', gift && gift.status === 'available' && gift.validUntil === addDays(t2, 8), gift);
    const pv = (await as(FLORIST).post('/api/staff/purchase/preview', { clientId: e, amount: 100_000, redeem: true, giftId: gift.id })).body;
    s.eq('Л6: not combined with мёд', [pv.discount, pv.redeemed], [10_000, 0]);
    await clock(7);
    await runExpiryAll();
    const gone = (await as(E).get('/api/me')).body.client.gifts.find((g) => g.source === 'birthday');
    s.eq('Л6: revoked after the last day', gone?.status, 'revoked');
    await inv(s, 'birthday');
  } finally {
    await clock('reset');
    await wipe();
    await useRules('placeholder');
  }
}
