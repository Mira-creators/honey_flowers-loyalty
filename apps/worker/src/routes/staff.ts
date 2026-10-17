import type {
  PurchasePreviewDTO,
  PurchaseResultDTO,
  ReverseResultDTO,
  StaffClientLookupDTO,
  UseGiftResultDTO,
} from '@honey/contracts';
import {
  applyPurchase,
  emptyOutcome,
  LoyaltyError,
  maxRedeemable,
  redeem,
  reversePurchase,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
  type PurchaseInput,
  type PurchaseLine,
} from '@honey/core';
import { maskPhone, phoneDigits, type ClientProfile } from '@honey/service';
import { Hono } from 'hono';
import { z } from 'zod';
import { actingStaff, requireRole, STAFF_ROLES, type Vars } from '../auth.js';
import type { AppContext } from '../context.js';
import { giftDTO, levelInfo, previewFromSummary } from '../lib/dto.js';
import { HttpError } from '../lib/errors.js';
import { operationsFor, summaryFor, translateWarning } from '../lib/summary.js';

export const staffRoutes = new Hono<{ Variables: Vars }>();

staffRoutes.use('*', async (c, next) => {
  requireRole(c, STAFF_ROLES);
  await next();
});

const uzs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** rules.maxPurchaseAmount (typo guard) as a 400 with a Russian message, before the engine sees it. */
function checkAmount(rules: LoyaltyRules, amount: number) {
  if (amount > rules.maxPurchaseAmount) {
    throw new HttpError(400, 'validation', `Сумма покупки не может превышать ${rules.maxPurchaseAmount.toLocaleString('ru-RU')} сум`);
  }
}

const previewSchema = z.object({
  clientId: z.string().min(1),
  amount: uzs,
  redeem: z.boolean().default(false),
  giftId: z.string().min(1).nullish(),
  channel: z.enum(['store', 'delivery']).default('store'),
});

const purchaseSchema = previewSchema.extend({
  idempotencyKey: z.string().min(8).max(100),
});

// ------------------------------------------------------------ lookup

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the staff search query: a client id (UUID, as sent when the florist picks
 * one of `matches`), short code ("HF4821", "hf4821"), a scanned QR payload
 * ("HF:HF4821" or "HF:4821"), or phone digits (any formatting, 4+ digits).
 */
export function parseLookup(q: string): { id: string | null; code: string | null; phone: string | null } {
  let s = q.trim();
  if (UUID_RE.test(s)) return { id: s.toLowerCase(), code: null, phone: null };
  if (/^HF:/i.test(s)) s = s.slice(3).trim();
  const compact = s.replace(/[\s-]/g, '');
  if (/^HF\d{4,6}$/i.test(compact)) return { id: null, code: compact.toUpperCase(), phone: null };
  const digits = phoneDigits(s);
  if (/^\d{4,6}$/.test(compact)) return { id: null, code: `HF${compact}`, phone: digits };
  return { id: null, code: null, phone: digits.length >= 4 ? digits : null };
}

staffRoutes.get('/client', async (c) => {
  const app = c.get('app');
  const q = c.req.query('q') ?? '';
  const { id, code, phone } = parseLookup(q);
  if (!id && !code && !phone) throw new HttpError(400, 'validation', 'Введите код карты (HF…) или минимум 4 цифры телефона');
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);

  let exact: ClientProfile | null = id ? await app.repo.findClientById(id) : code ? await app.repo.findClientByCode(code) : null;
  let matches: ClientProfile[] = [];
  if (exact) matches = [exact];
  else if (phone) {
    matches = await app.repo.searchClientsByPhone(phone, 10);
    // A full phone number identifies the client even if a shorter fragment would match several.
    const full = matches.filter((m) => m.phone && phoneDigits(m.phone).endsWith(phone) && phone.length >= 9);
    if (full.length === 1) exact = full[0]!;
    else if (matches.length === 1) exact = matches[0]!;
  }
  const body: StaffClientLookupDTO = {
    client: exact ? await summaryFor(app, rules, exact.id, now) : null,
    matches: matches.map((m) => ({ id: m.id, name: m.name ?? '', phoneMasked: maskPhone(m.phone) })),
  };
  return c.json(body);
});

// ------------------------------------------------------------ purchase

function linesOf(amount: number): PurchaseLine[] {
  // The florist enters one total; it counts as flowers (cashback category on by default).
  return [{ category: 'flowers', amount }];
}

interface PlannedPurchase {
  input: PurchaseInput;
  maxRedeem: number;
}

/** What the purchase command would get as input on this state. */
function planPurchase(
  rules: LoyaltyRules,
  state: ClientState,
  req: z.infer<typeof previewSchema>,
  purchaseId: string,
  idempotencyKey: string,
  staffId: string | null,
  now: Date,
): PlannedPurchase {
  const lines = linesOf(req.amount);
  const giftId = req.giftId ?? null;
  const prior = state.purchases.find((p) => p.idempotencyKey === idempotencyKey);
  const maxRedeem = maxRedeemable(rules, state, lines, giftId, now);
  // On a replay reuse what was redeemed originally, so the engine recognises the same request.
  const redeemPoints = prior ? prior.pointsRedeemed : req.redeem ? maxRedeem : 0;
  return {
    maxRedeem: prior ? prior.pointsRedeemed : maxRedeem,
    input: {
      purchaseId,
      idempotencyKey,
      staffId,
      lines,
      channel: req.channel,
      redeemPoints,
      useRewardId: giftId,
    },
  };
}

