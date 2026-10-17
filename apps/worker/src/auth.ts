import type { Role } from '@honey/contracts';
import { InitDataError, timingSafeEqualStr, validateInitData, type StaffMember, type StaffRole } from '@honey/service';
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from './context.js';
import { HttpError } from './lib/errors.js';

/**
 * Who is calling. Authentication:
 *   Authorization: tma <Telegram.WebApp.initData>   (always; signature checked with BOT_TOKEN)
 *   X-Test-User: <id> + X-Test-Key: <TEST_KEY>       (TEST_MODE only, browser testing outside Telegram)
 *
 * Browser testers are never real Telegram users: the header is accepted only
 * with the TEST_KEY secret and only for ids >= TEST_USER_MIN (real Telegram
 * ids are smaller), so nobody can impersonate a registered client or staff
 * member with a plain HTTP header.
 *
 * Effective role:
 *   TEST_MODE: role chosen via POST /api/test/role (test_roles), else active staff role, else 'client';
 *   otherwise: active staff role, else 'client'.
 */
export interface Caller {
  telegramId: number;
  firstName: string;
  username: string | null;
  languageCode: string | null;
  via: 'initData' | 'testHeader';
  role: Role;
  /** Active staff row (independent of a TEST_MODE role switch). */
  staff: StaffMember | null;
}

export type Vars = {
  app: AppContext;
  caller: Caller;
  /** Re-create the AppContext (after the test clock moved). */
  rebuild: () => Promise<AppContext>;
};

/** Smallest id accepted from X-Test-User (the Mini App generates 900 000 000 + random). */
export const TEST_USER_MIN = 900_000_000;

function decodeHeader(v: string | undefined): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function identify(app: AppContext, headers: Headers): Promise<Caller> {
  const auth = headers.get('authorization');
  let base: Omit<Caller, 'role' | 'staff'>;
  if (auth && auth.startsWith('tma ')) {
    if (!app.env.BOT_TOKEN) throw new HttpError(401, 'unauthorized', 'BOT_TOKEN не настроен на сервере');
    try {
      const v = await validateInitData(auth.slice(4).trim(), app.env.BOT_TOKEN, {
        // initData freshness is checked against REAL time, not the test clock.
        now: new Date(),
        maxAgeSeconds: Number(app.env.INIT_DATA_MAX_AGE ?? 86_400),
      });
      base = {
        telegramId: v.user.id,
        firstName: v.user.first_name ?? '',
        username: v.user.username ?? null,
        languageCode: v.user.language_code ?? null,
        via: 'initData',
      };
    } catch (e) {
      if (e instanceof InitDataError) {
        // Telegram refreshes initData only when the Mini App is reopened: tell the app so.
        if (e.code === 'EXPIRED') throw new HttpError(401, 'expired', 'Сессия устарела: закройте и откройте приложение заново');
        throw new HttpError(401, 'unauthorized', `Неверная подпись Telegram (${e.code})`);
      }
      throw e;
    }
  } else if (app.testMode && headers.get('x-test-user')) {
    const key = headers.get('x-test-key') ?? '';
    const secret = app.env.TEST_KEY ?? '';
    if (!secret || !timingSafeEqualStr(key, secret)) {
      throw new HttpError(401, 'unauthorized', 'Тестовый вход: неверный или не задан ключ (X-Test-Key / TEST_KEY)');
    }
    const id = Number(headers.get('x-test-user'));
    if (!Number.isSafeInteger(id) || id < TEST_USER_MIN) {
      throw new HttpError(401, 'unauthorized', `X-Test-User должен быть числом не меньше ${TEST_USER_MIN}`);
    }
    base = {
      telegramId: id,
      firstName: decodeHeader(headers.get('x-test-name') ?? undefined) ?? `Тестер ${id}`,
      username: null,
      languageCode: null,
      via: 'testHeader',
    };
  } else {
    throw new HttpError(401, 'unauthorized', 'Нет авторизации: откройте приложение из Telegram');
  }

  await app.repo.touchTgUser(
    { telegramId: base.telegramId, firstName: base.firstName || null, username: base.username, language: base.languageCode?.startsWith('uz') ? 'uz' : 'ru' },
    app.now(),
  );
  const staffRow = await app.repo.findStaffByTelegramId(base.telegramId);
  const staff = staffRow?.active ? staffRow : null;
  let role: Role = staff?.role ?? 'client';
  if (app.testMode) {
    const override = await app.repo.getTestRole(base.telegramId);
    if (override) role = override;
  }
  return { ...base, role, staff };
}

export const authMiddleware: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  c.set('caller', await identify(c.get('app'), c.req.raw.headers));
  await next();
};

export function requireRole(c: { get(key: 'caller'): Caller }, roles: readonly Role[]): Caller {
  const caller = c.get('caller');
  if (!roles.includes(caller.role)) {
    throw new HttpError(403, 'forbidden', caller.role === 'client' ? 'Доступно только сотрудникам' : 'Недостаточно прав для этого действия');
  }
  return caller;
}

export const STAFF_ROLES: readonly StaffRole[] = ['florist', 'manager', 'owner'];

/**
 * The staff member recorded on operations. A real staff row when the caller acts
 * in their own staff role; in TEST_MODE a switched-role tester acts as "tg:<id>".
 */
export function actingStaff(caller: Caller): StaffMember {
  if (caller.staff && caller.staff.role === caller.role) return caller.staff;
  return {
    id: `tg:${caller.telegramId}`,
    telegramId: caller.telegramId,
    name: caller.firstName || `Тестер ${caller.telegramId}`,
    role: caller.role === 'client' ? 'florist' : caller.role,
    active: true,
  };
}
