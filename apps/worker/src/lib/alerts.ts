import { tgCall } from '../bot/telegramApi.js';
import type { Env } from '../env.js';

/**
 * Operational alerts to the team's Telegram chats (ALERT_CHAT_ID, comma-separated
 * chat ids; each person must have pressed /start in the bot once).
 *
 * Throttle: the same error signature is sent at most once per ALERT_THROTTLE_MS,
 * tracked in D1 `system_events` (shared by all isolates; no KV needed). If D1 itself
 * is down, an in-memory per-isolate throttle is used instead.
 *
 * Alerting never throws and is always run in the background (ctx.waitUntil), so it
 * cannot fail or slow down the request that triggered it.
 */

export const ALERT_THROTTLE_MS = 15 * 60_000;

export type AlertKind = 'http' | 'webhook' | 'cron';

export interface Alert {
  kind: AlertKind;
  /** Throttle key: same signature → at most one message per 15 minutes. */
  signature: string;
  text: string;
}

export function alertChatIds(env: Env): string[] {
  return (env.ALERT_CHAT_ID ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^-?\d{3,20}$/.test(s));
}

export function envName(env: Env): string {
  return env.ENV_NAME?.trim() || 'honey-loyalty';
}

const memoryThrottle = new Map<string, number>();

/** Decide atomically in D1 whether this signature may be sent now (and how many repeats were swallowed). */
async function throttle(env: Env, a: Alert, nowMs: number): Promise<{ send: boolean; repeats: number }> {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - ALERT_THROTTLE_MS).toISOString();
  try {
    // SET expressions see the OLD row, so `reported` receives the old `suppressed` when an alert goes out.
    const row = await env.DB.prepare(
      `INSERT INTO system_events (signature, kind, last_sent_at, suppressed, reported, total, last_message, updated_at)
       VALUES (?1, ?2, ?3, 0, 0, 1, ?4, ?3)
       ON CONFLICT(signature) DO UPDATE SET
         reported = CASE WHEN system_events.last_sent_at <= ?5 THEN system_events.suppressed ELSE system_events.reported END,
         suppressed = CASE WHEN system_events.last_sent_at <= ?5 THEN 0 ELSE system_events.suppressed + 1 END,
         last_sent_at = CASE WHEN system_events.last_sent_at <= ?5 THEN ?3 ELSE system_events.last_sent_at END,
         total = system_events.total + 1,
         last_message = ?4,
         updated_at = ?3
       RETURNING last_sent_at = ?3 AS send, reported`,
    )
      .bind(a.signature, a.kind, now, a.text.slice(0, 500), cutoff)
      .first<{ send: number; reported: number }>();
    return { send: Number(row?.send ?? 0) === 1, repeats: Number(row?.reported ?? 0) };
  } catch (err) {
    console.error('alert throttle (D1) failed, using in-memory throttle', err);
    const last = memoryThrottle.get(a.signature);
    if (last !== undefined && nowMs - last < ALERT_THROTTLE_MS) return { send: false, repeats: 0 };
    memoryThrottle.set(a.signature, nowMs);
    return { send: true, repeats: 0 };
  }
}

/** Send one message to every ALERT_CHAT_ID. Never throws; returns whether anything was sent. */
export async function sendToAlertChats(env: Env, text: string): Promise<boolean> {
  try {
    const chats = alertChatIds(env);
    if (!chats.length || !env.BOT_TOKEN) return false;
    const results = await Promise.allSettled(
      chats.map((chat) => tgCall(env, 'sendMessage', { chat_id: chat, text: text.slice(0, 3900), disable_web_page_preview: true })),
    );
    for (const r of results) if (r.status === 'rejected') console.error('alert delivery failed', r.reason);
    return results.some((r) => r.status === 'fulfilled');
  } catch (err) {
    console.error('alert failed', err);
    return false;
  }
}

/** Throttled alert. Never throws. */
export async function sendAlert(env: Env, a: Alert, nowMs: number = Date.now()): Promise<boolean> {
  try {
    if (!alertChatIds(env).length || !env.BOT_TOKEN) return false;
    const t = await throttle(env, a, nowMs);
    if (!t.send) return false;
    const suffix = t.repeats > 0 ? `\n\n(ещё ${t.repeats} повтор(а/ов) за последние 15 минут не отправлялись)` : '';
    return await sendToAlertChats(env, a.text + suffix);
  } catch (err) {
    console.error('alert failed', err);
    return false;
  }
}

// ---------------------------------------------------------------- error alerts

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** "/api/staff/purchase/<uuid>/reverse" → "/api/staff/purchase/:id/reverse" (one signature per route, not per id). */
export function normalizeRoute(path: string): string {
  return path
    .replace(UUID_RE, ':id')
    .split('/')
    .map((seg) => (/^\d{3,}$/.test(seg) || seg.length > 40 ? ':id' : seg))
    .join('/');
}

function errorParts(err: unknown): { name: string; message: string; stack: string } {
  if (err instanceof Error) {
    const stack = (err.stack ?? '')
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((l) => (l.length > 140 ? `${l.slice(0, 137)}…` : l))
      .join('\n');
    return { name: err.name || 'Error', message: err.message || String(err), stack };
  }
  return { name: 'Error', message: String(err), stack: '' };
}

export function errorAlert(env: Env, where: { kind: AlertKind; route: string; status?: number }, err: unknown): Alert {
  const { name, message, stack } = errorParts(err);
  const msg = message.length > 400 ? `${message.slice(0, 397)}…` : message;
  // Numbers and ids differ between occurrences of the same bug: strip them from the throttle key.
  const shape = message.replace(UUID_RE, '#').replace(/\d+/g, '#').slice(0, 160);
  const head =
    where.kind === 'webhook'
      ? `Ошибка в боте (${where.route})`
      : where.kind === 'cron'
        ? `Ошибка ночной задачи (${where.route})`
        : `Ошибка ${where.status ?? 500}: ${where.route}`;
  return {
    kind: where.kind,
    signature: `${where.kind}|${where.route}|${name}: ${shape}`.slice(0, 300),
    text: `🚨 Honey Flowers · ${envName(env)}\n${head}\n${name}: ${msg}${stack ? `\n${stack}` : ''}`,
  };
}

/** Fire-and-forget error alert (runs in the background via `defer`). */
export function reportError(env: Env, defer: (p: Promise<unknown>) => void, where: { kind: AlertKind; route: string; status?: number }, err: unknown): void {
  try {
    if (!alertChatIds(env).length) return;
    defer(sendAlert(env, errorAlert(env, where, err)));
  } catch (e) {
    console.error('alert scheduling failed', e);
  }
}
