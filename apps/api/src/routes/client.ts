import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, readInitData, requireClient, type AuthContext } from '../auth.js';
import type { Repository } from '../repo/types.js';
import type { LoyaltyService } from '../services/loyaltyService.js';

const SUPPORTED_LANGUAGES = ['ru', 'uz', 'en'];

export function clientRoutes(app: FastifyInstance, deps: { repo: Repository; service: LoyaltyService; auth: AuthContext }) {
  /**
   * Log in / register from the Mini App. Validates initData, creates the
   * client on first visit (welcome bonus), returns the profile and whether
   * this Telegram user is also staff.
   */
  app.post('/auth/telegram', async (req) => {
    const body = z.object({ initData: z.string().min(1) }).partial().parse(req.body ?? {});
    const tg = authenticate(body.initData ?? readInitData(req), deps.auth);
    const name = [tg.user.first_name, tg.user.last_name].filter(Boolean).join(' ') || null;
    const lang = tg.user.language_code?.slice(0, 2);
    const { client, created } = await deps.service.registerOrGet({
      telegramId: tg.user.id,
      name,
      language: lang && SUPPORTED_LANGUAGES.includes(lang) ? lang : 'ru',
    });
    const staff = await deps.repo.findStaffByTelegramId(tg.user.id);
    return {
      created,
      client: { id: client.id, name: client.name, language: client.language, hasPhone: client.phone !== null },
      staff: staff?.active ? { id: staff.id, role: staff.role, name: staff.name } : null,
    };
  });

  /** Client dashboard: balance, level + progress, honeycomb, gifts, expiry. */
  app.get('/me', async (req) => {
    const client = await requireClient(req, deps.repo, deps.auth);
    return deps.service.getDashboard(client);
  });
}
