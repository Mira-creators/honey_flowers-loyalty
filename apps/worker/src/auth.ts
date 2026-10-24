import type { Role } from '@honey/contracts';
import { InitDataError, timingSafeEqualStr, validateInitData, type StaffMember, type StaffRole } from '@honey/service';
import type { MiddlewareHandler } from 'hono';
import { effectiveRole, EXPIRED_SESSION_MESSAGE, lookupOwner, sessionKey, verifySession } from './console/webAuth.js';
import type { AppContext } from './context.js';
import { HttpError } from './lib/errors.js';
import { isTester, testPolicy, verifiedPhones } from './lib/testAccess.js';

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
 *   tester (TEST_MODE + TEST_USERS, lib/testAccess.ts): role chosen via POST /api/test/role
 *   (test_roles), else active staff role, else 'client';
 *   everyone else: active staff role, else 'client' (a stored test role is ignored).
 */
export interface Caller {
  telegramId: number;
  firstName: string;
  username: string | null;
  languageCode: string | null;
  /** 'webSession' = owner console in a browser (Authorization: Bearer, see console/webAuth.ts). */
  via: 'initData' | 'testHeader' | 'webSession';
  role: Role;
  /** Active staff row (independent of a TEST_MODE role switch). */
  staff: StaffMember | null;
  /** Web sessions only: when the session expires (ms since epoch). */
  sessionExpiresAt?: number;
  /**
   * May this caller use the test features (role switch, clock, /api/test/*, «🧪 Тест»)?
   * TEST_MODE + TEST_USERS policy (lib/testAccess.ts); false for everyone in production.
   */
  tester: boolean;
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

/**
 * Owner console session (Authorization: Bearer). Signature + expiry are checked without the
 * database; then ONE query returns the session version, staff row and TEST_MODE role.
 * No tg_users touch: the console is not the Telegram app.
 */
async function identifyWebSession(app: AppContext, token: string): Promise<Caller> {
  const v = await verifySession(await sessionKey(app.env), token, Date.now());
  if (!v.ok) {
    if (v.reason === 'expired') throw new HttpError(401, 'expired', EXPIRED_SESSION_MESSAGE);
    throw new HttpError(401, 'unauthorized', 'Сессия кабинета недействительна: запросите новую ссылку в приложении');
  }
  const { tid, ver, exp } = v.payload;
  const o = await lookupOwner(app.repo.db, tid);
  if (o.version !== ver) throw new HttpError(401, 'expired', 'Вы вышли из кабинета на этом или другом компьютере. Ссылка устарела, запросите новую в приложении');
  const tester = await isTester(testPolicy(app.env), tid, async () => [o.staffPhone, o.clientPhone]);
  const role = effectiveRole(o, tester) as Role;
  const staff: StaffMember | null = o.staffId
    ? { id: o.staffId, telegramId: tid, name: o.staffName ?? '', role: o.staffRole as StaffRole, active: true, phone: o.staffPhone }
    : null;
  return {
    telegramId: tid,
    firstName: o.staffName || o.firstName || 'Владелец',
    username: null,
    languageCode: null,
    via: 'webSession',
    role,
    staff,
    sessionExpiresAt: exp,
    tester,
  };
}

export async function identify(app: AppContext, headers: Headers): Promise<Caller> {
  const auth = headers.get('authorization');
  let base: Omit<Caller, 'role' | 'staff' | 'tester'>;
  const policy = testPolicy(app.env);
  if (auth && /^bearer\s/i.test(auth)) {
    return identifyWebSession(app, auth.slice(7).trim());
  } else if (auth && auth.startsWith('tma ')) {
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
  } else if (policy.mode !== 'off' && headers.get('x-test-user')) {
    const key = headers.get('x-test-key') ?? '';
    const secret = app.env.TEST_KEY ?? '';
    if (!secret || !timingSafeEqualStr(key, secret)) {
      throw new HttpError(401, 'unauthorized', 'Тестовый вход: неверный или не задан ключ (X-Test-Key / TEST_KEY)');
    }
    const id = Number(headers.get('x-test-user'));
    if (!Number.isSafeInteger(id) || id < TEST_USER_MIN) {
      throw new HttpError(401, 'unauthorized', `X-Test-User должен быть числом не меньше ${TEST_USER_MIN}`);
    }
    // With TEST_USERS set, a browser tester must be listed by id (an unverified phone does not count).
    if (policy.mode === 'listed' && !policy.ids.has(id)) {
      throw new HttpError(401, 'unauthorized', 'Тестовый вход: этого тестера нет в списке TEST_USERS');
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
  const tester =
    base.via === 'testHeader' ||
    (await isTester(policy, base.telegramId, async () => [staffRow?.phone ?? null, (await verifiedPhones(app.repo.db, base.telegramId))[0]]));
  if (tester) {
    const override = await app.repo.getTestRole(base.telegramId);
    if (override) role = override;
  }
  return { ...base, role, staff, tester };
}

export const authMiddleware: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const caller = await identify(c.get('app'), c.req.raw.headers);
  // A browser session is for the owner console only: never for the cash desk or client API.
  if (caller.via === 'webSession' && !/^\/api\/(owner|web)(\/|$)/.test(new URL(c.req.url).pathname)) {
    throw new HttpError(403, 'forbidden', 'В кабинете на компьютере доступна только аналитика владельца');
  }
  c.set('caller', caller);
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
