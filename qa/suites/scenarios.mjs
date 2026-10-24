// Scenario tests with exact numbers hand-computed from the rules (read from GET /api/owner/rules).
// Default rules (packages/core/src/defaultRules.ts): levels 1% / 3% (≥ 2 000 000) / 5% (≥ 6 000 000),
// a cell needs ≥ 100 000, 1 cell per day, мёд pays ≤ 50% of an order, burns 90 days after the last
// purchase with reminders 14 / 7 / 1 days before, gifts: cell 3 card, 6 delivery, 10 disc10.
import { as, clock, newKey, register, runExpiryAll, setRole, sql, wipe, req } from '../lib/api.mjs';
import { area, note } from '../lib/report.mjs';
import { addDays, checkExpirySettled, checkInvariants, pctOf, tashkentDay } from '../lib/invariants.mjs';
import { startFakeTelegram, stopFakeTelegram, telegram } from '../lib/worker.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101, MANAGER = 900_000_102;
const A = 900_001_001, B = 900_001_002, C = 900_001_003;

export async function invariantsStep(label, a = area('invariants (scenarios)')) {
  const v = await checkInvariants();
  a.check(`invariants after: ${label}`, v.length === 0, v.slice(0, 5));
  return v;
}

async function buy(user, clientId, amount, extra = {}) {
  const r = await as(user).post('/api/staff/purchase', { clientId, amount, redeem: false, idempotencyKey: newKey('buy'), ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`purchase ${amount}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}

export async function setupRoles() {
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  await setRole(MANAGER, 'manager');
}

export async function run() {
  const s = area('scenarios');
  await wipe();
  await clock('reset');
  await setupRoles();
  const rules = (await as(OWNER).get('/api/owner/rules')).body;
  s.eq('default rules: levels', rules.levels.map((l) => [l.id, l.pct, l.from]), [['bee', 1, 0], ['honey', 3, 2_000_000], ['queen', 5, 6_000_000]]);
  s.eq('default rules: thresholds', [rules.minPurchaseForCell, rules.maxCellsPerDay, rules.maxRedeemPct, rules.expiryDays, rules.expiryWarnDays, rules.welcomeBonus, rules.cells, rules.gifts], [100_000, 1, 50, 90, [14, 7, 1], 0, 10, { 3: 'card', 6: 'delivery', 10: 'disc10' }]);
  const pct = (lvl) => rules.levels.find((l) => l.id === lvl).pct;
  const cb = (paid, lvl = 'bee') => pctOf(paid, pct(lvl));

  // ---------------------------------------------------------------- 1. registration by phone
  const regA = await as(A).post('/api/test/register', { phone: '+998 (90) 123-45-67', name: 'Дилноза' });
  s.eq('register: 201', regA.status, 201);
  const a0 = regA.body.client;
  s.check('register: phone normalized and masked', a0.phoneMasked === '+998 90 ••• •• 67', a0.phoneMasked);
  s.eq('register: empty card', [a0.balance, a0.card.filled, a0.card.cycle, a0.level.id, a0.gifts.length, a0.expiresOn], [0, 0, 1, 'bee', 0, null]);
  s.check('register: code HF + 4..6 digits', /^HF\d{4,6}$/.test(a0.code), a0.code);
  const regDup = await as(B).post('/api/test/register', { phone: '998901234567', name: 'Чужой' });
  s.eq('register: same phone on another Telegram account → 409', regDup.status, 409);
  s.eq('register: invalid phone → 400', (await as(B).post('/api/test/register', { phone: '12-34', name: 'x' })).status, 400);
  const id = a0.id;
  const f = as(FLORIST);
  for (const [q, label] of [[a0.code, 'code'], [a0.code.toLowerCase(), 'lower-case code'], [`HF:${a0.code}`, 'QR payload'], ['+998 90 123 45 67', 'full phone'], ['901234567', 'national phone'], [id, 'client id']]) {
    const r = await f.get('/api/staff/client?q=' + encodeURIComponent(q));
    s.check(`lookup by ${label}`, r.status === 200 && r.body.client?.id === id, `${r.status} ${r.text.slice(0, 120)}`);
  }
  s.eq('lookup: 3 digits → 400', (await f.get('/api/staff/client?q=123')).status, 400);
  const miss = await f.get('/api/staff/client?q=HF000001');
  s.check('lookup: unknown code → client null', miss.status === 200 && miss.body.client === null, miss.text.slice(0, 100));

  // ---------------------------------------------------------------- 2. purchases below / above threshold, same day
  const p1 = await buy(FLORIST, id, 50_000);
  s.eq('P1 50 000 (below 100 000): cashback 1% = 500, no cell', [p1.preview.cashback, p1.preview.pct, p1.preview.cell, p1.preview.cellBlockedReason, p1.client.balance, p1.client.card.filled], [cb(50_000), 1, null, 'below_min', 500, 0]);
  const p2 = await buy(FLORIST, id, 150_000);
  s.eq('P2 150 000: cashback 1 500, cell 1, balance 2 000', [p2.preview.cashback, p2.preview.cell, p2.client.balance, p2.client.card.filled], [1_500, 1, 2_000, 1]);
  const pv3 = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 200_000, redeem: false })).body;
  s.eq('preview P3 same day: daily limit announced, nothing stored', [pv3.cell, pv3.cellBlockedReason, pv3.cashback], [null, 'daily_limit', 2_000]);
  const p3 = await buy(FLORIST, id, 200_000);
  s.eq('P3 200 000 same day: cashback 2 000, NO 2nd cell (daily limit)', [p3.preview.cashback, p3.preview.cell, p3.preview.cellBlockedReason, p3.client.balance, p3.client.card.filled], [2_000, null, 'daily_limit', 4_000, 1]);
  await invariantsStep('same-day purchases');

  // ---------------------------------------------------------------- 3. +1 day → cell 2; +1 day → cell 3 gift
  await clock(1);
  const p4 = await buy(FLORIST, id, 100_000);
  s.eq('P4 100 000 next day (= threshold): cell 2, balance 5 000', [p4.preview.cashback, p4.preview.cell, p4.client.balance], [1_000, 2, 5_000]);
  await clock(1);
  const pv5 = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 300_000, redeem: false })).body;
  s.eq('preview P5: cell 3 unlocks a gift (card)', [pv5.cell, pv5.unlocksGift, pv5.giftType], [3, true, 'card']);
  const p5 = await buy(FLORIST, id, 300_000);
  s.eq('P5 300 000: cell 3, gift «card» unlocked, balance 8 000', [p5.preview.cell, p5.giftsUnlocked.map((g) => [g.type, g.cell, g.status]), p5.client.balance], [3, [['card', 3, 'available']], 8_000]);
  const gift = p5.giftsUnlocked[0];

  // ---------------------------------------------------------------- 4. use the gift, then twice
  const use1 = await f.post(`/api/staff/gift/${encodeURIComponent(gift.id)}/use`, {});
  s.check('gift use: 200, status used', use1.status === 200 && use1.body.client.gifts.find((g) => g.id === gift.id)?.status === 'used', use1.text.slice(0, 200));
  const use2 = await f.post(`/api/staff/gift/${encodeURIComponent(gift.id)}/use`, {});
  s.check('gift use twice: idempotent (no second hand-out)', use2.status === 200 || use2.status === 409, `${use2.status}`);
  const used = await sql(`SELECT COUNT(*) AS n FROM rewards WHERE id = ? AND status = 'used'`, [gift.id]);
  const handed = await sql(`SELECT COUNT(*) AS n FROM rewards WHERE client_id = ? AND status = 'used'`, [id]);
  s.eq('gift used exactly once in DB', [used[0].n, handed[0].n], [1, 1]);
  const useInPurchase = await f.post('/api/staff/purchase', { clientId: id, amount: 100_000, redeem: false, giftId: gift.id, idempotencyKey: newKey() });
  s.eq('used gift in a purchase → 409 conflict', [useInPurchase.status, useInPurchase.body?.error?.code], [409, 'conflict']);
  s.eq('gift use: unknown id → 404', (await f.post('/api/staff/gift/nope/use', {})).status, 404);
  await invariantsStep('gift use');

  // ---------------------------------------------------------------- 5. redeem: partial (cap), full, more than balance, cap
  await clock(1);
  const pv6 = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 10_000, redeem: true })).body;
  s.eq('preview 10 000 with мёд: cap 50% = 5 000 < balance 8 000', [pv6.maxRedeem, pv6.redeemed, pv6.paid, pv6.cashback], [5_000, 5_000, 5_000, cb(5_000)]);
  const p6 = await buy(FLORIST, id, 10_000, { redeem: true });
  s.eq('P6 10 000 + мёд: redeemed 5 000 (cap), paid 5 000, cashback 50 on the paid part, balance 3 050', [p6.preview.redeemed, p6.preview.paid, p6.preview.cashback, p6.preview.cell, p6.client.balance], [5_000, 5_000, 50, null, 3_050]);
  const p7 = await buy(FLORIST, id, 100_000, { redeem: true });
  s.eq('P7 100 000 + мёд: redeems the whole balance 3 050, cashback 1% of 96 950 = 969, cell 4', [p7.preview.redeemed, p7.preview.paid, p7.preview.cashback, p7.preview.cell, p7.client.balance], [3_050, 96_950, 969, 4, 969]);
  const pvBig = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 1_000_000, redeem: true })).body;
  s.eq('preview: order larger than balance → maxRedeem = balance 969 (cannot redeem more than balance)', [pvBig.maxRedeem, pvBig.redeemed], [969, 969]);
  const pvCap = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 1_000, redeem: true })).body;
  s.eq('preview: 1 000 order → maxRedeem capped at 500', [pvCap.maxRedeem, pvCap.redeemed, pvCap.paid], [500, 500, 500]);
  const pvNo = (await f.post('/api/staff/purchase/preview', { clientId: id, amount: 1_000, redeem: false })).body;
  s.eq('preview without мёд: redeemed 0, maxRedeem still shown', [pvNo.redeemed, pvNo.maxRedeem], [0, 500]);
  note('info', 'API has no explicit "redeem N points" field: redeem=true always takes min(balance, cap). "More than balance" can only be checked through maxRedeem (engine-level INSUFFICIENT_BALANCE is unreachable from HTTP).');
  await invariantsStep('redeem');

  // ---------------------------------------------------------------- 6. reversals
  const r7 = await f.post(`/api/staff/purchase/${p7.purchaseId}/reverse`, { reason: 'Ошибка в сумме' });
  s.eq('reverse P7 (latest step): +3 050 refunded, −969 clawed back, card back to 3, no warnings', [r7.status, r7.body.client.balance, r7.body.client.card.filled, r7.body.warnings], [200, 3_050, 3, []]);
  const r7b = await f.post(`/api/staff/purchase/${p7.purchaseId}/reverse`, { reason: 'повтор' });
  s.eq('reverse P7 again → 409 already_reversed', [r7b.status, r7b.body?.error?.code], [409, 'already_reversed']);
  const r6 = await f.post(`/api/staff/purchase/${p6.purchaseId}/reverse`, { reason: 'Клиент вернул' });
  s.eq('reverse P6 (a redeem): +5 000 back, −50 cashback → balance 8 000 (as before P6)', [r6.status, r6.body.client.balance], [200, 8_000]);
  s.eq('reverse: reason < 3 chars → 400', (await f.post(`/api/staff/purchase/${p4.purchaseId}/reverse`, { reason: 'x' })).status, 400);
  s.eq('reverse: unknown purchase → 404', (await f.post(`/api/staff/purchase/00000000-0000-0000-0000-000000000000/reverse`, { reason: 'тест' })).status, 404);
  await invariantsStep('reversals');

  // reversal after the honey was spent / the gift was used (item 8: refused, never a negative balance)
  await clock(1);
  const p8 = await buy(FLORIST, id, 20_000, { redeem: true });
  s.eq('P8 20 000 + мёд: redeems 8 000 (≤ cap 10 000), cashback 120, balance 120', [p8.preview.redeemed, p8.preview.cashback, p8.client.balance], [8_000, 120, 120]);
  const r5 = await f.post(`/api/staff/purchase/${p5.purchaseId}/reverse`, { reason: 'Возврат букета' });
  s.eq('reverse P5 two days later → 409 «Отмена возможна только в течение 24 ч»', [r5.status, /Отмена возможна только в течение 24 ч после покупки/.test(r5.body?.error?.message ?? '')], [409, true]);
  const recentOps = (await f.get('/api/staff/recent')).body;
  const opP5 = recentOps.find((o) => o.purchaseId === p5.purchaseId && o.kind === 'purchase');
  s.check('florist list: P5 not reversible, reason shown', opP5 && opP5.reversible === false && /24 ч/.test(opP5.reverseBlocked ?? ''), opP5);
  const rWide = (await as(OWNER).get('/api/owner/rules')).body;
  s.eq('default rules: reversalWindowHours 24', rWide.reversalWindowHours, 24);
  s.eq('owner widens the reversal window to 720 h', (await as(OWNER).put('/api/owner/rules', { ...rWide, reversalWindowHours: 720 })).status, 200);
  const r5g = await f.post(`/api/staff/purchase/${p5.purchaseId}/reverse`, { reason: 'Возврат букета' });
  s.eq('reverse P5 (its cell-3 gift was used) → 409 «Подарок за эту покупку уже использован» (no gift earned twice)', [r5g.status, /Подарок за эту покупку уже использован — отменить нельзя/.test(r5g.body?.error?.message ?? '')], [409, true]);
  const rP4 = await f.post(`/api/staff/purchase/${p4.purchaseId}/reverse`, { reason: 'Возврат букета' });
  s.eq('reverse P4 after its 1 000 cashback was spent (balance 120) → 409 «Мёд с этой покупки уже потрачен … Скорректировать мёд» (was −880)', [rP4.status, /Мёд с этой покупки уже потрачен — отменить нельзя.*Скорректировать мёд/.test(rP4.body?.error?.message ?? '')], [409, true]);
  const rNarrow = (await as(OWNER).get('/api/owner/rules')).body;
  await as(OWNER).put('/api/owner/rules', { ...rNarrow, reversalWindowHours: 24 });
  const meAfter = (await as(A).get('/api/me')).body.client;
  const stP5 = await sql('SELECT status FROM purchases WHERE id IN (?, ?)', [p4.purchaseId, p5.purchaseId]);
  s.eq('refused reversals changed nothing: balance 120, card 3, gift used, P4/P5 active', [meAfter.balance, meAfter.card.filled, meAfter.gifts.find((g) => g.id === gift.id)?.status, stP5.map((x) => x.status)], [120, 3, 'used', ['active', 'active']]);
  await clock(1);
  const p9 = await buy(FLORIST, id, 100_000, { redeem: true });
  s.eq('P9 100 000 + мёд: redeems the 120 left, cashback 1% of 99 880 = 998, balance 998', [p9.preview.redeemed, p9.preview.cashback, p9.client.balance], [120, cb(99_880), cb(99_880)]);
  s.eq('P9 fills cell 4 (no second «card» gift)', [p9.preview.cell, p9.giftsUnlocked.map((g) => g.type)], [4, []]);
  await invariantsStep('reversal after spend');

  // ---------------------------------------------------------------- 7. idempotency
  const k = newKey('idem');
  const i1 = await f.post('/api/staff/purchase', { clientId: id, amount: 70_000, redeem: false, idempotencyKey: k });
  const i2 = await f.post('/api/staff/purchase', { clientId: id, amount: 70_000, redeem: false, idempotencyKey: k });
  s.eq('same key twice → 201 then 200 replayed, same purchase', [i1.status, i2.status, i2.body.replayed, i2.body.purchaseId === i1.body.purchaseId], [201, 200, true, true]);
  s.eq('same key, other amount → 409', (await f.post('/api/staff/purchase', { clientId: id, amount: 71_000, redeem: false, idempotencyKey: k })).status, 409);
  await register(B, 'Бобур', '+998911112233');
  const bId = (await as(B).get('/api/me')).body.client.id;
  s.eq('same key for another client → 409', (await f.post('/api/staff/purchase', { clientId: bId, amount: 70_000, redeem: false, idempotencyKey: k })).status, 409);
  const rIdem = await f.post(`/api/staff/purchase/${i1.body.purchaseId}/reverse`, { reason: 'Тест идемпотентности' });
  const i3 = await f.post('/api/staff/purchase', { clientId: id, amount: 70_000, redeem: false, idempotencyKey: k });
  s.check('replay of a reversed purchase does not re-credit', rIdem.status === 200 && i3.status === 200 && i3.body.replayed === true && i3.body.client.balance === rIdem.body.client.balance, `${i3.status} bal ${i3.body?.client?.balance} vs ${rIdem.body?.client?.balance}`);

  // ---------------------------------------------------------------- 8. level up across two boundaries in one purchase
  const pb1 = await buy(FLORIST, bId, 7_000_000);
  s.eq('B buys 7 000 000 at «bee»: 1% = 70 000 (level BEFORE applies), level up to «queen» (both 2M and 6M crossed)', [pb1.preview.pct, pb1.preview.cashback, pb1.levelUp?.id, pb1.client.level.id, pb1.client.balance], [1, cb(7_000_000), 'queen', 'queen', 70_000]);
  await clock(1);
  const pb2 = await buy(FLORIST, bId, 100_000);
  s.eq('B next purchase 100 000 at «queen»: 5% = 5 000', [pb2.preview.pct, pb2.preview.cashback, pb2.levelUp], [5, 5_000, null]);
  const pbMax = await f.post('/api/staff/purchase', { clientId: bId, amount: 100_000_001, redeem: false, idempotencyKey: newKey() });
  s.eq('purchase above maxPurchaseAmount (100 000 000) → 400', pbMax.status, 400);
  const pbEdge = await f.post('/api/staff/purchase', { clientId: bId, amount: 100_000_000, redeem: false, idempotencyKey: newKey() });
  s.eq('purchase = maxPurchaseAmount → 201, 5% = 5 000 000', [pbEdge.status, pbEdge.body?.preview?.cashback], [201, 5_000_000]);
  await invariantsStep('level up');

  // ---------------------------------------------------------------- 9. owner changes the rules mid-way
  const before = (await as(OWNER).get('/api/owner/rules')).body;
  const edited = { ...before, levels: before.levels.map((l, i) => ({ ...l, pct: [2, 4, 6][i] })), minPurchaseForCell: 50_000, gifts: { ...before.gifts, 5: 'mini' } };
  const put = await as(OWNER).put('/api/owner/rules', edited);
  s.eq('PUT rules → new version', [put.status, put.body.version], [200, before.version + 1]);
  s.eq('PUT rules with the stale version → 409', (await as(OWNER).put('/api/owner/rules', edited)).status, 409);
  s.eq('PUT rules: florist → 403', (await f.put('/api/owner/rules', { ...edited, version: put.body.version })).status, 403);
  await clock(1);
  const meA = (await as(A).get('/api/me')).body.client;
  const pr1 = await buy(FLORIST, id, 60_000);
  s.eq('after rules change: 60 000 → 2% = 1 200 and fills a cell (min now 50 000)', [pr1.preview.pct, pr1.preview.cashback, pr1.preview.cell], [2, 1_200, meA.card.filled + 1]);
  const hist = (await as(OWNER).get(`/api/owner/clients/${id}`)).body.history;
  const h2 = hist.find((h) => h.purchaseId === p2.purchaseId && h.kind === 'purchase');
  s.eq('history unchanged: P2 still 1% / 1 500', [h2.pct, h2.cashback], [1, 1_500]);
  const v1 = await sql('SELECT rules_version_id AS v FROM purchases WHERE id = ?', [p2.purchaseId]);
  s.eq('P2 keeps rules version 1', v1[0].v, 1);
  // lower thresholds: level of existing clients changes through SQL recompute of client_stats
  const r3 = (await as(OWNER).get('/api/owner/rules')).body;
  const lowered = { ...r3, levels: r3.levels.map((l, i) => ({ ...l, from: [0, 500_000, 900_000][i] })) };
  s.eq('PUT rules with lower thresholds → 200', (await as(OWNER).put('/api/owner/rules', lowered)).status, 200);
  const statsA = (await sql('SELECT level_id, spent FROM client_stats WHERE client_id = ?', [id]))[0];
  s.check('client_stats.level_id recomputed for the new thresholds', (statsA.spent >= 900_000 ? 'queen' : statsA.spent >= 500_000 ? 'honey' : 'bee') === statsA.level_id, statsA);
  await invariantsStep('rules change');
  // back to defaults-like pct 1/3/5 for the rest
  const r4 = (await as(OWNER).get('/api/owner/rules')).body;
  await as(OWNER).put('/api/owner/rules', { ...r4, levels: before.levels, minPurchaseForCell: 100_000, gifts: before.gifts });

  // ---------------------------------------------------------------- 10. manual adjust, note, card
  const adj = (body) => as(OWNER).post(`/api/owner/clients/${bId}/adjust`, body);
  const balB = (await as(B).get('/api/me')).body.client.balance;
  const ad1 = await adj({ points: 1_000, reason: 'Компенсация', idempotencyKey: 'adj-key-0001' });
  s.eq('adjust +1 000', [ad1.status, ad1.body.client.balance, ad1.body.replayed], [200, balB + 1_000, false]);
  const ad1b = await adj({ points: 1_000, reason: 'Компенсация', idempotencyKey: 'adj-key-0001' });
  s.eq('adjust replay (same key) → replayed, no double credit', [ad1b.status, ad1b.body.replayed, ad1b.body.client.balance], [200, true, balB + 1_000]);
  const ad2 = await adj({ points: -500, reason: 'Ошибка' });
  s.eq('adjust −500', [ad2.status, ad2.body.client.balance], [200, balB + 500]);
  const adNeg = await adj({ points: -(balB + 10_000), reason: 'Списание' });
  s.check('adjust below zero → allowed with a warning', adNeg.status === 200 && adNeg.body.client.balance === -9_500 && adNeg.body.warnings.length === 1, `${adNeg.status} ${adNeg.body?.client?.balance} ${JSON.stringify(adNeg.body?.warnings)}`);
  note('question', 'Manual adjustment may take the balance below zero (only a warning). Should the owner be blocked instead?');
  await adj({ points: 9_500 + balB, reason: 'Возврат' });
  for (const [body, label] of [[{ points: 0, reason: 'ноль' }, 'zero'], [{ points: 5, reason: 'аб' }, 'reason < 3'], [{ points: 100_000_001, reason: 'много' }, '> maxPurchaseAmount'], [{ points: 1.5, reason: 'дробь' }, 'float'], [{ reason: 'нет' }, 'missing points']]) {
    s.eq(`adjust ${label} → 400`, (await adj(body)).status, 400);
  }
  s.eq('adjust unknown client → 404', (await as(OWNER).post('/api/owner/clients/nope/adjust', { points: 1, reason: 'тест' })).status, 404);
  const longNote = 'Любит пионы 🌸; звонить после 18:00 — «Oʻgʻiloy» ’'.padEnd(500, '.');
  const n1 = await as(OWNER).put(`/api/owner/clients/${bId}/note`, { note: longNote });
  s.eq('note 500 chars with emoji/Uzbek ʻ ’ saved', [n1.status, n1.body.note], [200, longNote]);
  s.eq('note 501 chars → 400', (await as(OWNER).put(`/api/owner/clients/${bId}/note`, { note: longNote + 'x' })).status, 400);
  const card = (await as(OWNER).get(`/api/owner/clients/${bId}`)).body;
  s.eq('client card: full phone, note, telegramId, history incl. manual', [card.phone, card.note, card.telegramId, card.history.filter((h) => h.kind === 'manual').length], ['+998911112233', longNote, B, 4]);
  s.eq('note "" clears it', (await as(OWNER).put(`/api/owner/clients/${bId}/note`, { note: '   ' })).body.note, null);
  s.eq('client card unknown → 404', (await as(OWNER).get('/api/owner/clients/nope')).status, 404);
  await invariantsStep('adjust/note');

  // ---------------------------------------------------------------- 11. expiry: reminders and burn
  await register(C, 'Сардор', '+998935550011');
  const cId = (await as(C).get('/api/me')).body.client.id;
  await clock(1);
  const pc = await buy(FLORIST, cId, 500_000);
  const cBal = pc.client.balance;
  s.eq('C buys 500 000: 1% = 5 000', cBal, 5_000);
  const D = tashkentDay(pc.client.history[0].at);
  s.eq('C expiresOn = purchase day + 89 (last valid day)', pc.client.expiresOn, addDays(D, 89));
  const keysOf = async () => (await sql(`SELECT key FROM notification_keys WHERE client_id = ? ORDER BY rowid`, [cId])).map((r) => r.key);
  await clock(75);
  await runExpiryAll();
  s.eq('day +75: no reminder yet', await keysOf(), []);
  await clock(1);
  const e76 = await runExpiryAll();
  s.check('day +76 (14 days left): reminder', (await keysOf()).includes(`expiry_warning:${D}:14`) && e76.warned >= 1, `${JSON.stringify(await keysOf())} ${JSON.stringify(e76)}`);
  const exp = await as(OWNER).get('/api/owner/clients?status=expiring');
  s.check('day +76: not yet in «expiring» (burns in 14 days)', !exp.body.items.some((i) => i.id === cId), exp.body.items.map((i) => i.name));
  await clock(7);
  await runExpiryAll();
  s.check('day +83: 7-day reminder', (await keysOf()).includes(`expiry_warning:${D}:7`), await keysOf());
  const exp2 = await as(OWNER).get('/api/owner/clients?status=expiring');
  s.check('day +83: in «expiring» filter', exp2.body.items.some((i) => i.id === cId), exp2.body.items.map((i) => i.name));
  await clock(6);
  await runExpiryAll();
  const c89 = (await as(C).get('/api/me')).body.client;
  s.eq('day +89: 1-day reminder, balance still 5 000, expiresOn = today', [(await keysOf()).includes(`expiry_warning:${D}:1`), c89.balance, c89.expiresOn], [true, 5_000, addDays(D, 89)]);
  await clock(1);
  const e90 = await runExpiryAll();
  const c90 = (await as(C).get('/api/me')).body.client;
  const ledgerC = await sql(`SELECT type, amount FROM points_ledger WHERE client_id = ? ORDER BY rowid`, [cId]);
  const statsC = (await sql('SELECT balance, expires_on FROM client_stats WHERE client_id = ?', [cId]))[0];
  s.eq('day +90: burned → balance 0, expire entry −5 000, client_stats updated', [c90.balance, ledgerC.at(-1), statsC.balance, statsC.expires_on, e90.expired >= 1], [0, { type: 'expire', amount: -5_000 }, 0, '', true]);
  s.check('history shows the burn', c90.history.some((h) => h.kind === 'expire' && h.points === -5_000), c90.history.slice(0, 3));
  const e90b = await runExpiryAll();
  const ledgerC2 = await sql(`SELECT COUNT(*) AS n FROM points_ledger WHERE client_id = ? AND type = 'expire'`, [cId]);
  s.eq('re-running the daily job does not burn twice', [ledgerC2[0].n, e90b.expired], [1, 0]);
  const meNow = (await as(C).get('/api/me')).body.now;
  const settled = await checkExpirySettled(meNow);
  s.check('no positive balance past its expiry day after the job', settled.length === 0, settled.slice(0, 3));
  const st = (await as(OWNER).get('/api/owner/stats')).body;
  const sum = (await sql('SELECT COALESCE(SUM(amount),0) AS s FROM points_ledger'))[0].s;
  s.eq('owner stats: outstanding = Σ ledger, accrued − redeemed − expired = outstanding', [st.points.outstanding, st.points.accrued - st.points.redeemed - st.points.expired], [sum, sum]);
  // adjust after burn restarts the timer
  const adC = await as(OWNER).post(`/api/owner/clients/${cId}/adjust`, { points: 2_000, reason: 'Подарок' });
  s.eq('adjust after burn: balance 2 000, expires 89 days later', [adC.body.client.balance, adC.body.client.expiresOn], [2_000, addDays(tashkentDay(meNow), 89)]);
  await invariantsStep('expiry');

  // ---------------------------------------------------------------- 11b. notifications never break requests
  const nl = area('notifications');
  const [logBefore] = await sql(`SELECT COUNT(*) AS n FROM notifications_log WHERE status = 'failed'`);
  telegram.failSend = true; // Bot API answers 403 "bot was blocked by the user"
  const nb1 = await f.post('/api/staff/purchase', { clientId: bId, amount: 100_000, redeem: false, idempotencyKey: newKey('n') });
  nl.eq('Telegram answers 403 → purchase still 201', nb1.status, 201);
  stopFakeTelegram(); // Bot API unreachable (connection refused)
  const nb2 = await f.post('/api/staff/purchase', { clientId: bId, amount: 100_000, redeem: false, idempotencyKey: newKey('n') });
  const nb3 = await as(OWNER).post(`/api/owner/clients/${bId}/adjust`, { points: 10, reason: 'Проверка' });
  const nb4 = await as(9_999_990 + 900_000_000).post('/api/test/run-expiry', {});
  nl.eq('Telegram unreachable → purchase 201, adjust 200, daily job 200', [nb2.status, nb3.status, nb4.status], [201, 200, 200]);
  await startFakeTelegram();
  await new Promise((r) => setTimeout(r, 300));
  const [logAfter] = await sql(`SELECT COUNT(*) AS n FROM notifications_log WHERE status = 'failed'`);
  nl.check('failed sends are logged in notifications_log', logAfter.n >= logBefore.n + 3, `${logBefore.n} → ${logAfter.n}`);

  // ---------------------------------------------------------------- 12. roles
  const r = area('roles');
  const ownerGets = ['/api/owner/stats', '/api/owner/rules', '/api/owner/staff', '/api/owner/operations', '/api/owner/clients', `/api/owner/clients/${id}`, `/api/owner/clients/${id}/history`, '/api/owner/export/clients.csv', '/api/owner/export/operations.csv',
    '/api/owner/console/overview', '/api/owner/console/clients', '/api/owner/console/operations', '/api/owner/console/cohorts', '/api/owner/import/batches', '/api/web/me'];
  const ownerPosts = [['POST', `/api/owner/clients/${id}/adjust`, { points: 1, reason: 'тест' }], ['PUT', `/api/owner/clients/${id}/note`, { note: 'x' }], ['POST', '/api/owner/export/link', { kind: 'clients' }], ['POST', '/api/owner/staff', { phoneOrTelegramId: 'id:5005', role: 'florist' }], ['DELETE', '/api/owner/staff/x', undefined], ['PUT', '/api/owner/rules', {}],
    ['POST', `/api/owner/clients/${id}/grant`, { kind: 'honey', points: 100, reason: 'тест роли' }], ['POST', '/api/owner/web-link', {}], ['POST', '/api/owner/import/x/undo', {}],
    ['POST', '/api/owner/import', { batchId: 'roles-import-01', dryRun: false, options: { creditBalance: true, levelFromTotal: true, cellsFromCount: true }, rows: [{ line: 2, phone: '+998905559999', balance: 1000 }] }]];
  for (const [who, user] of [['florist', FLORIST], ['manager', MANAGER], ['client', A]]) {
    for (const p of ownerGets) r.eq(`${who} GET ${p.replace(id, ':id')} → 403`, (await as(user).get(p)).status, 403);
    for (const [m, p, b] of ownerPosts) r.eq(`${who} ${m} ${p.replace(id, ':id')} → 403`, (await req(user, m, p, { body: b })).status, 403);
  }
  const staffCalls = [['GET', '/api/staff/client?q=' + a0.code], ['POST', '/api/staff/purchase/preview', { clientId: id, amount: 1000, redeem: false }], ['POST', '/api/staff/purchase', { clientId: id, amount: 1000, redeem: false, idempotencyKey: newKey() }], ['POST', `/api/staff/purchase/${p4.purchaseId}/reverse`, { reason: 'тест роли' }], ['POST', `/api/staff/gift/${gift.id}/use`, {}], ['GET', '/api/staff/recent']];
  for (const [m, p, b] of staffCalls) r.eq(`client ${m} ${p.split('?')[0]} → 403`, (await req(A, m, p, { body: b })).status, 403);
  for (const [m, p, b] of staffCalls.slice(0, 2)) r.eq(`manager ${m} ${p.split('?')[0]} → 200`, (await req(MANAGER, m, p, { body: b })).status, 200);
  const fp = await sql(`SELECT COUNT(*) AS n FROM purchases WHERE status = 'reversed'`);
  r.eq('rejected role calls changed nothing (P4 still active)', (await sql('SELECT status FROM purchases WHERE id = ?', [p4.purchaseId]))[0].status, 'active');
  void fp;
  // staff management
  const addF = await as(OWNER).post('/api/owner/staff', { phoneOrTelegramId: '+998 91 555 44 33', role: 'florist' });
  r.eq('owner adds florist by phone → 201', addF.status, 201);
  r.eq('ambiguous 9-digit id/phone → 400', (await as(OWNER).post('/api/owner/staff', { phoneOrTelegramId: '901234567', role: 'florist' })).status, 400);
  const addO = await as(OWNER).post('/api/owner/staff', { phoneOrTelegramId: `id:${OWNER}`, role: 'owner' });
  r.eq('owner registers himself as staff owner → 201', addO.status, 201);
  const demote = await as(OWNER).post('/api/owner/staff', { phoneOrTelegramId: `id:${OWNER}`, role: 'florist' });
  r.eq('last owner cannot demote himself → 409', demote.status, 409);
  const delSelf = await as(OWNER).del(`/api/owner/staff/${addO.body.id}`);
  r.check('TEST_MODE: owner removing himself', delSelf.status === 200 || delSelf.status === 409, `${delSelf.status}`);
  if (delSelf.status === 200) note('info', 'In TEST_MODE=1 the owner CAN deactivate himself and the last owner (by design: routes/owner.ts skips both checks in test mode). Checked with TEST_MODE=0 in the "security (TEST_MODE=0)" area.');
  await invariantsStep('roles', area('invariants (scenarios)'));
  return { ids: { A: id, B: bId, C: cId } };
}