async function ensureClient(app: AppContext, clientId: string): Promise<ClientProfile> {
  const client = await app.repo.findClientById(clientId);
  if (!client) throw new HttpError(404, 'not_found', 'Клиент не найден');
  return client;
}

staffRoutes.post('/purchase/preview', async (c) => {
  const app = c.get('app');
  const req = previewSchema.parse(await c.req.json());
  await ensureClient(app, req.clientId);
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  checkAmount(rules, req.amount);
  const { state } = await app.repo.loadClientState(req.clientId);
  const plan = planPurchase(rules, state, req, 'preview', `preview-${crypto.randomUUID()}`, null, now);
  const outcome = applyPurchase(rules, state, plan.input, now);
  const body: PurchasePreviewDTO = previewFromSummary(outcome.purchase!.result!, plan.maxRedeem, outcome.rewardsUnlocked);
  return c.json(body);
});

staffRoutes.post('/purchase', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const req = purchaseSchema.parse(await c.req.json());
  await ensureClient(app, req.clientId);
  checkAmount((await app.repo.getActiveRules(app.now())).rules, req.amount);
  const other = await app.repo.findPurchaseByIdempotencyKey(req.idempotencyKey);
  if (other && other.clientId !== req.clientId) {
    throw new HttpError(409, 'conflict', 'Этот ключ операции уже использован для другого клиента');
  }
  const staff = actingStaff(caller);
  const purchaseId = crypto.randomUUID();
  const res = await app.service.execute<{ maxRedeem: number }>(req.clientId, ({ rules, state, now }) => {
    const plan = planPurchase(rules, state, req, purchaseId, req.idempotencyKey, staff.id, now);
    const prior = state.purchases.find((p) => p.idempotencyKey === req.idempotencyKey);
    if (prior && (prior.amount !== req.amount || (prior.rewardUsedId ?? null) !== (req.giftId ?? null))) {
      throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'same idempotencyKey, different purchase');
    }
    return { outcome: applyPurchase(rules, state, plan.input, now), extra: { maxRedeem: plan.maxRedeem } };
  });
  const p = res.outcome.purchase!;
  const result = p.result!;
  const purchaseRules = p.rulesVersion === res.rules.version ? res.rules : (await app.repo.getRulesVersion(p.rulesVersion)) ?? res.rules;
  const unlocked = res.state.rewards.filter((r) => r.unlockedByPurchase === p.id);
  const levelAfter = purchaseRules.levels.tiers.find((t) => t.id === result.levelAfter);
  const body: PurchaseResultDTO = {
    purchaseId: p.id,
    replayed: res.outcome.replayed,
    preview: previewFromSummary(result, res.extra.maxRedeem, unlocked),
    giftsUnlocked: unlocked.map(giftDTO),
    levelUp: result.levelAfter !== result.levelBefore && levelAfter ? levelInfo(levelAfter) : null,
    newCard: result.cellAdvanced && result.cell >= purchaseRules.honeycomb.cells,
    client: await summaryFor(app, res.rules, req.clientId, res.now, res.state),
    warnings: res.outcome.warnings.map(translateWarning),
  };
  return c.json(body, res.outcome.replayed ? 200 : 201);
});

// ------------------------------------------------------------ reverse

staffRoutes.post('/purchase/:id/reverse', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const { reason } = z
    .object({ reason: z.string().trim().min(3, 'укажите причину (минимум 3 символа)').max(500) })
    .parse(await c.req.json().catch(() => ({})));
  const purchase = await app.repo.findPurchaseById(c.req.param('id'));
  if (!purchase) throw new HttpError(404, 'not_found', 'Покупка не найдена');
  if (purchase.status === 'reversed') throw new HttpError(409, 'already_reversed', 'Эта покупка уже отменена');
  const staff = actingStaff(caller);
  const res = await app.service.execute(purchase.clientId, ({ rules, state, now }) => {
    const current = state.purchases.find((p) => p.id === purchase.id);
    if (current?.status === 'reversed') throw new HttpError(409, 'already_reversed', 'Эта покупка уже отменена');
    return reversePurchase(rules, state, { purchaseId: purchase.id, reason, staffId: staff.id }, now);
  });
  const body: ReverseResultDTO = {
    client: await summaryFor(app, res.rules, purchase.clientId, res.now, res.state),
    warnings: res.outcome.warnings.map(translateWarning),
  };
  return c.json(body);
});

// ------------------------------------------------------------ gift hand-out

staffRoutes.post('/gift/:id/use', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const giftId = c.req.param('id');
  const reward = await app.repo.findRewardById(giftId);
  if (!reward) throw new HttpError(404, 'not_found', 'Подарок не найден');
  const staff = actingStaff(caller);
  const key = `gift-use:${giftId}`;
  const res = await app.service.execute(reward.clientId, ({ rules, state, now }): Outcome => {
    const r = state.rewards.find((x) => x.id === giftId);
    // Repeated tap on "выдать" → idempotent success.
    if (r?.status === 'used' && r.usedIdempotencyKey === key) return { ...emptyOutcome(), replayed: true };
    return redeem(rules, state, { idempotencyKey: key, staffId: staff.id, rewardId: giftId, reason: 'подарок выдан' }, now);
  });
  const body: UseGiftResultDTO = { client: await summaryFor(app, res.rules, reward.clientId, res.now, res.state) };
  return c.json(body);
});

// ------------------------------------------------------------ recent

staffRoutes.get('/recent', async (c) => {
  return c.json(await operationsFor(c.get('app'), 20));
});

