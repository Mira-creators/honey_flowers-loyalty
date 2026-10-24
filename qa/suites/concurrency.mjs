// Concurrency: parallel requests on ONE client. Every 2xx must correspond to exactly one stored
// operation, every rejection to none; never a 5xx, never a lost update or a double credit / spend.
import { as, clock, newKey, register, setRole, sql, wipe } from '../lib/api.mjs';
import { area } from '../lib/report.mjs';
import { checkInvariants } from '../lib/invariants.mjs';

const OWNER = 900_000_100, FLORIST = 900_000_101;
const N = Number(process.env.QA_PARALLEL || 20);

const statusHist = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

export async function run() {
  const s = area('concurrency');
  const metrics = {};
  await wipe();
  await clock('reset');
  await setRole(OWNER, 'owner');
  await setRole(FLORIST, 'florist');
  const f = as(FLORIST);
  const c1 = await register(900_200_001, 'Параллельная');
  const id = c1.id;

  // 1. N parallel purchases, distinct keys
  const rs1 = await Promise.all(Array.from({ length: N }, (_, i) => f.post('/api/staff/purchase', { clientId: id, amount: 100_000 + i, redeem: false, idempotencyKey: newKey('par') })));
  const ok1 = rs1.filter((r) => r.status === 201);
  const [db1] = await sql(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM purchases WHERE client_id = ?`, [id]);
  const [led1] = await sql(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS pts FROM points_ledger WHERE client_id = ? AND type = 'accrual'`, [id]);
  const [cells1] = await sql(`SELECT COUNT(*) AS n FROM card_moves WHERE client_id = ? AND reverted_at IS NULL`, [id]);
  s.check(`${N} parallel purchases: only 201 / 409, no 5xx`, rs1.every((r) => r.status === 201 || r.status === 409), statusHist(rs1));
  s.check(`L3: ${N} parallel purchases on ONE client: ≤ 25% «повторите» (jittered retries)`, rs1.filter((r) => r.status === 409).length <= N / 4, statusHist(rs1));
  s.eq(`${N} parallel purchases: stored = accepted (${ok1.length}/${N} accepted)`, [db1.n, db1.amt, led1.n], [ok1.length, ok1.reduce((t, r) => t + r.body.preview.amount, 0), ok1.length]);
  s.eq('parallel purchases: accrued = Σ cashback of accepted responses', led1.pts, ok1.reduce((t, r) => t + r.body.preview.cashback, 0));
  s.eq('parallel purchases same day: exactly 1 cell', cells1.n, Math.min(1, ok1.length));
  s.check('parallel purchases: the purchase that got the cell is unique', ok1.filter((r) => r.body.preview.cell !== null).length === Math.min(1, ok1.length), ok1.map((r) => r.body.preview.cell));
  if (ok1.length < N) s.check(`parallel purchases: rejected ones say "повторите" (409 conflict)`, rs1.filter((r) => r.status === 409).every((r) => r.body?.error?.code === 'conflict'), rs1.filter((r) => r.status === 409).map((r) => r.body?.error?.message).slice(0, 2));
  metrics.parallelPurchases = statusHist(rs1);

  // 2. N parallel retries with the SAME key
  const key = newKey('same');
  const rs2 = await Promise.all(Array.from({ length: N }, () => f.post('/api/staff/purchase', { clientId: id, amount: 123_456, redeem: false, idempotencyKey: key })));
  metrics.sameKey = () => statusHist(rs2);
  const [db2] = await sql(`SELECT COUNT(*) AS n FROM purchases WHERE idempotency_key = ?`, [key]);
  const ids2 = new Set(rs2.filter((r) => r.status < 300).map((r) => r.body.purchaseId));
  s.check(`${N} parallel same-key retries: no 5xx`, rs2.every((r) => r.status < 500), statusHist(rs2));
  s.eq(`${N} parallel same-key retries: exactly one purchase stored`, db2.n, 1);
  s.eq('same-key retries: all successes return the same purchase, exactly one 201', [ids2.size, rs2.filter((r) => r.status === 201).length], [1, 1]);
  s.check('same-key retries: the others are 200 replayed (or 409)', rs2.every((r) => r.status === 201 || (r.status === 200 && r.body.replayed) || r.status === 409), statusHist(rs2));

  // 3. N parallel redeems when the balance covers only one
  const c3 = await register(900_200_002, 'Списание');
  const adj = await as(OWNER).post(`/api/owner/clients/${c3.id}/adjust`, { points: 5_000, reason: 'Для теста' });
  s.eq('setup: balance 5 000', adj.body.client.balance, 5_000);
  const rs3 = await Promise.all(Array.from({ length: N }, () => f.post('/api/staff/purchase', { clientId: c3.id, amount: 10_000, redeem: true, idempotencyKey: newKey('red') })));
  metrics.parallelRedeems = () => statusHist(rs3);
  const ok3 = rs3.filter((r) => r.status === 201);
  const [red] = await sql(`SELECT COALESCE(-SUM(amount),0) AS r, COUNT(*) AS n FROM points_ledger WHERE client_id = ? AND type = 'redeem'`, [c3.id]);
  const [bal] = await sql(`SELECT COALESCE(SUM(amount),0) AS b FROM points_ledger WHERE client_id = ?`, [c3.id]);
  const [acc] = await sql(`SELECT COALESCE(SUM(amount),0) AS a FROM points_ledger WHERE client_id = ? AND type = 'accrual'`, [c3.id]);
  s.check(`${N} parallel redeems: no 5xx`, rs3.every((r) => r.status === 201 || r.status === 409), statusHist(rs3));
  s.eq('parallel redeems: exactly one took the full 5 000', ok3.filter((r) => r.body.preview.redeemed === 5_000).length, 1);
  s.check('parallel redeems: total redeemed ≤ 5 000 + cashback earned meanwhile', red.r <= 5_000 + acc.a && bal.b >= 0, { redeemed: red.r, accrued: acc.a, balance: bal.b });
  s.eq('parallel redeems: Σ redeemed in responses = ledger', ok3.reduce((t, r) => t + r.body.preview.redeemed, 0), red.r);

  // 4. N parallel reversals of the same purchase
  const target = ok1[0].body.purchaseId;
  const rs4 = await Promise.all(Array.from({ length: N }, () => f.post(`/api/staff/purchase/${target}/reverse`, { reason: 'Параллельная отмена' })));
  metrics.parallelReversals = () => statusHist(rs4);
  const [rv] = await sql(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS a FROM points_ledger WHERE purchase_id = ? AND type = 'reversal'`, [target]);
  s.check(`${N} parallel reversals: no 5xx`, rs4.every((r) => r.status < 500), statusHist(rs4));
  s.eq('parallel reversals: exactly one 200, the rest 409', [rs4.filter((r) => r.status === 200).length, rs4.filter((r) => r.status === 409).length], [1, N - 1]);
  s.eq('parallel reversals: one reversal entry', rv.n, 1);

  // 5. N parallel hand-outs of one gift
  await clock(1);
  const c5 = await register(900_200_003, 'Подарочная');
  let gift = null;
  for (let d = 0; d < 3; d++) {
    const r = await f.post('/api/staff/purchase', { clientId: c5.id, amount: 100_000, redeem: false, idempotencyKey: newKey('g') });
    gift = r.body.giftsUnlocked[0] ?? gift;
    await clock(1);
  }
  const rs5 = await Promise.all(Array.from({ length: N }, () => f.post(`/api/staff/gift/${encodeURIComponent(gift.id)}/use`, {})));
  metrics.giftHandOuts = () => statusHist(rs5);
  const [g5] = await sql(`SELECT status FROM rewards WHERE id = ?`, [gift.id]);
  s.check(`${N} parallel gift hand-outs: no 5xx, gift used once`, rs5.every((r) => r.status < 500) && g5.status === 'used', statusHist(rs5));
  const rs5b = await Promise.all(Array.from({ length: N }, () => f.post('/api/staff/purchase', { clientId: c5.id, amount: 200_000, redeem: false, giftId: gift.id, idempotencyKey: newKey('gp') })));
  const [g5b] = await sql(`SELECT COUNT(*) AS n FROM purchases WHERE reward_used_id = ?`, [gift.id]);
  s.check('used gift in parallel purchases: all rejected, none stored', rs5b.every((r) => r.status === 409) && g5b.n === 0, statusHist(rs5b));

  // 6. N parallel adjustments with the same key / distinct keys
  const ak = 'parallel-adjust-key';
  const rs6 = await Promise.all(Array.from({ length: N }, () => as(OWNER).post(`/api/owner/clients/${c5.id}/adjust`, { points: 777, reason: 'Параллельно', idempotencyKey: ak })));
  metrics.sameKeyAdjust = () => statusHist(rs6);
  const [a6] = await sql(`SELECT COUNT(*) AS n FROM points_ledger WHERE client_id = ? AND type = 'manual_adjust'`, [c5.id]);
  s.check(`${N} parallel same-key adjustments: no 5xx, exactly one entry`, rs6.every((r) => r.status < 500) && a6.n === 1, { hist: statusHist(rs6), n: a6.n });
  const rs6b = await Promise.all(Array.from({ length: N }, () => as(OWNER).post(`/api/owner/clients/${c5.id}/adjust`, { points: 10, reason: 'Параллельно' })));
  metrics.distinctAdjust = () => statusHist(rs6b);
  const [a6b] = await sql(`SELECT COUNT(*) AS n FROM points_ledger WHERE client_id = ? AND type = 'manual_adjust'`, [c5.id]);
  s.check(`${N} parallel distinct adjustments: entries = accepted`, rs6b.every((r) => r.status === 200 || r.status === 409) && a6b.n === 1 + rs6b.filter((r) => r.status === 200).length, { hist: statusHist(rs6b), n: a6b.n });

  // 7. parallel registrations with the same phone
  const rs7 = await Promise.all(Array.from({ length: N }, (_, i) => as(900_210_000 + i).post('/api/test/register', { phone: '+998977777777', name: `Гонка ${i}` })));
  metrics.samePhoneRegistrations = () => statusHist(rs7);
  const [p7] = await sql(`SELECT COUNT(*) AS n FROM clients WHERE phone = '+998977777777'`);
  s.check(`${N} parallel registrations, same phone: one 201, others 409, no 5xx`, rs7.filter((r) => r.status === 201).length === 1 && rs7.every((r) => r.status === 201 || r.status === 409) && p7.n === 1, statusHist(rs7));
  const rs7b = await Promise.all(Array.from({ length: N }, () => as(900_220_000).post('/api/test/register', { phone: '+998977777700', name: 'Двойник' })));
  metrics.oneUserRegistrations = () => statusHist(rs7b);
  const [p7b] = await sql(`SELECT COUNT(*) AS n FROM clients WHERE telegram_id = 900220000`);
  s.check(`${N} parallel registrations of ONE user: all 201 (idempotent, L4), one client`, rs7b.every((r) => r.status === 201) && p7b.n === 1 && new Set(rs7b.map((r) => r.body?.client?.id)).size === 1, statusHist(rs7b));

  // 8. parallel rules saves with the same base version
  const base = (await as(OWNER).get('/api/owner/rules')).body;
  const rs8 = await Promise.all(Array.from({ length: N }, (_, i) => as(OWNER).put('/api/owner/rules', { ...base, minPurchaseForCell: 100_000 + i })));
  metrics.rulesSaves = () => statusHist(rs8);
  const [rv8] = await sql(`SELECT COUNT(*) AS n FROM rules_versions`);
  s.check(`${N} parallel rules saves: exactly one 200, others 409`, rs8.filter((r) => r.status === 200).length === 1 && rs8.every((r) => r.status === 200 || r.status === 409) && rv8.n === 2, { hist: statusHist(rs8), versions: rv8.n });

  // 9. parallel consumption of one export link
  const link = await as(OWNER).post('/api/owner/export/link', { kind: 'clients' });
  const u = new URL(link.body.url);
  const rs9 = await Promise.all(Array.from({ length: N }, () => fetch(`http://127.0.0.1:${process.env.QA_PORT || 8797}${u.pathname}${u.search}`).then(async (r) => ({ status: r.status, len: (await r.arrayBuffer()).byteLength }))));
  s.eq(`${N} parallel downloads of a one-time link: exactly one 200`, [rs9.filter((r) => r.status === 200).length, rs9.filter((r) => r.status === 410).length], [1, N - 1]);

  // 10. mixed: purchases + reversals + adjustments + gift on one client at once
  await clock(1);
  const c10 = await register(900_200_010, 'Смешанная');
  const seed = [];
  for (let d = 0; d < 4; d++) {
    seed.push((await f.post('/api/staff/purchase', { clientId: c10.id, amount: 150_000, redeem: false, idempotencyKey: newKey('m') })).body);
    if (d < 3) await clock(1); // the last one stays inside the 24 h reversal window (item 8)
  }
  const mixed = [
    ...seed.map((p) => f.post(`/api/staff/purchase/${p.purchaseId}/reverse`, { reason: 'Смешанный тест' })),
    ...Array.from({ length: 6 }, () => f.post('/api/staff/purchase', { clientId: c10.id, amount: 120_000, redeem: true, idempotencyKey: newKey('mx') })),
    ...Array.from({ length: 4 }, (_, i) => as(OWNER).post(`/api/owner/clients/${c10.id}/adjust`, { points: i % 2 ? -300 : 1_000, reason: 'Смешанный' })),
    ...(seed[2].giftsUnlocked[0] ? [f.post(`/api/staff/gift/${encodeURIComponent(seed[2].giftsUnlocked[0].id)}/use`, {})] : []),
  ];
  const rs10 = await Promise.all(mixed);
  metrics.mixed = () => statusHist(rs10);
  s.check('mixed parallel operations: no 5xx', rs10.every((r) => r.status < 500), statusHist(rs10));
  s.check('mixed: reversals of purchases older than 24 h refused (409 «Отмена возможна только…»)', rs10.slice(0, 3).every((r) => r.status === 409 && /Отмена возможна только в течение 24 ч/.test(r.body?.error?.message ?? '')), rs10.slice(0, 3).map((r) => [r.status, r.body?.error?.message]));

  for (const k of Object.keys(metrics)) if (typeof metrics[k] === 'function') metrics[k] = metrics[k]();
  console.log('  status histograms:', JSON.stringify(metrics));
  const v = await checkInvariants();
  s.check('invariants after all concurrency tests', v.length === 0, v.slice(0, 6));
  return metrics;
}
