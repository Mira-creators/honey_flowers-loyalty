/** Bindings, vars and secrets of the Worker (see wrangler.toml and docs/DEPLOY.md). */
export interface Env {
  /** Cloudflare D1 database "honey-loyalty". */
  DB: D1Database;
  /** Static files of the Mini App (apps/miniapp/dist). */
  ASSETS?: Fetcher;

  /** "1" = test version: X-Test-User auth, role switching, test clock, /api/test/*. */
  TEST_MODE?: string;
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

  /** Tests only: base URL of the Telegram Bot API (default https://api.telegram.org). */
  TELEGRAM_API_BASE?: string;
}

export function isTestMode(env: Env): boolean {
  return env.TEST_MODE === '1' || env.TEST_MODE === 'true';
}
