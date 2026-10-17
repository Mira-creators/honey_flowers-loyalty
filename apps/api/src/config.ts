/** Environment configuration. See .env.example. */
export interface AppConfig {
  botToken: string;
  databaseUrl: string | null;
  port: number;
  /** Max age of Telegram initData, seconds. */
  initDataMaxAgeSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const botToken = env.BOT_TOKEN ?? '';
  if (!botToken) throw new Error('BOT_TOKEN is required (see .env.example)');
  return {
    botToken,
    databaseUrl: env.DATABASE_URL || null,
    port: Number(env.PORT ?? 3000),
    initDataMaxAgeSeconds: Number(env.INIT_DATA_MAX_AGE ?? 86_400),
  };
}
