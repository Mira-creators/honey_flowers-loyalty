import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validation of Telegram Mini App `initData`
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 *
 *   secret_key       = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = all received fields except `hash`, sorted by key,
 *                       as "key=value" joined with "\n" (values URL-decoded)
 *   valid            ⇔ hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 *
 * Plus a freshness check of `auth_date` so a leaked initData string cannot be
 * replayed forever.
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  allows_write_to_pm?: boolean;
}

export interface ValidatedInitData {
  user: TelegramUser;
  authDate: Date;
  queryId: string | null;
  startParam: string | null;
  /** All raw fields (decoded), for anything not mapped above. */
  fields: Record<string, string>;
}

export type InitDataErrorCode = 'MISSING_HASH' | 'BAD_HASH' | 'EXPIRED' | 'FUTURE_AUTH_DATE' | 'MALFORMED';

export class InitDataError extends Error {
  constructor(
    public readonly code: InitDataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InitDataError';
  }
}

export interface ValidateOptions {
  /** Current time (injected for tests). */
  now: Date;
  /** Max age of auth_date in seconds. Default 24 h. */
  maxAgeSeconds?: number;
  /** Allowed clock skew for auth_date in the future, seconds. Default 60. */
  clockSkewSeconds?: number;
}

/** secret_key = HMAC_SHA256(key="WebAppData", data=bot_token). */
export function webAppSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Compute the `hash` for a set of fields (used by tests and dev tools). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  return createHmac('sha256', webAppSecretKey(botToken)).update(dataCheckString(params)).digest('hex');
}

/** Build a complete signed initData query string (tests / local dev). */
export function buildInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  params.set('hash', signInitData(fields, botToken));
  return params.toString();
}

export function validateInitData(initData: string, botToken: string, opts: ValidateOptions): ValidatedInitData {
  if (!botToken) throw new Error('BOT_TOKEN is not configured');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('MISSING_HASH', 'initData has no hash');
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new InitDataError('BAD_HASH', 'initData hash is malformed');

  const expected = createHmac('sha256', webAppSecretKey(botToken)).update(dataCheckString(params)).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InitDataError('BAD_HASH', 'initData signature is invalid');
  }

  // Signature is valid: the fields come from Telegram. Now check freshness.
  const authDateSec = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSec) || authDateSec <= 0) {
    throw new InitDataError('MALFORMED', 'auth_date is missing or invalid');
  }
  const nowSec = Math.floor(opts.now.getTime() / 1000);
  const maxAge = opts.maxAgeSeconds ?? 86_400;
  const skew = opts.clockSkewSeconds ?? 60;
  if (authDateSec > nowSec + skew) throw new InitDataError('FUTURE_AUTH_DATE', 'auth_date is in the future');
  if (nowSec - authDateSec > maxAge) throw new InitDataError('EXPIRED', 'initData is too old, reopen the app');

  const rawUser = params.get('user');
  if (!rawUser) throw new InitDataError('MALFORMED', 'initData has no user');
  let user: TelegramUser;
  try {
    user = JSON.parse(rawUser) as TelegramUser;
  } catch {
    throw new InitDataError('MALFORMED', 'user is not valid JSON');
  }
  if (typeof user?.id !== 'number' || !Number.isSafeInteger(user.id)) {
    throw new InitDataError('MALFORMED', 'user.id is missing');
  }

  return {
    user,
    authDate: new Date(authDateSec * 1000),
    queryId: params.get('query_id'),
    startParam: params.get('start_param'),
    fields: Object.fromEntries(params.entries()),
  };
}
