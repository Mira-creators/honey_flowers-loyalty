import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientProfile, Repository, StaffMember, StaffRole } from './repo/types.js';
import { InitDataError, validateInitData, type ValidatedInitData } from './telegram/initData.js';

/**
 * Authentication: every request carries the Mini App's raw initData:
 *
 *   Authorization: tma <window.Telegram.WebApp.initData>
 *
 * It is validated on each request (stateless, no sessions to store).
 * POST /auth/telegram may instead send `{ initData }` in the body.
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthContext {
  botToken: string;
  maxAgeSeconds: number;
  clock: () => Date;
}

export function readInitData(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('tma ')) return h.slice(4).trim();
  return null;
}

export function authenticate(raw: string | null, ctx: AuthContext): ValidatedInitData {
  if (!raw) throw new HttpError(401, 'UNAUTHORIZED', 'missing "Authorization: tma <initData>" header');
  try {
    return validateInitData(raw, ctx.botToken, { now: ctx.clock(), maxAgeSeconds: ctx.maxAgeSeconds });
  } catch (e) {
    if (e instanceof InitDataError) throw new HttpError(401, e.code, e.message);
    throw e;
  }
}

export async function requireClient(req: FastifyRequest, repo: Repository, ctx: AuthContext): Promise<ClientProfile> {
  const tg = authenticate(readInitData(req), ctx);
  const client = await repo.findClientByTelegramId(tg.user.id);
  if (!client) throw new HttpError(404, 'NOT_REGISTERED', 'call POST /auth/telegram first');
  return client;
}

export async function requireStaff(
  req: FastifyRequest,
  repo: Repository,
  ctx: AuthContext,
  roles: readonly StaffRole[] = ['florist', 'manager', 'owner'],
): Promise<StaffMember> {
  const tg = authenticate(readInitData(req), ctx);
  const staff = await repo.findStaffByTelegramId(tg.user.id);
  if (!staff || !staff.active) throw new HttpError(403, 'FORBIDDEN', 'staff access only');
  if (!roles.includes(staff.role)) throw new HttpError(403, 'FORBIDDEN', `requires role: ${roles.join(' | ')}`);
  return staff;
}

export type Reply = FastifyReply;
