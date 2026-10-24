import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';

/**
 * Browser login for the owner console (no Telegram in the browser).
 *
 *  1. The owner taps «Открыть кабинет на компьютере» in the Mini App → POST /api/owner/web-link
 *     creates a random 256-bit one-time token. Only its SHA-256 is stored (web_link_tokens),
 *     valid for 10 minutes, single use. The token travels in the URL fragment
 *     (console.html#t=…), so it never reaches server logs or Referer headers.
 *  2. console.html exchanges it (POST /api/web/session): the row is consumed atomically and a
 *     session token is returned: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 *  3. Every console request sends `Authorization: Bearer <session>`. The signature and expiry
 *     are checked here; the payload's version must equal web_session_versions.version of that
 *     owner (logout bumps it → all sessions revoked) and the person must still be an owner.
 *
 * Real time is used everywhere (never the TEST_MODE clock offset).
 */

export const WEB_LINK_TTL_MS = 10 * 60_000;
export const WEB_SESSION_TTL_MS = 12 * 3600_000;
export const EXPIRED_LINK_MESSAGE = 'Ссылка устарела, запросите новую в приложении';
export const EXPIRED_SESSION_MESSAGE = 'Сессия кабинета закончилась. Ссылка устарела, запросите новую в приложении';

export interface WebSessionPayload {
  /** Telegram id of the owner. */
  tid: number;
  /** web_session_versions.version at login. */
  ver: number;
  /** Issued at / expires at, ms since epoch. */
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Random one-time token (43 chars of base64url = 256 bits). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

export async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC key for sessions: WEB_SESSION_SECRET if set, otherwise derived from an existing secret
 * (BOT_TOKEN → SETUP_KEY → WEBHOOK_SECRET → TEST_KEY) with a fixed label, so no new secret is
 * strictly required. Rotating that secret logs every browser out.
 */
export function sessionKey(env: Env): Promise<CryptoKey> {
  const explicit = env.WEB_SESSION_SECRET?.trim();
  const base = explicit || env.BOT_TOKEN || env.SETUP_KEY || env.WEBHOOK_SECRET || env.TEST_KEY;
  if (!base) throw new HttpError(503, 'internal', 'Кабинет не настроен: задайте секрет WEB_SESSION_SECRET (или BOT_TOKEN)');
  const cacheKey = `${explicit ? 'x' : 'd'}:${base}`;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      let raw: Uint8Array = enc.encode(base);
      if (!explicit) {
        const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        raw = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('honey-flowers/web-session/v1')));
      }
      return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })();
    keyCache.set(cacheKey, p);
  }
  return p;
}

export async function signSession(key: CryptoKey, payload: WebSessionPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export type VerifyResult = { ok: true; payload: WebSessionPayload } | { ok: false; reason: 'invalid' | 'expired' };

/** Constant-time HMAC check (crypto.subtle.verify), then expiry. */
export async function verifySession(key: CryptoKey, token: string, nowMs: number): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 1000) return { ok: false, reason: 'invalid' };
  let sig: Uint8Array;
  try {
    sig = fromB64url(parts[1]);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!(await crypto.subtle.verify('HMAC', key, sig, enc.encode(parts[0])))) return { ok: false, reason: 'invalid' };
  let p: WebSessionPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as WebSessionPayload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!Number.isSafeInteger(p.tid) || p.tid <= 0 || !Number.isSafeInteger(p.ver) || !Number.isFinite(p.exp)) return { ok: false, reason: 'invalid' };
  if (p.exp <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}

// ------------------------------------------------------------------ storage

export interface OwnerLookup {
  version: number;
  staffId: string | null;
  staffName: string | null;
  staffRole: string | null;
  staffPhone: string | null;
  testRole: string | null;
  firstName: string | null;
  /** Phone of the owner's own client card (for TEST_USERS phone matching). */
  clientPhone: string | null;
}

/** Everything a web-session request needs about the owner, in ONE query. */
export async function lookupOwner(db: D1Database, telegramId: number): Promise<OwnerLookup> {
  const r = await db
    .prepare(
      `SELECT
         (SELECT version FROM web_session_versions WHERE telegram_id = ?1) AS version,
         s.id AS staff_id, s.name AS staff_name, s.role AS staff_role, s.phone AS staff_phone,
         (SELECT role FROM test_roles WHERE telegram_id = ?1) AS test_role,
         (SELECT first_name FROM tg_users WHERE telegram_id = ?1) AS first_name,
         (SELECT phone FROM clients WHERE telegram_id = ?1) AS client_phone
       FROM (SELECT 1) LEFT JOIN staff s ON s.telegram_id = ?1 AND s.active = 1`,
    )
    .bind(telegramId)
    .first<Record<string, unknown>>();
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    version: r?.version === null || r?.version === undefined ? 1 : Number(r.version),
    staffId: str(r?.staff_id),
    staffName: str(r?.staff_name),
    staffRole: str(r?.staff_role),
    staffPhone: str(r?.staff_phone),
    testRole: str(r?.test_role),
    firstName: str(r?.first_name),
    clientPhone: str(r?.client_phone),
  };
}

/** Effective role, same rule as auth.ts identify(): a tester's role switch wins, else the active staff role. */
export function effectiveRole(o: OwnerLookup, tester: boolean): string {
  if (tester && o.testRole) return o.testRole;
  return o.staffRole ?? 'client';
}

/** Create a one-time link token (and drop expired ones). Returns the raw token. */
export async function createLinkToken(db: D1Database, telegramId: number, nowMs: number): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const expiresAt = new Date(nowMs + WEB_LINK_TTL_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  await db.batch([
    db.prepare('DELETE FROM web_link_tokens WHERE expires_at < ?').bind(new Date(nowMs - 86_400_000).toISOString()),
    db
      .prepare('INSERT INTO web_link_tokens (token_hash, telegram_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), telegramId, nowIso, expiresAt),
  ]);
  return { token, expiresAt };
}

/**
 * Consume a link token: succeeds once, within its lifetime. One UPDATE … RETURNING, so two
 * tabs opening the same link at the same moment cannot both get a session.
 */
export async function consumeLinkToken(db: D1Database, token: string, nowMs: number): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const nowIso = new Date(nowMs).toISOString();
  const r = await db
    .prepare('UPDATE web_link_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING telegram_id')
    .bind(nowIso, await sha256Hex(token))
    .first<{ telegram_id: number }>();
  return r ? Number(r.telegram_id) : null;
}

/** Make sure the owner has a version row (first login) — returns the current version. */
export async function ensureSessionVersion(db: D1Database, telegramId: number, nowMs: number): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO web_session_versions (telegram_id, version, updated_at) VALUES (?1, 1, ?2)
       ON CONFLICT(telegram_id) DO UPDATE SET updated_at = web_session_versions.updated_at
       RETURNING version`,
    )
    .bind(telegramId, new Date(nowMs).toISOString())
    .first<{ version: number }>();
  return Number(r?.version ?? 1);
}

/** Logout everywhere: bump the version, so every issued session stops working. */
export async function bumpSessionVersion(db: D1Database, telegramId: number, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO web_session_versions (telegram_id, version, updated_at) VALUES (?1, 2, ?2)
       ON CONFLICT(telegram_id) DO UPDATE SET version = web_session_versions.version + 1, updated_at = excluded.updated_at`,
    )
    .bind(telegramId, new Date(nowMs).toISOString())
    .run();
}
