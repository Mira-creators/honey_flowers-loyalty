import type { StaffDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import { csvCell } from '../src/lib/csv.js';
import pkgJson from '../package.json?raw';
import wranglerToml from '../wrangler.toml?raw';
import { call, commandUpdate, execCtx, json, mockTelegram, register, repo, resetDb, setRole, T, testEnv, WEBHOOK_SECRET, webhook } from './helpers.js';

/**
 * Regression tests for the findings of the QA suite (qa/, `npm run qa`). Every test here
 * reproduced a real bug before its fix; keep them green.
 */

let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
});
afterEach(() => tg.restore());

describe('Q1: /setup owner=<mistyped phone>', () => {
  it('a phone that does not normalize is refused instead of becoming Telegram id 12345', async () => {
    const res = await json(call('/setup?key=test-setup-key&owner=%2B12345'));
    expect(res.steps.at(-1)).toMatchObject({ step: 'addOwner', ok: false });
    expect(String(res.steps.at(-1).detail)).toMatch(/not a valid phone/);
    const staff: StaffDTO[] = (await repo().listStaff()) as unknown as StaffDTO[];
    expect(staff).toHaveLength(0);
  });
});

describe('Q2: POST /api/owner/staff with a non-numeric "Telegram id"', () => {
  it('"@ivan_2002", "id:12a", "1e+21" and the JSON number 1e21 are refused, not read as ids 2002 / 12 / 121', async () => {
    const OWNER = T + 1;
    await setRole(OWNER, 'owner');
    for (const raw of ['@ivan_2002', 'abc123', 'id:12a', '1e+21']) {
      const res = await call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: raw, role: 'florist' } });
      expect(res.status, raw).toBe(400);
    }
    const num = await call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: 1e21, role: 'florist' } });
    expect(num.status).toBe(400);
    expect(await repo().listStaff()).toHaveLength(0);
    // plain ids still work
    expect((await call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: 'id:2002', role: 'florist' } })).status).toBe(201);
    expect((await call('/api/owner/staff', { user: OWNER, body: { phoneOrTelegramId: 4242, role: 'florist' } })).status).toBe(201);
    expect((await repo().listStaff()).map((s) => s.telegramId).sort()).toEqual([2002, 4242]);
  });
});

describe('Q3: webhook body that is not an update object', () => {
  it('JSON null / array / update_id not a number → 400, never 500; a real update still works', async () => {
    for (const raw of ['null', '[]', '"x"', '{"update_id":"1"}', '{oops']) {
      const { ctx, flush } = execCtx();
      const res = await app.request('/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: raw }, testEnv, ctx);
      await flush();
      expect(res.status, raw).toBe(400);
      expect((await json(res)).error.code).toBe('validation');
    }
    expect((await webhook(commandUpdate(5550001, '/start'))).status).toBe(200);
    expect(tg.sent().length).toBeGreaterThan(0);
  });
});

describe('Q4: CSV formula injection in the exports', () => {
  it('text starting with = + - @ is neutralized; phones and numbers are untouched', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+SUM(1;2)')).toBe(`"'+SUM(1;2)"`);
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('+998901234567')).toBe('+998901234567');
    expect(csvCell('-1500')).toBe('-1500');
    expect(csvCell(-1500)).toBe('-1500');
    expect(csvCell('Дилноза')).toBe('Дилноза');
  });

  it('a client named "=cmd|..." comes out as text in clients.csv', async () => {
    const OWNER = T + 1;
    await setRole(OWNER, 'owner');
    await register(T + 2, '+998901234567', '=cmd|\' /C calc\'!A0');
    const csv = await (await call('/api/owner/export/clients.csv', { user: OWNER })).text();
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain("'=cmd|' /C calc'!A0");
    expect(row.split(';')).not.toContain("=cmd|' /C calc'!A0");
    expect(row).toContain(';+998901234567;');
  });
});

describe('Q5: npm scripts apply migrations to a database that exists in wrangler.toml', () => {
  it('`npm run dev` / db:migrate:* name a binding or database of the top-level config', () => {
    // Top level only: the [env.*] sections are other Workers (wrangler without --env never sees them).
    const top = wranglerToml.split(/^\[env\./m)[0]!;
    const d1 = top.slice(top.indexOf('[[d1_databases]]'));
    const known = new Set([...d1.matchAll(/^\s*(?:binding|database_name)\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!));
    const scripts = (JSON.parse(pkgJson) as { scripts: Record<string, string> }).scripts;
    const used = Object.entries(scripts).flatMap(([name, cmd]) => [...cmd.matchAll(/d1 migrations apply (\S+)/g)].map((m) => [name, m[1]!] as const));
    expect(used.length).toBeGreaterThan(0);
    for (const [name, db] of used) expect(known.has(db), `${name}: "${db}" is not in wrangler.toml (${[...known].join(', ')})`).toBe(true);
  });
});
