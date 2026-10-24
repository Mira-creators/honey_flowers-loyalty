import type { OwnerGrantResultDTO } from '@honey/contracts';
import { grantGift, grantPoints, grantRewardId, LoyaltyError } from '@honey/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { actingStaff, requireRole, type Vars } from '../auth.js';
import { giftDTO } from '../lib/dto.js';
import { HttpError } from '../lib/errors.js';
import { GIFT_CODE_RE, rewardFromCode, ruleGiftCodes } from '../lib/gifts.js';
import { summaryFor } from '../lib/summary.js';
import { assertNotOwnCard } from './staff.js';

/**
 * POST /api/owner/clients/:id/grant — the owner gives a client a gift or bonus мёд
 * without a purchase, with a reason ("извинение за задержку", "день рождения").
 *
 *   { kind: 'gift', giftId: 'card' | 'delivery' | 'disc10' | …, reason }   → grantGift (core)
 *   { kind: 'honey', points, reason }                                      → grantPoints = manualAdjust + event (core)
 *
 * Idempotent like purchases: `Idempotency-Key` header or `idempotencyKey` in the body;
 * the key is scoped to the client, a replay answers 200 with replayed=true.
 * Written through LoyaltyService (optimistic concurrency), so the client gets the
 * normal Telegram message and the operations journal shows the grant with its reason.
 */
export const ownerGrantRoutes = new Hono<{ Variables: Vars }>();

ownerGrantRoutes.use('*', async (c, next) => {
  requireRole(c, ['owner']);
  await next();
});

const reason = z.string().trim().min(3, 'укажите причину (минимум 3 символа)').max(200);
const key = z.string().trim().min(8).max(100).optional();

const grantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gift'), giftId: z.string().regex(GIFT_CODE_RE, 'неизвестный подарок'), reason, idempotencyKey: key }),
  z.object({ kind: z.literal('honey'), points: z.number().int().positive().max(10_000_000), reason, idempotencyKey: key }),
]);

export const SELF_GRANT_MSG = 'Нельзя начислять подарки на свою карту — попросите другого владельца';

ownerGrantRoutes.post('/clients/:id/grant', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const body = grantSchema.parse(await c.req.json());
  const idem = c.req.header('idempotency-key')?.trim() || body.idempotencyKey;
  if (!idem || idem.length < 8 || idem.length > 100) {
    throw new HttpError(400, 'validation', 'Нужен ключ операции: заголовок Idempotency-Key или idempotencyKey (8–100 символов)');
  }
  const client = await app.repo.findClientById(c.req.param('id'));
  if (!client) throw new HttpError(404, 'not_found', 'Клиент не найден');
  assertNotOwnCard(app, caller, client, SELF_GRANT_MSG);

  const { rules: current } = await app.repo.getActiveRules(app.now());
  if (body.kind === 'gift' && !ruleGiftCodes(current).includes(body.giftId)) {
    throw new HttpError(400, 'validation', 'Такого подарка нет в правилах программы');
  }
  const staff = actingStaff(caller);
  // Keys are global in storage (ledger idempotency_key, reward id): scope them to the client.
  const coreKey = `grant:${client.id}:${idem}`;
  const giftId = grantRewardId(coreKey);

  const res = await app.service.execute(client.id, ({ rules, state, now }) => {
    if (body.kind === 'gift') {
      if (state.ledger.some((e) => e.idempotencyKey === coreKey)) {
        throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'this key was already used for a мёд grant');
      }
      const def = rewardFromCode(1, body.giftId);
      return grantGift(rules, state, { idempotencyKey: coreKey, staffId: staff.id, gift: { type: def.type, value: def.value ?? null, title: def.title }, reason: body.reason }, now);
    }
    if (state.rewards.some((r) => r.id === giftId)) {
      throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'this key was already used for a gift grant');
    }
    return grantPoints(rules, state, { idempotencyKey: coreKey, staffId: staff.id, points: body.points, reason: body.reason }, now);
  }, { keys: [coreKey], rewardIds: [giftId] });

  const gift = body.kind === 'gift' ? res.state.rewards.find((r) => r.id === giftId) ?? null : null;
  const out: OwnerGrantResultDTO = {
    replayed: res.outcome.replayed,
    gift: gift ? giftDTO(gift) : null,
    points: body.kind === 'honey' ? body.points : 0,
    client: await summaryFor(app, res.rules, client.id, res.now, res.state),
  };
  return c.json(out, res.outcome.replayed ? 200 : 201);
});
