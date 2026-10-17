import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside the real Workers runtime (workerd via Miniflare) with a local
 * D1 database; migrations/ are applied in test/setup.ts. Telegram Bot API calls
 * are mocked by stubbing globalThis.fetch.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: '7000000001:AAH-test-token-for-worker-tests',
            WEBHOOK_SECRET: 'test-webhook-secret',
            SETUP_KEY: 'test-setup-key',
            PUBLIC_URL: 'https://honey.example.workers.dev',
          },
        },
      }),
    ],
    resolve: {
      alias: {
        '@honey/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
        '@honey/service': fileURLToPath(new URL('../../packages/service/src/index.ts', import.meta.url)),
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
