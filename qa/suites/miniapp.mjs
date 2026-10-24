// Mini App smoke: the existing end-to-end test (apps/miniapp/test/e2e.js, jsdom) against the QA Worker,
// first on a fresh (wiped) database, then again on the same database.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ctx, wipe } from '../lib/api.mjs';
import { area } from '../lib/report.mjs';
import { checkInvariants } from '../lib/invariants.mjs';
import { ROOT } from '../lib/worker.mjs';

/** Async (not spawnSync): the fake Telegram API lives in this process and must keep answering. */
async function e2e() {
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'apps', 'miniapp', 'test', 'e2e.js')], {
      cwd: path.join(ROOT, 'apps', 'miniapp'), env: { ...process.env, E2E_BASE: ctx.base, E2E_TEST_KEY: ctx.key },
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stdout += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
  });
  const out = r.stdout;
  const m = /(\d+)\/(\d+) passed/.exec(out);
  return { code: r.status, out, passed: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : 0 };
}

export async function run() {
  const s = area('mini app e2e');
  await wipe();
  const first = await e2e();
  s.check(`e2e on a fresh DB: ${first.passed}/${first.total}`, first.code === 0 && first.total > 0, first.out.split('\n').filter((l) => /FAIL|CRASH/.test(l)).join(' | ').slice(0, 600));
  const second = await e2e();
  s.check(`e2e again on the same DB: ${second.passed}/${second.total}`, second.code === 0 && second.total > 0, second.out.split('\n').filter((l) => /FAIL|CRASH/.test(l)).join(' | ').slice(0, 600));
  await (await import('./xss.mjs')).run();
  const v = await checkInvariants();
  s.check('invariants after the e2e runs', v.length === 0, v.slice(0, 5));
  return { first: `${first.passed}/${first.total}`, second: `${second.passed}/${second.total}` };
}
