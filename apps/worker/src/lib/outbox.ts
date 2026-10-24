import { dayNumberFromKey, localDateKey, type LoyaltyEvent, type LoyaltyRules } from '@honey/core';
import { isUnlinkedTelegramId } from '@honey/service';
import { composeMessage } from '../bot/notifier.js';
import { TelegramApiError, tgCall, webAppKeyboard } from '../bot/telegramApi.js';
import { t } from '../bot/texts.js';
import type { D1Repository, NotificationLogEntry } from '../db/d1Repository.js';
import type { Env } from '../env.js';
import type { SubrequestBudget } from './budget.js';

/**
 * Outbox of the daily job's messages (migration 0009). The job writes one row per client with
 * the events of that run, IN THE SAME BATCH as the facts (expiry entry, reminder keys), so a
 * reminder can never be "marked sent" without a message that will be sent. sendOutbox() delivers
 * pending rows (only 09:00–21:00 Tashkent for the scheduled job), and marks a row sent only after
 * Telegram accepted it; a transient failure is retried by a later run with backoff, a permanent one
 * (bot blocked, chat not found, too many attempts) is stored as failed — always logged.
 */

/** Messages are sent from 09:00 (incl.) to 21:00 (excl.) Tashkent time. */
export const SEND_FROM_HOUR = 9;
export const SEND_TO_HOUR = 21;
export const MAX_ATTEMPTS = 8;

export function tashkentHour(realMs: number): number {
  return new Date(realMs + 5 * 3_600_000).getUTCHours();
}

export function inSendWindow(realMs: number): boolean {
  const h = tashkentHour(realMs);
  return h >= SEND_FROM_HOUR && h < SEND_TO_HOUR;
}

