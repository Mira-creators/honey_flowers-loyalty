import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Apply migrations once per test file (idempotent: tracked in d1_migrations).
const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);

// Most worker tests were written for the pre-questionnaire placeholder rules; tests of the owner's
// rules (defaultRules) re-seed version 1 themselves (helpers.ts seedRules).
const { RULES_V1_PLACEHOLDER } = await import('@honey/core');
await e.DB.batch([
  e.DB.prepare('DELETE FROM rules_versions'),
  e.DB.prepare(`INSERT INTO rules_versions (id, rules, active_from, created_by, created_at) VALUES (1, ?, '1970-01-01T00:00:00.000Z', NULL, ?)`).bind(JSON.stringify(RULES_V1_PLACEHOLDER), new Date().toISOString()),
  e.DB.prepare(`INSERT INTO settings (key, value) VALUES ('rules_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`),
]);
