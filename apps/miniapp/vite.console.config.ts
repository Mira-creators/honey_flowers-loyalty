import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Owner web console (console.html), built after the Mini App into the same dist/ (not emptied),
// with its own assets folder so dist/assets keeps only the Mini App bundle.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@honey/contracts': here('../../packages/contracts/src/index.ts') } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    assetsDir: 'assets/console',
    target: 'es2020',
    rollupOptions: { input: { console: here('console.html') } },
  },
});
