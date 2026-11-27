/**
 * Slim M5: sale of bouquets (+ services such as delivery) ↔ loyalty purchase.
 *
 * TWO STEPS (prototype deviation from architecture §1.3 «one db.batch»; see docs «Журнал»):
 *   1. stock batch: header(sale) → bouquet status → 'sold' (guard: a second sale of the same
 *      bouquet aborts here) → stock_sales (loyalty_status 'pending' when there is a client) → lines;
 *   2. loyalty purchase through the existing LoyaltyService with idempotency key `sale:<saleId>`
 *      and lines by cashback category (bouquets → flowers, services → delivery: no honey);
 *   3. stock_sales ← purchase id, redeemed honey, paid; loyalty_status 'done'.
 * Step 2 can only fail for loyalty reasons (honey spent meanwhile, gift used, own card); then the
 * sale stays posted with loyalty_status 'failed' + the reason, and «Начислить мёд ещё раз»
 * (POST /api/stock/sales/:id/loyalty, or a replay of the same request) re-runs step 2 — the key
 * `sale:<id>` makes it idempotent. The owner overview counts pending/failed sales (reconciliation).
 * Making it strictly atomic needs the LoyaltyService hook from architecture Appendix A
 * (extra statements in saveOutcome's batch), deliberately not done in the prototype.
 */
import type { StockSalePreviewDTO, StockSaleResultDTO } from '@honey/contracts';
import { applyPurchase, LoyaltyError, maxRedeemable, type PurchaseLine } from '@honey/core';
import type { StockConfig } from '@honey/stock';
import { z } from 'zod';
import { actingStaff, type Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError, toApiError } from '../lib/errors.js';
import { assertNotOwnCard } from '../routes/staff.js';
import { actorOf, classifyDbError, docByKeyStmt, headerStmt, idemKey, mapPostingError, num, payloadHash, postedStmt, replayOf, requireStock, revStmt, strOrNull, type DocRow, type Row } from './core.js';

export const saleSchema = z.object({
  idempotencyKey: idemKey,
  clientId: z.string().min(1).max(64).nullish(),
  bouquets: z.array(z.object({ id: z.string().min(1).max(64), price: z.number().int().positive().max(100_000_000).nullish() })).min(1).max(20),
  services: z.array(z.object({ itemId: z.string().min(1).max(64), price: z.number().int().min(0).max(100_000_000) })).max(5).default([]),
  channel: z.enum(['store', 'delivery']).default('store'),
  redeem: z.boolean().default(false),
  // Owner-granted gift ids are long ('grant-grant:<uuid>:<uuid>', ~85 chars) — audit CODE-2.
  giftId: z.string().min(1).max(200).nullish(),
  /** Honey amount shown to the client in the preview; step 2 takes exactly this (audit CODE-7). */
  redeemPoints: z.number().int().min(0).max(100_000_000).nullish(),
  paymentMethod: z.enum(['cash', 'card', 'transfer', 'mixed']).default('cash'),
});
type SaleReq = z.infer<typeof saleSchema>;

interface Planned {
  lines: Array<{ kind: 'bouquet' | 'service'; bouquetId: string | null; itemId: string | null; name: string; price: number; cost: number; category: 'flowers' | 'delivery' }>;
  total: number;
  cost: number;
}

async function planSale(app: AppContext, req: SaleReq): Promise<Planned & { doc: DocRow | null; client: Awaited<ReturnType<AppContext['repo']['findClientById']>> }> {
  const db = app.repo.db;
  const bIds = req.bouquets.map((b) => b.id);
  if (new Set(bIds).size !== bIds.length) throw new HttpError(400, 'validation', 'Букет указан дважды');
  const sIds = req.services.map((s) => s.itemId);
  const [bs, items, doc] = await db.batch<Row>([
    db.prepare(`SELECT b.id, b.status, b.price_current_uzs, b.cost_uzs, d.number FROM stock_bouquets b JOIN stock_docs d ON d.id = b.assembly_doc_id WHERE b.id IN (${bIds.map(() => '?').join(',')})`).bind(...bIds),
    db.prepare(`SELECT id, name, kind, active FROM stock_items WHERE id IN (${sIds.length ? sIds.map(() => '?').join(',') : "''"})`).bind(...sIds),
    docByKeyStmt(db, req.idempotencyKey),
  ]);
  const byId = new Map(bs!.results.map((b) => [String(b.id), b]));
  const lines: Planned['lines'] = [];
  for (const rb of req.bouquets) {
    const b = byId.get(rb.id);
    if (!b) throw new HttpError(404, 'not_found', 'Букет не найден');
    lines.push({ kind: 'bouquet', bouquetId: rb.id, itemId: null, name: `Букет №${num(b.number)}`, price: rb.price ?? num(b.price_current_uzs), cost: num(b.cost_uzs), category: 'flowers' });
  }
  const svc = new Map(items!.results.map((i) => [String(i.id), i]));
  for (const s of req.services) {
    const it = svc.get(s.itemId);
    if (!it || it.kind !== 'service' || num(it.active) !== 1) throw new HttpError(400, 'validation', 'Услуга не найдена');
    lines.push({ kind: 'service', bouquetId: null, itemId: s.itemId, name: String(it.name), price: s.price, cost: 0, category: 'delivery' });
  }
  const total = lines.reduce((a, l) => a + l.price, 0);
  const client = req.clientId ? await app.repo.findClientById(req.clientId) : null;
  if (req.clientId && !client) throw new HttpError(404, 'not_found', 'Клиент не найден');
  return { lines, total, cost: lines.reduce((a, l) => a + l.cost, 0), doc: (doc!.results[0] as unknown as DocRow) ?? null, client };
}

