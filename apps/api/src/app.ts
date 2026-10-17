import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { LoyaltyError, type LoyaltyErrorCode } from '@honey/core';
import { ZodError } from 'zod';
import { HttpError, type AuthContext } from './auth.js';
import type { Repository } from './repo/types.js';
import { clientRoutes } from './routes/client.js';
import { staffRoutes } from './routes/staff.js';
import { LoyaltyService, NotFoundError } from './services/loyaltyService.js';
import { MemoryNotifier, type Notifier } from './services/notifier.js';

export interface AppDeps {
  repo: Repository;
  botToken: string;
  notifier?: Notifier;
  /** Injected clock; defaults to real time. Tests pass a fixed date. */
  clock?: () => Date;
  initDataMaxAgeSeconds?: number;
  logger?: FastifyServerOptions['logger'];
}

const LOYALTY_STATUS: Record<LoyaltyErrorCode, number> = {
  INVALID_INPUT: 400,
  INSUFFICIENT_BALANCE: 422,
  REDEEM_CAP_EXCEEDED: 422,
  DISCOUNT_WITH_POINTS_NOT_ALLOWED: 422,
  REWARD_NOT_FOUND: 404,
  REWARD_NOT_AVAILABLE: 409,
  PURCHASE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
};

/** Build the Fastify app (no listen) — used by server.ts and tests. */
export function buildApp(deps: AppDeps): { app: FastifyInstance; service: LoyaltyService } {
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false });
  const notifier = deps.notifier ?? new MemoryNotifier();
  const service = new LoyaltyService(deps.repo, notifier, clock);
  const auth: AuthContext = { botToken: deps.botToken, maxAgeSeconds: deps.initDataMaxAgeSeconds ?? 86_400, clock };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof LoyaltyError) return reply.code(LOYALTY_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', message: 'invalid request', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: 'internal error' });
  });

  app.get('/health', async () => ({ ok: true }));
  clientRoutes(app, { repo: deps.repo, service, auth });
  staffRoutes(app, { repo: deps.repo, service, auth });
  return { app, service };
}
