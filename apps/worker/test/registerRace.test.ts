import type { ExportLinkDTO, MeDTO } from '@honey/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Repository } from '../src/db/d1Repository.js';
import { call, json, makeStaff, mockTelegram, register, repo, resetDb, T } from './helpers.js';
import app from '../src/app.js';
import { testEnv } from './helpers.js';

/** QA low L4: concurrent registration of the same user. */

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

describe('L4: a concurrent double registration of the same user is idempotent', () => {
  it('the second request (which lost the insert race) returns the same client, not "phone belongs to another account"', async () => {
    const me = await register(T + 50, '+998901234560', 'Анна');
    // Replay the race: the second request did not see the client yet and its insert hits the unique key.
    const orig = D1Repository.prototype.findClientByTelegramId;
    let first = true;
    vi.spyOn(D1Repository.prototype, 'findClientByTelegramId').mockImplementation(function (this: D1Repository, id: number) {
      if (first && id === T + 50) {
        first = false;
        return Promise.resolve(null);
      }
      return orig.call(this, id);
    });
    const r = await call('/api/test/register', { user: T + 50, body: { phone: '+998901234560', name: 'Анна' } });
    expect(r.status).toBe(201);
    expect((await json<MeDTO>(r)).client!.id).toBe(me.client!.id);
    expect(Number((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM clients').first<{ n: number }>())!.n)).toBe(1);
  });

  it('20 parallel registrations of one user: all succeed with one client', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => call('/api/test/register', { user: T + 60, body: { phone: '+998901234561', name: 'Двойник' } })));
    expect(rs.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(Number((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM clients').first<{ n: number }>())!.n)).toBe(1);
    void repo;
  });
});