const purchaseLines = (lines: Planned['lines']): PurchaseLine[] => {
  const by = new Map<string, number>();
  for (const l of lines) by.set(l.category, (by.get(l.category) ?? 0) + l.price);
  return [...by.entries()].filter(([, a]) => a > 0).map(([category, amount]) => ({ category: category as PurchaseLine['category'], amount }));
};

export async function previewSale(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig): Promise<StockSalePreviewDTO> {
  requireStock(caller, 'sale.post', cfg);
  const req = saleSchema.parse({ idempotencyKey: 'preview-only', ...(body as object) });
  const p = await planSale(app, req);
  let loyalty: StockSalePreviewDTO['loyalty'] = null;
  if (p.client) {
    assertNotOwnCard(app, caller, p.client);
    const now = app.now();
    const { rules } = await app.repo.getActiveRules(now);
    if (p.total > rules.maxPurchaseAmount) throw new HttpError(400, 'validation', `Сумма покупки не может превышать ${rules.maxPurchaseAmount.toLocaleString('ru-RU')} сум`);
    const { state } = await app.repo.loadClientState(p.client.id, { now, rules, rewardIds: req.giftId ? [req.giftId] : [] });
    const lines = purchaseLines(p.lines);
    const maxRedeem = maxRedeemable(rules, state, lines, req.giftId ?? null, now);
    const out = applyPurchase(rules, state, { purchaseId: 'preview', idempotencyKey: `preview-${crypto.randomUUID()}`, staffId: null, lines, channel: req.channel, redeemPoints: req.redeem ? maxRedeem : 0, useRewardId: req.giftId ?? null }, now);
    const r = out.purchase!.result!;
    loyalty = { paid: r.paid, redeemed: r.pointsRedeemed, discount: r.discountApplied, cashback: r.cashback, maxRedeem, pct: r.cashbackPct, cell: r.cellAdvanced ? r.cell : null };
  }
  return { total: p.total, lines: p.lines.map((l) => ({ kind: l.kind, name: l.name, price: l.price, category: l.category })), loyalty };
}

