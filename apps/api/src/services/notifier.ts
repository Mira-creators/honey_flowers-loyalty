import type { LoyaltyEvent } from '@honey/core';

/**
 * Delivers engine events to clients. The real implementation will send
 * Telegram bot messages (grammY) and write notifications_log; for now events
 * are logged or collected in memory.
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
