/**
 * Validation of Telegram Mini App `initData`
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 *
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = all received fields except `hash`, sorted by key,
 *                       as "key=value" joined with "\n" (values URL-decoded)
 *   valid             ⇔ hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 *
 * Plus a freshness check of `auth_date` so a leaked initData string cannot be
 * replayed forever.
 *
 * Uses Web Crypto (`crypto.subtle`) only, so the same code runs on Node 20+
 * and on Cloudflare Workers. All functions that touch crypto are async.
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

const encoder = new TextEncoder();

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Constant-time comparison of two strings of equal length. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** secret_key = HMAC_SHA256(key="WebAppData", data=bot_token). */
export async function webAppSecretKey(botToken: string): Promise<Uint8Array> {
  return hmacSha256(encoder.encode('WebAppData'), botToken);
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Compute the `hash` for a set of fields (used by tests and dev tools). */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  return toHex(await hmacSha256(await webAppSecretKey(botToken), dataCheckString(params)));
}

/** Build a complete signed initData query string (tests / local dev). */
export async function buildInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  params.set('hash', await signInitData(fields, botToken));
  return params.toString();
}

export async function validateInitData(initData: string, botToken: string, opts: ValidateOptions): Promise<ValidatedInitData> {
  if (!botToken) throw new Error('BOT_TOKEN is not configured');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('MISSING_HASH', 'initData has no hash');
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new InitDataError('BAD_HASH', 'initData hash is malformed');

  const expected = toHex(await hmacSha256(await webAppSecretKey(botToken), dataCheckString(params)));
  if (!timingSafeEqualStr(hash.toLowerCase(), expected)) {
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