export async function postSale(app: AppContext, caller: Caller, body: unknown, cfg: StockConfig, opts: { demo?: boolean } = {}): Promise<StockSaleResultDTO> {
  requireStock(caller, 'sale.post', cfg);
  const req = saleSchema.parse(body);
  const hash = await payloadHash(req);
  const actor = actorOf(caller);
  const db = app.repo.db;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await planSale(app, req);
    const prior = replayOf(p.doc, hash, 'sale');
    if (prior) return completeLoyalty(app, prior.id, true);
    if (p.client) assertNotOwnCard(app, caller, p.client);
    // the gift must still be this client's and available BEFORE the stock part is posted; otherwise the sale
    // is paid but its honey step can never complete (audit API-7). A race after this check still ends in
    // «failed», and «Без оплаты мёдом» (clears the gift) finishes it.
    if (req.giftId && p.client) {
      const g = await db.prepare('SELECT status FROM rewards WHERE id = ? AND client_id = ?').bind(req.giftId, p.client.id).first<Row>();
      if (!g) throw new HttpError(404, 'not_found', 'Подарок не найден у этого клиента');
      if (g.status !== 'available') throw new HttpError(409, 'conflict', 'Подарок уже использован — обновите экран и выберите другой');
    }
    if (!(p.total > 0)) throw new HttpError(400, 'validation', 'Сумма продажи должна быть больше 0');
    const { rules } = await app.repo.getActiveRules(app.now());
    if (p.total > rules.maxPurchaseAmount) throw new HttpError(400, 'validation', `Сумма покупки не может превышать ${rules.maxPurchaseAmount.toLocaleString('ru-RU')} сум`);
    const now = app.now().toISOString();
    const docDate = new Date(Date.parse(now) + 5 * 3_600_000).toISOString().slice(0, 10);
    const saleId = crypto.randomUUID();
    const stmts: D1PreparedStatement[] = [
      headerStmt(db, { id: saleId, kind: 'sale', docDate, key: req.idempotencyKey, hash, actor, now, demo: opts.demo }),
      // guards: bouquet transitions (already sold → ABORT)
      ...p.lines.filter((l) => l.bouquetId).map((l) => db.prepare(`UPDATE stock_bouquets SET status = 'sold', sale_id = ?, closed_at = ? WHERE id = ?`).bind(saleId, now, l.bouquetId)),
      db
        .prepare(
          `INSERT INTO stock_sales (id, client_id, loyalty_status, redeem, redeem_points, gift_id, total_uzs, honey_redeemed, discount_uzs, paid_uzs, payment_method, channel, cost_uzs, actor_id, demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(saleId, p.client?.id ?? null, p.client ? 'pending' : 'none', req.redeem ? 1 : 0, req.redeem ? req.redeemPoints ?? null : null, req.giftId ?? null, p.total, p.total, req.paymentMethod, req.channel, p.cost, actor.id, opts.demo ? 1 : 0, now),
      db
        .prepare(
          `INSERT INTO stock_sale_lines (sale_id, line_no, kind, bouquet_id, item_id, qty, price_uzs, cost_uzs, category)
           SELECT ?1, key + 1, json_extract(value,'$.k'), json_extract(value,'$.b'), json_extract(value,'$.i'), 1, json_extract(value,'$.p'), json_extract(value,'$.c'), json_extract(value,'$.g') FROM json_each(?2)`,
        )
        .bind(saleId, JSON.stringify(p.lines.map((l) => ({ k: l.kind, b: l.bouquetId, i: l.itemId, p: l.price, c: l.cost, g: l.category })))),
      postedStmt(db, saleId, 0n, now),
      revStmt(db),
    ];
    try {
      await db.batch(stmts);
    } catch (e) {
      if (classifyDbError(e) === 'idempotency') continue;
      mapPostingError(e);
    }
    return completeLoyalty(app, saleId, false, actingStaff(caller).id);
  }
  throw new HttpError(409, 'conflict', 'Повторите операцию');
}

/** Step 2 (+3): loyalty purchase `sale:<id>`; idempotent; records the outcome on the sale. */
export async function completeLoyalty(app: AppContext, saleId: string, replayed: boolean, staffId?: string): Promise<StockSaleResultDTO> {
  const db = app.repo.db;
  const [s, lines] = await db.batch<Row>([
    db.prepare('SELECT s.*, d.number FROM stock_sales s JOIN stock_docs d ON d.id = s.id WHERE s.id = ?').bind(saleId),
    db.prepare('SELECT category, price_uzs FROM stock_sale_lines WHERE sale_id = ? ORDER BY line_no').bind(saleId),
  ]);
  const sale = s!.results[0];
  if (!sale) throw new HttpError(404, 'not_found', 'Продажа не найдена');
  const base = (over: Partial<StockSaleResultDTO> = {}): StockSaleResultDTO => ({
    saleId, number: num(sale.number), replayed, total: num(sale.total_uzs), paid: num(sale.paid_uzs), honeyRedeemed: num(sale.honey_redeemed), cashback: 0,
    loyaltyStatus: sale.loyalty_status as StockSaleResultDTO['loyaltyStatus'], loyaltyError: strOrNull(sale.loyalty_error), purchaseId: strOrNull(sale.loyalty_purchase_id),
    clientBalance: null, warnings: [], ...over,
  });
  const clientId = strOrNull(sale.client_id);
  if (!clientId) return base();
  const key = `sale:${saleId}`;
  const giftId = strOrNull(sale.gift_id);
  const plines: PurchaseLine[] = [];
  for (const l of lines!.results) {
    const ex = plines.find((x) => x.category === l.category);
    if (ex) ex.amount += num(l.price_uzs);
    else if (num(l.price_uzs) > 0) plines.push({ category: l.category as PurchaseLine['category'], amount: num(l.price_uzs) });
  }
  try {
    const purchaseId = crypto.randomUUID();
    const res = await app.service.execute(clientId, ({ rules, state, now }) => {
      const prior = state.purchases.find((p) => p.idempotencyKey === key);
      // A purchase already saved under this key (step 3 lost) is replayed with ITS parameters, not the sale row's:
      // «без оплаты мёдом» clears gift/redeem on the row, which must not turn a replay into a conflict (CODE-6).
      if (prior) {
        return applyPurchase(rules, state, { purchaseId, idempotencyKey: key, staffId: staffId ?? String(sale.actor_id), lines: plines, channel: sale.channel as 'store' | 'delivery', redeemPoints: prior.pointsRedeemed, useRewardId: prior.rewardUsedId }, now);
      }
      const maxRedeem = maxRedeemable(rules, state, plines, giftId, now);
      const fixed = sale.redeem_points === null || sale.redeem_points === undefined ? null : num(sale.redeem_points);
      if (num(sale.redeem) === 1 && fixed !== null && fixed > maxRedeem) {
        throw new HttpError(409, 'insufficient_points', `Мёда сейчас меньше, чем в расчёте (доступно ${maxRedeem}) — проведите без оплаты мёдом или пересчитайте`);
      }
      const redeemPoints = num(sale.redeem) === 1 ? (fixed ?? maxRedeem) : 0;
      return applyPurchase(rules, state, { purchaseId, idempotencyKey: key, staffId: staffId ?? String(sale.actor_id), lines: plines, channel: sale.channel as 'store' | 'delivery', redeemPoints, useRewardId: giftId }, now);
    }, { keys: [key], rewardIds: giftId ? [giftId] : [] });
    const p = res.outcome.purchase ?? res.state.purchases.find((x) => x.idempotencyKey === key)!;
    const r = p.result!;
    const redeemed = p.pointsRedeemed;
    const discount = p.discountApplied;
    await db
      .prepare(`UPDATE stock_sales SET loyalty_purchase_id = ?, loyalty_status = 'done', loyalty_error = NULL, honey_redeemed = ?, discount_uzs = ?, paid_uzs = total_uzs - ? - ? WHERE id = ?`)
      .bind(p.id, redeemed, discount, redeemed, discount, saleId)
      .run();
    return base({
      loyaltyStatus: 'done', loyaltyError: null, purchaseId: p.id, honeyRedeemed: redeemed, paid: num(sale.total_uzs) - redeemed - discount, cashback: r.cashback,
      clientBalance: r.balanceAfter, warnings: [],
    });
  } catch (e) {
    const known = e instanceof LoyaltyError || e instanceof HttpError || (e as Error)?.name === 'ConcurrencyError';
    if (!known) throw e;
    const msg = toApiError(e).body.error.message;
    await db.prepare(`UPDATE stock_sales SET loyalty_status = 'failed', loyalty_error = ? WHERE id = ? AND loyalty_status <> 'done'`).bind(msg.slice(0, 300), saleId).run();
    return base({ loyaltyStatus: 'failed', loyaltyError: msg, warnings: [`Букет продан, но мёд не начислен: ${msg}. Нажмите «Начислить мёд ещё раз».`] });
  }
}

/** POST /api/stock/sales/:id/loyalty — re-run step 2 (pending / failed); optionally without honey payment. */
export async function retryLoyalty(app: AppContext, caller: Caller, saleId: string, cfg: StockConfig, body: unknown): Promise<StockSaleResultDTO> {
  requireStock(caller, 'sale.post', cfg);
  const { withoutRedeem } = z.object({ withoutRedeem: z.boolean().default(false) }).parse(body ?? {});
  const db = app.repo.db;
  const r = await db.prepare('SELECT client_id, loyalty_status FROM stock_sales WHERE id = ?').bind(saleId).all<Row>();
  const s = r.results[0];
  if (!s) throw new HttpError(404, 'not_found', 'Продажа не найдена');
  if (s.loyalty_status === 'none') throw new HttpError(409, 'conflict', 'Продажа без клиента — мёд не начисляется');
  if (s.loyalty_status !== 'done') {
    const client = await app.repo.findClientById(String(s.client_id));
    if (client) assertNotOwnCard(app, caller, client);
    if (withoutRedeem) await db.prepare(`UPDATE stock_sales SET redeem = 0, redeem_points = NULL, gift_id = NULL WHERE id = ? AND loyalty_status <> 'done'`).bind(saleId).run();
  }
  return completeLoyalty(app, saleId, s.loyalty_status === 'done', actingStaff(caller).id);
}