export function outboxInsertStmt(db: D1Database, clientId: string, events: LoyaltyEvent[], nowIso: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO outbox (client_id, events, status, attempts, next_attempt_at, created_at) VALUES (?1, ?2, 'pending', 0, ?3, ?3)`)
    .bind(clientId, JSON.stringify(events), nowIso);
}

/** Backoff after the n-th failed attempt: 10 min, 20 min, 40 min … capped at 6 h. */
export function backoffMs(attempts: number): number {
  return Math.min(6 * 3_600_000, 10 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** 400 (chat not found, bad request) and 403 (bot blocked / user deactivated) never succeed on retry. */
function permanent(e: unknown): boolean {
  return e instanceof TelegramApiError && (e.errorCode === 400 || e.errorCode === 403 || e.errorCode === null);
}

/**
 * Reminders that wait in the outbox are re-dated at send time: "сгорит через N дней" counts from
 * the real send day; a reminder whose expiry day has already come is dropped (the expiry itself
 * has its own message).
 */
export function freshEvents(events: LoyaltyEvent[], today: string): LoyaltyEvent[] {
  const out: LoyaltyEvent[] = [];
  for (const e of events) {
    if (e.type !== 'expiry_warning') {
      out.push(e);
      continue;
    }
    const daysLeft = dayNumberFromKey(e.expiresOn) - dayNumberFromKey(today);
    if (daysLeft > 0) out.push({ ...e, daysLeft });
  }
  return out;
}

export interface SendResult {
  sent: number;
  failed: number;
  skipped: number;
  /** Pending rows left after this run (approximate: those not attempted). */
  queued: number;
}

type Row = Record<string, unknown>;

/**
 * Send up to `max` due rows, within the subrequest budget (keeps `reserve` for the caller).
 * Round trips: 1 select (+ contacts joined) + 1 fetch per message + 1 write batch (status rows + log).
 */
export async function sendOutbox(
  env: Env,
  repo: D1Repository,
  rules: LoyaltyRules,
  origin: string | null,
  opts: { max: number; budget: SubrequestBudget; reserve: number; nowMs: number; testNow: Date },
): Promise<SendResult> {
  const res: SendResult = { sent: 0, failed: 0, skipped: 0, queued: 0 };
  const db = repo.db;
  const nowIso = new Date(opts.nowMs).toISOString();
  // select + update batch must fit, plus at least one fetch
  const room = Math.min(opts.max, opts.budget.left() - opts.reserve - 2);
  if (room <= 0) {
    res.queued = Number((await db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).first<{ n: number }>())?.n ?? 0);
    return res;
  }
  const { results } = await db
    .prepare(
      `SELECT o.id, o.client_id, o.events, o.attempts, c.telegram_id, c.language, c.demo,
         (SELECT COUNT(*) FROM outbox p WHERE p.status = 'pending') AS pending
       FROM outbox o LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= ?1 ORDER BY o.next_attempt_at, o.id LIMIT ?2`,
    )
    .bind(nowIso, room)
    .all<Row>();
  const pending = Number(results[0]?.pending ?? 0);
  const today = localDateKey(opts.testNow, rules.timezone);
  const updates: D1PreparedStatement[] = [];
  const log: NotificationLogEntry[] = [];
  let finalFailed = 0;
  const done = (id: unknown, status: 'sent' | 'failed' | 'skipped', error: string | null) =>
    updates.push(
      db.prepare(`UPDATE outbox SET status = ?2, sent_at = CASE WHEN ?2 = 'sent' THEN ?3 ELSE sent_at END, attempts = attempts + ?4, last_error = ?5 WHERE id = ?1`)
        .bind(Number(id), status, nowIso, status === 'skipped' ? 0 : 1, error),
    );
  for (const r of results) {
    const telegramId = r.telegram_id === null || r.telegram_id === undefined ? null : Number(r.telegram_id);
    const lang = String(r.language ?? 'ru');
    const events = freshEvents(JSON.parse(String(r.events)) as LoyaltyEvent[], today);
    const text = events.length ? composeMessage(rules, events, lang) : null;
    const types = events.map((e) => e.type).join(',') || 'expiry_warning';
    // No chat behind demo / not-yet-claimed imported clients, nothing worth saying, or no bot.
    if (telegramId === null || !text || Number(r.demo ?? 0) === 1 || isUnlinkedTelegramId(telegramId) || telegramId === 0 || !env.BOT_TOKEN) {
      done(r.id, 'skipped', !text ? 'nothing to send (stale reminder)' : !env.BOT_TOKEN ? 'BOT_TOKEN not set' : 'no Telegram chat');
      res.skipped++;
      if (text) log.push({ clientId: String(r.client_id), telegramId, types, text, status: 'skipped', error: !env.BOT_TOKEN ? 'BOT_TOKEN not set' : 'no Telegram chat' });
      continue;
    }
    if (opts.budget.left() <= opts.reserve + 1) break; // keep the final write batch
    opts.budget.spend(); // the fetch below
    try {
      await tgCall(env, 'sendMessage', { chat_id: telegramId, text, reply_markup: webAppKeyboard(t(lang).openCardButton, origin) });
      done(r.id, 'sent', null);
      res.sent++;
      log.push({ clientId: String(r.client_id), telegramId, types, text, status: 'sent' });
    } catch (e) {
      res.failed++;
      const attempts = Number(r.attempts ?? 0) + 1;
      const msg = String(e).slice(0, 300);
      log.push({ clientId: String(r.client_id), telegramId, types, text, status: 'failed', error: msg });
      if (permanent(e) || attempts >= MAX_ATTEMPTS) {
        done(r.id, 'failed', msg);
        finalFailed++;
      }
      else {
        updates.push(
          db.prepare(`UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3 WHERE id = ?1`)
            .bind(Number(r.id), new Date(opts.nowMs + backoffMs(attempts)).toISOString(), msg),
        );
      }
    }
  }
  if (updates.length || log.length) {
    const at = nowIso;
    await db.batch([
      ...updates,
      ...log.map((l) =>
        db
          .prepare('INSERT INTO notifications_log (client_id, telegram_id, types, text, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(l.clientId, l.telegramId, l.types, l.text, l.status, l.error ?? null, at),
      ),
    ]);
  }
  res.queued = Math.max(0, pending - res.sent - res.skipped - finalFailed);
  return res;
}
