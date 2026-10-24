import { normalizePhone } from '@honey/service';
import type { Env } from '../env.js';

/**
 * Who may use the test features of TEST_MODE (role switching, test clock, nightly job button,
 * demo seed / clear, every /api/test/* route, X-Test-User browser login).
 *
 *   TEST_MODE != "1"                       → 'off'      nobody (production)
 *   TEST_MODE = "1", TEST_USERS set        → 'listed'   only the listed Telegram ids / phones;
 *                                                       everyone else behaves exactly as in production
 *   TEST_MODE = "1", TEST_USERS empty      → 'everyone' on the dev polygon / locally (old behaviour),
 *                                            'off'      on the CLIENT worker (fail closed: a forgotten
 *                                                       TEST_USERS never opens the owner screens to strangers)
 *
 * TEST_USERS = comma-separated Telegram ids ("123456789") and/or phones ("+998901234567").
 * Phones count only when Telegram vouched for them (the caller's own client or staff row, filled
 * from a shared contact); a browser tester (X-Test-User) can be listed by id only.
 */
export type TestAccessMode = 'off' | 'everyone' | 'listed';

export interface TestPolicy {
  mode: TestAccessMode;
  ids: ReadonlySet<number>;
  phones: ReadonlySet<string>;
}

const cache = new Map<string, TestPolicy>();

/** True for the client's deployment (branch main → worker honeyflowers, see scripts/select-env.mjs). */
export function isClientDeployment(env: Env): boolean {
  if ((env.DEPLOY_ENV ?? '').trim().toLowerCase() === 'client') return true;
  return /\(main\)\s*$/.test(env.ENV_NAME ?? '');
}

export function parseTestUsers(raw: string | undefined): { ids: Set<number>; phones: Set<string>; invalid: string[] } {
  const ids = new Set<number>();
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const token of (raw ?? '').split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean)) {
    const idm = /^(?:id:|tg:)?\s*(\d{1,16})$/i.exec(token);
    if (token.startsWith('+')) {
      const p = normalizePhone(token);
      if (p) phones.add(p);
      else invalid.push(token);
    } else if (idm && Number.isSafeInteger(Number(idm[1])) && Number(idm[1]) > 0) {
      ids.add(Number(idm[1]));
    } else invalid.push(token);
  }
  return { ids, phones, invalid };
}

export function testPolicy(env: Env): TestPolicy {
  const testMode = env.TEST_MODE === '1' || env.TEST_MODE === 'true';
  const key = `${testMode}|${env.TEST_USERS ?? ''}|${env.DEPLOY_ENV ?? ''}|${env.ENV_NAME ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let policy: TestPolicy;
  const raw = (env.TEST_USERS ?? '').trim();
  if (!testMode) policy = { mode: 'off', ids: new Set(), phones: new Set() };
  else if (raw) {
    // Set but unparsable (typo) → 'listed' with nobody in it: fail closed, never 'everyone'.
    const { ids, phones } = parseTestUsers(raw);
    policy = { mode: 'listed', ids, phones };
  } else policy = { mode: isClientDeployment(env) ? 'off' : 'everyone', ids: new Set(), phones: new Set() };
  cache.set(key, policy);
  return policy;
}

/** Is this Telegram id a tester? Phones are checked only through `phonesOf` (lazy: one D1 query, only when needed). */
export async function isTester(
  policy: TestPolicy,
  telegramId: number,
  phonesOf: () => Promise<Array<string | null | undefined>>,
): Promise<boolean> {
  if (policy.mode === 'off') return false;
  if (policy.mode === 'everyone') return true;
  if (policy.ids.has(telegramId)) return true;
  if (!policy.phones.size || telegramId <= 0) return false;
  return (await phonesOf()).some((p) => !!p && policy.phones.has(p));
}

/** Phones Telegram vouched for: the caller's client row and staff row. One query. */
export async function verifiedPhones(db: D1Database, telegramId: number): Promise<Array<string | null>> {
  const r = await db
    .prepare('SELECT (SELECT phone FROM clients WHERE telegram_id = ?1) AS client_phone, (SELECT phone FROM staff WHERE telegram_id = ?1) AS staff_phone')
    .bind(telegramId)
    .first<{ client_phone: string | null; staff_phone: string | null }>();
  return [r?.client_phone ?? null, r?.staff_phone ?? null];
}
