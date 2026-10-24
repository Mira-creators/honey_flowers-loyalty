import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Telegram Mini App (index.html) — one self-contained bundle in dist/assets (test/e2e*.js evaluate it).
// The owner web console (console.html) is a second, separate build: vite.console.config.ts → dist/assets/console/.
// Dev: the Worker runs on :8787 (wrangler dev), Vite proxies API + webhook calls to it; /console.html works in dev too.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Contracts are consumed as TypeScript source (types + the console's import helpers).
    alias: { '@honey/contracts': here('../../packages/contracts/src/index.ts') },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/telegram': 'http://localhost:8787', '/setup': 'http://localhost:8787', '/health': 'http://localhost:8787' },
  },
});
