#!/usr/bin/env node
// QA suite entry: `npm run qa` (all areas) or `npm run qa -- --only=scenarios,fuzz`.
// Starts its own Worker on :8797 (QA_PORT) with a FRESH local D1 in qa/.run/, unless BASE points
// to an already running QA worker. Options:
//   --only=a,b       areas: scenarios, clients, console, concurrency, fuzz, model, security, scale, miniapp
//   --seed=N         seed of the randomized model test (default: random, printed)
//   --ops=N --clients=N   size of the model test (default 3000 / 200)
//   --scale-clients=N --scale-ops=N   size of the scale test (default 2000 / 20000)
//   --keep           keep qa/.run/d1-* after the run
import fs from 'node:fs';
import path from 'node:path';
import { ctx, infraErrors, serverErrors, shapeErrors } from './lib/api.mjs';
import { area, printSummary, note } from './lib/report.mjs';
import { RUN_DIR, restartWorker, startWorker, stopFakeTelegram, stopWorker, worker } from './lib/worker.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ALL = ['scenarios', 'clients', 'console', 'concurrency', 'fuzz', 'model', 'security', 'scale', 'miniapp'];
const only = args.only ? String(args.only).split(',') : ALL;
const extra = {};

async function section(name, fn) {
  if (!only.includes(name)) return;
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    const out = await fn();
    if (out) extra[name] = out;
  } catch (e) {
    area(name).check(`${name} crashed`, false, e.stack || String(e));
    console.log('  worker log tail:\n' + worker.log.join('').slice(-2500));
  }
  console.log(`  ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

const t0 = Date.now();
try {
  if (only.includes('miniapp')) {
    // Build BEFORE wrangler starts: wrangler dev reloads when the assets directory changes.
    const { spawnSync } = await import('node:child_process');
    const b = spawnSync('npm', ['run', 'build', '-w', 'apps/miniapp'], { cwd: path.join(RUN_DIR, '..', '..'), encoding: 'utf8' });
    area('mini app e2e').check('mini app builds', b.status === 0, (b.stdout + b.stderr).slice(-500));
  }
  ctx.base = await startWorker({ fresh: true });
  console.log(`QA worker: ${ctx.base} (D1: ${worker.persist ?? 'external'})`);
  await section('scenarios', async () => (await import('./suites/scenarios.mjs')).run());
  await section('clients', async () => (await import('./suites/clientsList.mjs')).run());
  await section('console', async () => (await import('./suites/console.mjs')).run());
  await section('concurrency', async () => (await import('./suites/concurrency.mjs')).run());
  await section('fuzz', async () => (await import('./suites/fuzz.mjs')).run());
  await section('model', async () => (await import('./suites/model.mjs')).run({ seed: args.seed ? Number(args.seed) : undefined, ops: Number(args.ops || 3000), clients: Number(args.clients || 200) }));
  await section('security', async () => (await import('./suites/security.mjs')).run());
  await section('scale', async () => (await import('./suites/scale.mjs')).run({ clients: Number(args['scale-clients'] || 2000), ops: Number(args['scale-ops'] || 20000) }));
  await section('miniapp', async () => (await import('./suites/miniapp.mjs')).run());
} finally {
  const g = area('global: no 5xx / error contract');
  g.check('no 5xx responses in the whole run', serverErrors.length === 0, serverErrors.slice(0, 10));
  g.check('every API error is { error: { code, message } } with a Russian message and no stack trace', shapeErrors.length === 0, shapeErrors.slice(0, 10));
  if (infraErrors.length) note('infra', `${infraErrors.length} request(s) failed inside the local runtime (miniflare "Network connection lost", not Worker code): ${JSON.stringify(infraErrors.slice(0, 2))}`);
  if (worker.proc) {
    const log = worker.log.join('');
    const crashes = log.match(/internal error[^\n]*/g) ?? [];
    if (crashes.length) note('log', `worker logged ${crashes.length} "internal error" lines, e.g. ${crashes[0].slice(0, 200)}`);
  }
  await stopWorker();
  stopFakeTelegram();
  if (!args.keep && worker.persist && fs.existsSync(worker.persist)) fs.rmSync(worker.persist, { recursive: true, force: true });
  const ok = printSummary({ seconds: Math.round((Date.now() - t0) / 1000), ...extra });
  console.log(`\nreport: ${path.join(path.dirname(RUN_DIR), '.out', 'report.json')}  (${Math.round((Date.now() - t0) / 1000)} s)`);
  // exit explicitly: nothing (sockets, timers of jsdom windows) may keep the runner alive
  process.exit(ok ? 0 : 1);
}
void restartWorker;
