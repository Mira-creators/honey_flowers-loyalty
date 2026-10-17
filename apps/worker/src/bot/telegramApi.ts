import type { Env } from '../env.js';

/** Minimal Telegram Bot API client (fetch). Used by /setup and the notifier. */

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | null,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed: ${errorCode ?? ''} ${description}`.trim());
  }
}

export function apiBase(env: Env): string {
  return (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
}

export async function tgCall<T = unknown>(env: Env, method: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!env.BOT_TOKEN) throw new TelegramApiError(method, null, 'BOT_TOKEN is not configured');
  const res = await fetch(`${apiBase(env)}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: { ok?: boolean; result?: T; error_code?: number; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON response
  }
  if (!res.ok || !body.ok) throw new TelegramApiError(method, body.error_code ?? res.status, body.description ?? res.statusText);
  return body.result as T;
}

/** Inline keyboard with one Mini App button, or undefined if the origin cannot host a Mini App. */
export function webAppKeyboard(text: string, origin: string | null) {
  if (!origin || !origin.startsWith('https://')) return undefined;
  return { inline_keyboard: [[{ text, web_app: { url: origin } }]] };
}
