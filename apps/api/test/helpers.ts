import { defaultRules, type LoyaltyRules } from '@honey/core';
import { buildApp } from '../src/app.js';
import { InMemoryRepository } from '../src/repo/inMemory.js';
import { MemoryNotifier } from '../src/services/notifier.js';
import { buildInitData } from '../src/telegram/initData.js';

export const BOT_TOKEN = '7000000001:AAH-test-token-for-api-tests';
export const FLORIST_TG = 1001;
export const OWNER_TG = 1002;
export const CLIENT_TG = 5001;

/** Mutable test clock. */
export class Clock {
  constructor(public now: Date) {}
  set(local: string) {
    this.now = new Date(`${local.replace(' ', 'T')}:00+05:00`);
  }
  readonly fn = () => this.now;
}

export function setup(rules: LoyaltyRules = defaultRules) {
  const clock = new Clock(new Date('2026-11-01T10:00:00+05:00'));
  const repo = new InMemoryRepository({
    rules,
    staff: [
      { telegramId: FLORIST_TG, name: 'Флорист', role: 'florist', active: true },
      { telegramId: OWNER_TG, name: 'Владелец', role: 'owner', active: true },
      { telegramId: 1003, name: 'Бывший', role: 'florist', active: false },
    ],
  });
  const notifier = new MemoryNotifier();
  const { app, service } = buildApp({ repo, botToken: BOT_TOKEN, notifier, clock: clock.fn });

  /** Authorization header for a Telegram user, signed "now". */
  const tma = (telegramId: number, extra: Record<string, unknown> = {}) => ({
    authorization:
      'tma ' +
      buildInitData(
        {
          auth_date: String(Math.floor(clock.now.getTime() / 1000)),
          user: JSON.stringify({ id: telegramId, first_name: 'Тест', language_code: 'ru', ...extra }),
        },
        BOT_TOKEN,
      ),
  });

  /** Register a client via the API and give them a phone (no phone endpoint yet). */
  const registerClient = async (telegramId = CLIENT_TG, phone = '+998 90 123-45-67') => {
    const res = await app.inject({ method: 'POST', url: '/auth/telegram', headers: tma(telegramId) });
    const id = res.json().client.id as string;
    await repo.updateClient(id, { phone });
    return id;
  };

  return { app, service, repo, notifier, clock, tma, registerClient };
}
