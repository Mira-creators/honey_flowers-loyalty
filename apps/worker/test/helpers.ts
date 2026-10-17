import type { MeDTO, PurchaseResultDTO, Role } from '@honey/contracts';
import { buildInitData } from '@honey/service';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import app from '../src/app.js';
import { D1Repository } from '../src/db/d1Repository.js';
import type { Env } from '../src/env.js';

export const testEnv = env as unknown as Env;
export const BOT_TOKEN = testEnv.BOT_TOKEN!;
export const WEBHOOK_SECRET = testEnv.WEBHOOK_SECRET!;

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * Mock of the Telegram Bot API: intercepts fetch to api.telegram.org and
 * records calls. `failSendMessage` makes sendMessage fail (to prove that
 * notifications never break a purchase).
 */
export function mockTelegram(opts: { failSendMessage?: boolean } = {}) {
  const calls: TgCall[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(url);
    if (!m) return realFetch(input as RequestInfo, init);
    const method = m[1]!;
    let payload: Record<string, unknown> = {};
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body === 'string' && body) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { raw: body };
      }
    }
    calls.push({ method, payload });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    switch (method) {
      case 'getMe':
        return ok({ id: 7000000001, is_bot: true, first_name: 'Honey Flowers', username: 'honey_flowers_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false });
      case 'sendMessage':
        if (opts.failSendMessage) {
          return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
        }
        return ok({ message_id: calls.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' }, text: payload.text });
      case 'getWebhookInfo':
        return ok({ url: 'https://honey.example.workers.dev/telegram/webhook', has_custom_certificate: false, pending_update_count: 0 });
      default:
        return ok(true);
    }
  });
  return {
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    restore: () => spy.mockRestore(),
  };
}

export const repo = () => new D1Repository(testEnv.DB);

/** Wipe all data between tests (the Workers pool keeps D1 state within a file). */
export async function resetDb() {
  await repo().wipeAll();
}

/** A pending ctx.waitUntil collector, so tests can await notifications. */
export function execCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.allSettled(pending) };
}

export interface ReqOpts {
  user?: number;
  name?: string;
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
}

/** Call the Hono app as a tester (X-Test-User) and wait for background work. */
export async function call(path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.user !== undefined) headers['x-test-user'] = String(opts.user);
  if (opts.name) headers['x-test-name'] = encodeURIComponent(opts.name);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const { ctx, flush } = execCtx();
  const res = await app.request(
    path,
    { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
    testEnv,
    ctx,
  );
  await flush();
  return res;
}

export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

/** Signed Telegram initData header for a user (real signature with the test BOT_TOKEN). */
export async function tmaHeader(telegramId: number, extra: Record<string, unknown> = {}, authDate = new Date()) {
  const initData = await buildInitData(
    {
      auth_date: String(Math.floor(authDate.getTime() / 1000)),
      query_id: 'AAE-test',
      user: JSON.stringify({ id: telegramId, first_name: 'Тест', language_code: 'ru', ...extra }),
    },
    BOT_TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

let updateId = 1000;

/** Deliver a Telegram update to the webhook. */
export async function webhook(update: Record<string, unknown>, secret: string | null = WEBHOOK_SECRET): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  const { ctx, flush } = execCtx();
  const res = await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify({ update_id: ++updateId, ...update }) }, testEnv, ctx);
  await flush();
  return res;
}

export function tgFrom(id: number, firstName = 'Амалия') {
  return { id, is_bot: false, first_name: firstName, language_code: 'ru' };
}

export function messageUpdate(fromId: number, message: Record<string, unknown>) {
  return {
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Амалия' },
      from: tgFrom(fromId),
      ...message,
    },
  };
}

export function contactUpdate(fromId: number, phone: string, contactUserId = fromId) {
  return messageUpdate(fromId, { contact: { phone_number: phone, first_name: 'Амалия', user_id: contactUserId } });
}

export function commandUpdate(fromId: number, command: string) {
  return messageUpdate(fromId, { text: command, entities: [{ type: 'bot_command', offset: 0, length: command.split(' ')[0]!.length }] });
}

/** Register a client through the TEST_MODE shortcut. */
export async function register(user: number, phone = `+99890${String(user).padStart(7, '0').slice(-7)}`, name = `Клиент ${user}`): Promise<MeDTO> {
  const res = await call('/api/test/register', { user, body: { phone, name } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return json<MeDTO>(res);
}

export async function setRole(user: number, role: Role) {
  const res = await call('/api/test/role', { user, body: { role } });
  if (res.status !== 200) throw new Error(`role failed: ${res.status} ${await res.text()}`);
}

export async function makeStaff(user: number, role: Role, name = `Сотрудник ${user}`) {
  await repo().upsertStaff({ telegramId: user, phone: null, name, role: role === 'client' ? 'florist' : role }, new Date());
}

let keySeq = 0;
export function key() {
  return `order-${Date.now()}-${++keySeq}`;
}

export async function buy(staff: number, clientId: string, amount: number, extra: Record<string, unknown> = {}): Promise<PurchaseResultDTO> {
  const res = await call('/api/staff/purchase', { user: staff, body: { clientId, amount, redeem: false, idempotencyKey: key(), ...extra } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`purchase failed: ${res.status} ${await res.text()}`);
  return json<PurchaseResultDTO>(res);
}

/** Move the global test clock (days) — as a tester. */
export async function moveClock(days: number) {
  const res = await call('/api/test/clock', { user: 1, body: { days } });
  if (res.status !== 200) throw new Error(`clock failed: ${res.status} ${await res.text()}`);
}
