// Picks which Worker a Cloudflare build produces, by git branch.
//
//   main → Worker "honeyflowers",  database honey-loyalty-client  (the client's version)
//   dev  → Worker "honey-loyalty", database honey-loyalty         (our playground, test bot)
//
// Cloudflare Workers Builds exposes the branch as WORKERS_CI_BRANCH. Locally nothing changes.
// Usage (deploy command): node scripts/select-env.mjs && npx wrangler d1 migrations apply $(node scripts/select-env.mjs --db) --remote && npx wrangler deploy
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = {
  main: { name: 'honeyflowers', dbName: 'honey-loyalty-client', dbId: process.env.CLIENT_D1_ID ?? '', kind: 'client' },
  dev: { name: 'honey-loyalty', dbName: 'honey-loyalty', dbId: 'eda1f266-41a7-4db4-bd94-f3391d7db9b1', kind: 'dev' },
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
// Alerts name the deployment; chat ids may come from build variables (one value per Worker).
toml = toml.replace(/^ENV_NAME = ".*"$/m, `ENV_NAME = "${t.name} (${branch})"`);
const safe = (v) => String(v).replace(/[^0-9,\s-]/g, '');
if (process.env.ALERT_CHAT_ID) toml = toml.replace(/^ALERT_CHAT_ID = ".*"$/m, `ALERT_CHAT_ID = "${safe(process.env.ALERT_CHAT_ID)}"`);
// Test mode per Worker from build variables: TEST_MODE ("1"/"0") and TEST_USERS (ids / +998 phones).
// The client Worker goes to production by setting the build variable TEST_MODE=0 (docs/DEPLOY.md).
toml = toml.replace(/^DEPLOY_ENV = ".*"$/m, `DEPLOY_ENV = "${t.kind}"`);
if (process.env.TEST_MODE !== undefined && process.env.TEST_MODE !== '') {
  toml = toml.replace(/^TEST_MODE = ".*"$/m, `TEST_MODE = "${process.env.TEST_MODE.trim() === '1' ? '1' : '0'}"`);
}
if (process.env.TEST_USERS !== undefined) {
  const users = String(process.env.TEST_USERS).replace(/[^0-9,+\s]/g, '').replace(/\s+/g, ' ').trim();
  toml = toml.replace(/^TEST_USERS = ".*"$/m, `TEST_USERS = "${users}"`);
}
if (process.env.ALERT_DAILY) toml = toml.replace(/^ALERT_DAILY = ".*"$/m, `ALERT_DAILY = "${process.env.ALERT_DAILY === '1' ? '1' : '0'}"`);
writeFileSync(path, toml);
const tm = /^TEST_MODE = "(.*)"$/m.exec(toml)?.[1];
const tu = /^TEST_USERS = "(.*)"$/m.exec(toml)?.[1] ?? '';
const testInfo = tm === '1' ? `TEST_MODE=1, test features: ${tu ? `only TEST_USERS (${tu.split(',').filter(Boolean).length})` : t.kind === 'client' ? 'OFF (TEST_USERS empty on the client worker)' : 'everyone'}` : 'TEST_MODE=0 (production)';
console.log(`[select-env] branch=${branch} → worker=${t.name}, database=${t.dbName}, ${testInfo}`);
