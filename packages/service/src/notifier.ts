import type { LoyaltyEvent } from '@honey/core';

/**
 * Delivers engine events to clients (Telegram messages in apps/worker).
 * The service calls `send` only AFTER the outcome is committed, and a failing
 * notifier never fails the command (errors are caught and logged).
 */
export interface Notifier {
  send(events: LoyaltyEvent[]): Promise<void>;
}

export class MemoryNotifier implements Notifier {
  readonly sent: LoyaltyEvent[] = [];
  async send(events: LoyaltyEvent[]): Promise<void> {
    this.sent.push(...events);
  }
}

export class LogNotifier implements Notifier {
  constructor(private readonly log: (obj: object, msg: string) => void) {}
  async send(events: LoyaltyEvent[]): Promise<void> {
    for (const e of events) this.log({ event: e }, `notify ${e.type}`);
  }
}

export class NullNotifier implements Notifier {
  async send(): Promise<void> {}
}
