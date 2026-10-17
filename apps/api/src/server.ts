import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { InMemoryRepository, LogNotifier } from '@honey/service';

/**
 * Entry point. Until the Postgres repository exists the API runs on the
 * in-memory repository. Staff can be seeded for local testing with
 * DEV_STAFF="<telegram_id>:<role>:<name>,..." (e.g. "111:owner:Амалия").
 */
/** Load the repo-root .env if present (same depth from src/ and dist/). */
function loadDotEnv() {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  if (config.databaseUrl) {
    console.warn('DATABASE_URL is set, but the Postgres repository is not implemented yet: using in-memory storage');
  }
  const repo = new InMemoryRepository();
  for (const item of (process.env.DEV_STAFF ?? '').split(',').filter(Boolean)) {
    const [id, role, ...name] = item.split(':');
    if (role === 'florist' || role === 'manager' || role === 'owner') {
      repo.addStaff({ telegramId: Number(id), role, name: name.join(':') || `staff ${id}`, active: true });
    }
  }
  let log: (obj: object, msg: string) => void = () => undefined;
  const { app } = buildApp({
    repo,
    botToken: config.botToken,
    initDataMaxAgeSeconds: config.initDataMaxAgeSeconds,
    logger: { level: 'info' },
    // Bot is not implemented yet: notifications are only written to the log.
    notifier: new LogNotifier((obj, msg) => log(obj, msg)),
  });
  log = (obj, msg) => app.log.info(obj, msg);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
