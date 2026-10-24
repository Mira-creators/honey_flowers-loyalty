import type { ExportLinkDTO, MeDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Repository } from '../src/db/d1Repository.js';
import { call, json, makeStaff, mockTelegram, register, repo, resetDb, T } from './helpers.js';
import app from '../src/app.js';
import { testEnv } from './helpers.js';

/** QA low L1: one-time export links. */

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

describe('L1: a one-time export link opened on the wrong export path is not consumed', () => {
  it('clients link on /operations.csv → 410, then on /clients.csv → 200 (once)', async () => {
    const link = await json<ExportLinkDTO>(call('/api/owner/export/link', { user: OWNER, body: { kind: 'clients' } }));
    const wrong = link.url.replace('/clients.csv', '/operations.csv');
    expect((await open(wrong)).status).toBe(410);
    expect((await open(link.url.replace('/clients.csv', '/nonsense.csv'))).status).toBe(410);
    const ok = await open(link.url);
    expect(ok.status).toBe(200);
    await ok.text();
    expect((await open(link.url)).status).toBe(410); // still one-time
  });
});

