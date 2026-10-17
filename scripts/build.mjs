// Root build: packages → apps/api → Mini App (if present) → Worker typecheck.
// The Mini App (apps/miniapp) is developed separately; when it is missing or has no
// build script, the Worker serves a placeholder page (apps/worker/scripts/ensure-assets.mjs).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Works from any directory (root `npm run build` and `npm run build` inside apps/worker).
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

run('npm run build -w @honey/core');
run('npm run build -w @honey/service');
run('npm run build -w @honey/api');

const miniPkg = 'apps/miniapp/package.json';
if (existsSync(miniPkg) && JSON.parse(readFileSync(miniPkg, 'utf8')).scripts?.build) {
  run('npm run build -w apps/miniapp');
} else {
  console.log('\n[build] apps/miniapp has no build script yet: skipping the Mini App build');
}
run('node apps/worker/scripts/ensure-assets.mjs');
run('npm run typecheck -w @honey/worker');
run('npm run typecheck -w @honey/contracts');
