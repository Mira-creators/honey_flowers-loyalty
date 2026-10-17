import { defineConfig } from 'vite';

// Dev: the Worker runs on :8787 (wrangler dev), Vite proxies API + webhook calls to it.
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/telegram': 'http://localhost:8787', '/setup': 'http://localhost:8787' },
  },
});
