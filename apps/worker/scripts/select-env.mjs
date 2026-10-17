// Picks which Worker a Cloudflare build produces, by git branch.
//
//   main → Worker "honeyflowers",  database honey-loyalty-client  (the client's version)
//   dev  → Worker "honey-loyalty", database honey-loyalty         (our playground, test bot)
//
// Cloudflare Workers Builds exposes the branch as WORKERS_CI_BRANCH. Locally nothing changes.
// Usage (deploy command): node scripts/select-env.mjs && npx wrangler d1 migrations apply $(node scripts/select-env.mjs --db) --remote && npx wrangler deploy
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = {
  main: { name: 'honeyflowers', dbName: 'honey-loyalty-client', dbId: process.env.CLIENT_D1_ID ?? '' },
  dev: { name: 'honey-loyalty', dbName: 'honey-loyalty', dbId: 'eda1f266-41a7-4db4-bd94-f3391d7db9b1' },
};

const branch = process.env.WORKERS_CI_BRANCH || process.env.BRANCH || 'dev';
const t = TARGETS[branch] ?? TARGETS.dev;

if (process.argv.includes('--db')) { process.stdout.write(t.dbName); process.exit(0); }

if (branch === 'main' && !t.dbId) {
  console.error('[select-env] CLIENT_D1_ID is not set: add it as a build variable of the client Worker (Settings → Build → Variables).');
  process.exit(1);
}

const path = new URL('../wrangler.toml', import.meta.url);
let toml = readFileSync(path, 'utf8');
toml = toml.replace(/^name = ".*"$/m, `name = "${t.name}"`);
toml = toml.replace(/^database_name = ".*"$/m, `database_name = "${t.dbName}"`);
toml = toml.replace(/^database_id = ".*"$/m, `database_id = "${t.dbId}"`);
writeFileSync(path, toml);
console.log(`[select-env] branch=${branch} → worker=${t.name}, database=${t.dbName}`);
