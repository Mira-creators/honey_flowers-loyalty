import type { ExportLinkDTO, MeDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Repository } from '../src/db/d1Repository.js';
import { call, json, makeStaff, mockTelegram, register, repo, resetDb, T } from './helpers.js';
import app from '../src/app.js';
import { testEnv } from './helpers.js';

/** QA low L2: impossible calendar dates. */

const OWNER = T + 1;
let tg: ReturnType<typeof mockTelegram>;
beforeEach(async () => {
  await resetDb();
  tg = mockTelegram();
  await makeStaff(OWNER, 'owner');
});
afterEach(() => {
  vi.restoreAllMocks();
  tg.restore();
});

const open = (url: string) => app.request(new URL(url).pathname + new URL(url).search, {}, testEnv);

describe('L2: impossible dates are rejected with a Russian 400', () => {
  it('export period, export link and console ranges', async () => {
    for (const path of ['/api/owner/export/operations.csv?from=2026-02-31&to=2026-03-01', '/api/owner/export/operations.csv?from=2026-03-01&to=2026-04-31', '/api/owner/console/overview?from=2026-02-30&to=2026-03-10']) {
      const r = await call(path, { user: OWNER });
      expect(r.status, path).toBe(400);
      expect((await json(r)).error.message, path).toMatch(/[А-Яа-я]/);
    }
    const link = await call('/api/owner/export/link', { user: OWNER, body: { kind: 'operations', from: '2026-02-31', to: '2026-03-02' } });
    expect(link.status).toBe(400);
    expect((await json(link)).error.message).toMatch(/2026-02-31/);
  });
});

