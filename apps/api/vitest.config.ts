import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against package sources, so `npm test` works without a prior build.
    alias: {
      '@honey/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@honey/service': fileURLToPath(new URL('../../packages/service/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
