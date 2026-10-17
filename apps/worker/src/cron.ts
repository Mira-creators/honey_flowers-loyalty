import type { AppContext } from './context.js';

export interface DailyJobResult {
  /** Clients whose points burned (or level/card was reset) in this run. */
  expired: number;
  /** Expiry warnings sent in this run. */
  warned: number;
}

/**
 * Daily job (cron "0 4 * * *" = 09:00 Tashkent, also POST /api/test/run-expiry):
 * expiry + reminders for every client through the engine, then notifications.
 * Uses the same clock as the API (real now + test offset).
 */
export async function runDailyJob(app: AppContext): Promise<DailyJobResult> {
  const events = await app.service.runExpiryForAll();
  const expiredClients = new Set(
    events.filter((e) => e.type === 'points_expired' || e.type === 'level_down' || e.type === 'card_reset').map((e) => e.clientId),
  );
  return { expired: expiredClients.size, warned: events.filter((e) => e.type === 'expiry_warning').length };
}
