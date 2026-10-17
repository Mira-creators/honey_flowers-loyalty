import { LoyaltyService } from '@honey/service';
import { TelegramNotifier } from './bot/notifier.js';
import { D1Repository } from './db/d1Repository.js';
import { isTestMode, type Env } from './env.js';
import { shiftedNow } from './lib/clock.js';

/**
 * Everything a request / cron run / bot update needs, built once per invocation:
 * repository, clock (real now + test offset), service with Telegram notifier.
 */
export interface AppContext {
  env: Env;
  repo: D1Repository;
  service: LoyaltyService;
  testMode: boolean;
  clockOffsetDays: number;
  now(): Date;
  /** Public https origin of the Worker (PUBLIC_URL var → stored by /setup → request origin). */
  origin(): Promise<string | null>;
}

export interface ContextOptions {
  /** ctx.waitUntil of the invocation; without it notifications are awaited inline. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Origin of the current request, used as the last fallback for the Mini App URL. */
  requestOrigin?: string | null;
}

export async function createContext(env: Env, opts: ContextOptions = {}): Promise<AppContext> {
  const repo = new D1Repository(env.DB);
  const testMode = isTestMode(env);
  const clockOffsetDays = testMode ? await repo.getClockOffsetDays() : 0;
  const now = () => shiftedNow(clockOffsetDays);
  let originCache: string | null | undefined;
  const origin = async () => {
    if (originCache !== undefined) return originCache;
    const fromEnv = env.PUBLIC_URL?.trim().replace(/\/+$/, '');
    const stored = fromEnv ? null : await repo.getSetting('public_url');
    const req = opts.requestOrigin && opts.requestOrigin.startsWith('https://') ? opts.requestOrigin : null;
    originCache = fromEnv || stored || req || null;
    return originCache;
  };
  const notifier = new TelegramNotifier(env, repo, origin);
  const service = new LoyaltyService(repo, notifier, now, {
    maxRetries: 3,
    ...(opts.waitUntil ? { defer: opts.waitUntil } : {}),
    onNotifyError: (err, events) => console.error('notification failed', events.map((e) => e.type).join(','), err),
  });
  return { env, repo, service, testMode, clockOffsetDays, now, origin };
}
