// Pass/fail bookkeeping per area + findings, printed at the end and written to qa/.out/report.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './worker.mjs';

export const areas = new Map();
export const notes = [];

export function area(name) {
  if (!areas.has(name)) areas.set(name, { pass: 0, fail: 0, failures: [] });
  const a = areas.get(name);
  return {
    check(label, ok, detail = '') {
      if (ok) a.pass++;
      else {
        a.fail++;
        a.failures.push({ label, detail: typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600) });
        if (process.env.QA_VERBOSE !== '0') console.log(`  FAIL [${name}] ${label}${detail ? ' → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''}`);
      }
      return ok;
    },
    eq(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      return this.check(label, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
  };
}

export function note(kind, text) {
  notes.push({ kind, text });
}

export function printSummary(extra = {}) {
  const rows = [...areas].map(([n, a]) => ({ area: n, pass: a.pass, fail: a.fail }));
  console.log('\n================ QA summary ================');
  for (const r of rows) console.log(`${r.fail ? (r.area.startsWith('open ') ? 'OPEN' : 'FAIL') : 'ok  '}  ${r.area.padEnd(28)} pass ${String(r.pass).padStart(5)}  fail ${String(r.fail).padStart(4)}`);
  for (const [n, a] of areas) for (const f of a.failures.slice(0, 15)) console.log(`  - [${n}] ${f.label}: ${f.detail.slice(0, 240)}`);
  if (notes.length) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  (${n.kind}) ${n.text}`);
  }
  const out = path.join(ROOT, 'qa', '.out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ at: new Date().toISOString(), areas: Object.fromEntries(areas), notes, ...extra }, null, 2));
  // "open …" areas list known open issues (business / config decisions): reported, not a red build.
  return rows.every((r) => r.fail === 0 || r.area.startsWith('open '));
}
