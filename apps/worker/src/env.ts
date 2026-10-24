import { testPolicy } from './lib/testAccess.js';

/** Bindings, vars and secrets of the Worker (see wrangler.toml and docs/DEPLOY.md). */
export interface Env {
  /** Cloudflare D1 database "honey-loyalty". */
  DB: D1Database;
  /** Static files of the Mini App (apps/miniapp/dist). */
  ASSETS?: Fetcher;

  /** "1" = test version: X-Test-User auth, role switching, test clock, /api/test/*. */
  TEST_MODE?: string;
  /**
   * TEST_MODE only: who may use the test features (lib/testAccess.ts). Comma-separated Telegram
   * ids and/or phones (+998…). Set → only they; everyone else behaves as in production.
   * Empty → everyone on the dev polygon, NOBODY on the client worker (fail closed).
   */
  TEST_USERS?: string;
  /** "client" | "dev" | "local": which deployment this is (scripts/select-env.mjs sets it on build). */
  DEPLOY_ENV?: string;
  /** Bot username without "@" (shown in the app). Optional: /setup fills it from getMe. */
  BOT_USERNAME?: string;
  /** Public origin of the Worker, e.g. https://honey-loyalty.<you>.workers.dev. Optional: /setup stores it. */
  PUBLIC_URL?: string;
  /** Max age of Telegram initData in seconds (default 86400). */
  INIT_DATA_MAX_AGE?: string;

  /** Secret: token from @BotFather. */
  BOT_TOKEN?: string;
  /** Secret: random string; Telegram sends it back in X-Telegram-Bot-Api-Secret-Token. */
  WEBHOOK_SECRET?: string;
  /** Secret: protects GET /setup?key=... */
  SETUP_KEY?: string;
  /** Secret, TEST_MODE only: required in X-Test-Key next to X-Test-User (browser testing). Unset = browser testing off. */
  TEST_KEY?: string;
  /**
   * Secret, optional: HMAC key of owner console browser sessions (console/webAuth.ts). Unset = a key
   * derived from BOT_TOKEN (or another secret). Changing it logs every browser out.
   */
  WEB_SESSION_SECRET?: string;
  /** Daily job (hourly): clients processed per run (default 100, see cron.ts). */
  CRON_MAX_CLIENTS?: string;
  /** Daily job: Telegram messages sent per run from the outbox (default 25; 09:00–21:00 Tashkent). */
  CRON_MAX_SENDS?: string;

  /** Monitoring: comma-separated Telegram chat ids that get alerts (5xx, bot errors, nightly job failures). Empty = off. */
  ALERT_CHAT_ID?: string;
  /** "1" = after every cron run also send a short «Ночная задача: ок …» message to ALERT_CHAT_ID. */
  ALERT_DAILY?: string;
  /** Name of this deployment shown in alerts and /health, e.g. "honey-loyalty-dev (dev)". */
  ENV_NAME?: string;

  /** Tests only: base URL of the Telegram Bot API (default https://api.telegram.org). */
  TELEGRAM_API_BASE?: string;
}

/**
 * Test features are switched on for at least somebody (TEST_MODE=1 and the TEST_USERS policy is not
 * 'off', see lib/testAccess.ts). Whether a particular caller may use them is `Caller.tester`.
 */
export function isTestMode(env: Env): boolean {
  return testPolicy(env).mode !== 'off';
}
