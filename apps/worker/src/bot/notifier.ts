import type { LoyaltyEvent, LoyaltyRules } from '@honey/core';
import type { Notifier } from '@honey/service';
import type { D1Repository, NotificationLogEntry } from '../db/d1Repository.js';
import type { Env } from '../env.js';
import { tgCall, webAppKeyboard } from './telegramApi.js';
import { fmtDate, t } from './texts.js';

/**
 * Sends engine events to clients as Telegram messages (one message per client
 * per command). Called by LoyaltyService AFTER the DB commit, via ctx.waitUntil;
 * errors are logged to notifications_log (one batch per send) and never reach
 * the HTTP response.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly env: Env,
    private readonly repo: D1Repository,
    private readonly origin: () => Promise<string | null>,
  ) {}

  async send(events: LoyaltyEvent[]): Promise<void> {
    const byClient = new Map<string, LoyaltyEvent[]>();
    for (const e of events) {
      const list = byClient.get(e.clientId) ?? [];
      list.push(e);
      byClient.set(e.clientId, list);
    }
    if (!byClient.size) return;
    const { rules } = await this.repo.getActiveRules();
    const contacts = await this.repo.clientContacts([...byClient.keys()]);
    const origin = await this.origin();
    const failures: unknown[] = [];
    const log: NotificationLogEntry[] = [];
    for (const [clientId, list] of byClient) {
      const contact = contacts.get(clientId);
      const lang = contact?.language ?? 'ru';
      const text = composeMessage(rules, list, lang);
      if (!text) continue;
      const types = list.map((e) => e.type).join(',');
      if (!contact) {
        log.push({ clientId: null, telegramId: null, types, text, status: 'skipped', error: 'client not found' });
        continue;
      }
      if (!this.env.BOT_TOKEN) {
        log.push({ clientId, telegramId: contact.telegramId, types, text, status: 'skipped', error: 'BOT_TOKEN not set' });
        continue;
      }
      try {
        await tgCall(this.env, 'sendMessage', {
          chat_id: contact.telegramId,
          text,
          reply_markup: webAppKeyboard(t(lang).openCardButton, origin),
        });
        log.push({ clientId, telegramId: contact.telegramId, types, text, status: 'sent' });
      } catch (err) {
        log.push({ clientId, telegramId: contact.telegramId, types, text, status: 'failed', error: String(err) });
        failures.push(err);
      }
    }
    await this.repo.logNotifications(log);
    if (failures.length) throw new AggregateError(failures, `${failures.length} notification(s) failed`);
  }
}

/** Human message for one client's events (null = nothing worth sending). */
export function composeMessage(rules: LoyaltyRules, events: LoyaltyEvent[], lang: string): string | null {
  const T = t(lang);
  const title = (id: string) => rules.levels.tiers.find((x) => x.id === id)?.title ?? id;
  const lines: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'points_accrued':
        lines.push(T.accrued(e.amount, e.balance));
        break;
      case 'card_advanced':
        lines.push(e.cardCompleted ? T.cardCompleted : T.cardAdvanced(e.cell, rules.honeycomb.cells, e.purchasesToNextReward));
        break;
      case 'reward_unlocked':
        lines.push(T.giftUnlocked(e.title));
        break;
      case 'level_up':
        lines.push(T.levelUp(title(e.to), e.cashbackPct));
        break;
      case 'level_down':
        lines.push(T.levelDown(title(e.to)));
        break;
      case 'expiry_warning':
        lines.push(T.expiryWarning(e.daysLeft, e.balance, fmtDate(e.expiresOn)));
        break;
      case 'points_expired':
        lines.push(T.expired(e.amount, rules.expiry.expiryDays));
        break;
      case 'card_reset':
        lines.push(T.cardReset);
        break;
      case 'purchase_reversed':
        lines.push(T.reversed(e.reason));
        break;
      case 'points_adjusted':
        lines.push(T.adjusted(e.amount, e.balance, e.reason));
        break;
      case 'points_redeemed':
        // Only worth mentioning alongside other news of the same purchase.
        if (events.some((x) => x.type !== 'points_redeemed' && x.type !== 'reward_used')) lines.push(T.redeemed(e.amount));
        break;
      case 'welcome_bonus': // the bot replies to the contact message directly
      case 'reward_used':
        break;
    }
  }
  return lines.length ? lines.join('\n') : null;
}
