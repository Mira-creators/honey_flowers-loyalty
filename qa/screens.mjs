#!/usr/bin/env node
// Phone screens pass (C2): opens the built Mini App in real Chrome at phone sizes, light and dark,
// walks every tab of every role, saves screenshots and flags layout problems automatically.
//
//   1. npm run build -w apps/miniapp && npm run dev          (local Worker with TEST_MODE, :8787)
//   2. npm i --no-save playwright-core                      (once; uses the Chrome/Edge already installed)
//   3. node qa/screens.mjs [--base=http://127.0.0.1:8787] [--key=local-test-key] [--sizes=se,iphone,android]
//      [--themes=light,dark] [--demo]                       (--demo: fill demo clients and stock first)
//
// Never point --base at the polygon: the run registers users and moves nothing else, but the polygon
// shares the D1 limit of the account. Output: qa/.out/screens/<size>-<theme>/<NN-role-screen>.png
// and qa/.out/screens/report.json (+ a short summary on stdout). Exit code 1 if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const BASE = String(args.base || 'http://127.0.0.1:8787');
const KEY = String(args.key || 'local-test-key');
if (/workers\.dev|honeyflowers/.test(BASE) && !args.force) {
  console.error('Refusing to run against a deployed Worker (shared D1 limit). Use a local `npm run dev` or pass --force.');
  process.exit(2);
}

const SIZES = {
  se: { width: 375, height: 667, deviceScaleFactor: 2, label: 'iPhone SE' },
  iphone: { width: 390, height: 844, deviceScaleFactor: 3, label: 'iPhone 14' },
  android: { width: 412, height: 915, deviceScaleFactor: 2.625, label: 'Pixel 7' },
  small: { width: 360, height: 640, deviceScaleFactor: 3, label: 'small Android' },
};
const sizes = String(args.sizes || 'se,iphone,android').split(',');
const themes = String(args.themes || 'light,dark').split(',');
const OUT = path.join(ROOT, 'qa', '.out', 'screens');

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is missing: run `npm i --no-save playwright-core` once.');
  process.exit(2);
}

const api = (user, method, p, body) =>
  fetch(BASE + p, {
    method,
    headers: { 'X-Test-User': String(user), 'X-Test-Key': KEY, 'X-Test-Name': 'Screens', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function launch() {
  const tries = [{ channel: 'chrome' }, { channel: 'msedge' }, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' }];
  for (const t of tries) {
    try { return await chromium.launch({ headless: true, ...t }); } catch { /* next */ }
  }
  throw new Error('No Chrome/Edge found. Install Chrome or set CHROME_PATH.');
}

// ---- automatic checks on the current screen ----
async function inspect(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const issues = [];
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollWidth > vw + 1) issues.push({ kind: 'horizontal-scroll', detail: `page ${doc.scrollWidth}px > viewport ${vw}px` });
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('data-act') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
    for (const el of document.querySelectorAll('button, a, [data-act], input, select, textarea')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) issues.push({ kind: 'off-screen', detail: `${label(el)} [${Math.round(r.left)}..${Math.round(r.right)}]` });
      const clickable = el.matches('button, a, [data-act]') && !el.matches('input[type=checkbox], input[type=radio]');
      if (clickable && (r.height < 32 || r.width < 32)) issues.push({ kind: 'small-tap-target', detail: `${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}` });
      if (el.matches('button') && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') issues.push({ kind: 'clipped-text', detail: label(el) });
    }
    // text overflowing its box (ellipsis is fine, raw overflow is not)
    for (const el of document.querySelectorAll('h1,h2,h3,p,span,div,td,th,label')) {
      if (!visible(el) || el.children.length) continue;
      const s = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && s.overflow === 'visible' && s.whiteSpace === 'nowrap' && el.getBoundingClientRect().right > vw) issues.push({ kind: 'text-overflow', detail: label(el) });
    }
    // English UI words left in a Russian interface
    const txt = document.body.innerText;
    const eng = (txt.match(/\b(undefined|null|NaN|Error|error|Loading|Submit|Cancel|Save)\b/g) || []);
    if (eng.length) issues.push({ kind: 'raw-text', detail: [...new Set(eng)].join(', ') });
    return { issues, title: (document.querySelector('h1,h2,.title')?.textContent || '').trim().slice(0, 60) };
  });
}

const report = { base: BASE, at: new Date().toISOString(), runs: [] };
const browser = await launch();
let shotNo = 0;

async function session(sizeKey, theme, user, name) {
  const size = SIZES[sizeKey];
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.deviceScaleFactor, isMobile: true, hasTouch: true, colorScheme: theme, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const log = { console: [], http: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => log.console.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) log.http.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${BASE}/?testUser=${user}&testName=${encodeURIComponent(name)}&testKey=${encodeURIComponent(KEY)}`);
  await page.waitForTimeout(1200);
  return { ctx, page, log };
}

async function shot(run, s, role, screen) {
  await s.page.waitForTimeout(500);
  const file = `${String(++shotNo).padStart(2, '0')}-${role}-${screen}.png`.replace(/[^\w.\-]+/g, '_');
  const dir = path.join(OUT, `${run.size}-${run.theme}`);
  fs.mkdirSync(dir, { recursive: true });
  await s.page.screenshot({ path: path.join(dir, file), fullPage: true });
  const r = await inspect(s.page);
  const entry = { role, screen, file: path.relative(ROOT, path.join(dir, file)), title: r.title, issues: r.issues, console: s.log.console.splice(0), http: s.log.http.splice(0) };
  run.screens.push(entry);
}

/** Click every tab button of the bottom navigation and shoot each screen. */
async function walkTabs(run, s, role, selector) {
  const keys = await s.page.$$eval(selector, (els) => els.map((e) => [e.getAttribute('data-act'), e.getAttribute('data-tab')]).filter((x) => x[1]));
  for (const [act, k] of keys) {
    const el = await s.page.$(`nav.tabs [data-act="${act}"][data-tab="${k}"]`);
    if (!el) continue;
    await el.click().catch(() => {});
    await s.page.waitForTimeout(700);
    await shot(run, s, role, k);
  }
  return keys;
}

const stamp = Date.now() % 1e7;
if (args.demo) {
  const admin = 970000000 + stamp;
  await api(admin, 'POST', '/api/test/role', { role: 'owner' });
  for (let chunk = 0; chunk < 20; chunk++) {
    const r = await api(admin, 'POST', '/api/test/demo-seed', { chunk });
    if (r.status !== 200) break;
  }
  for (let chunk = 0; chunk < 20; chunk++) {
    const r = await api(admin, 'POST', '/api/test/demo-stock', { chunk });
    if (r.status !== 200) break;
  }
}

for (const sizeKey of sizes) {
  for (const theme of themes) {
    shotNo = 0;
    const run = { size: sizeKey, device: SIZES[sizeKey].label, theme, screens: [] };
    report.runs.push(run);
    const base = 980000000 + stamp * 10 + report.runs.length * 3;

    // client: onboarding → rules → consent → register → tabs
    const c = await session(sizeKey, theme, base, 'Дилноза');
    await shot(run, c, 'client', 'onboarding');
    if (await c.page.$('[data-act="openLegal"][data-page="rules"]')) {
      await c.page.click('[data-act="openLegal"][data-page="rules"]');
      await shot(run, c, 'client', 'legal-rules');
      await c.page.click('[data-act="closeLegal"]').catch(() => {});
    }
    if (await c.page.$('#consentCheck')) {
      await c.page.check('#consentCheck');
      await c.page.fill('#regPhone', `+998 90 ${String(base).slice(-7, -4)} ${String(base).slice(-4, -2)} ${String(base).slice(-2)}`).catch(() => {});
      await c.page.click('[data-act="testRegister"]').catch(() => {});
      await c.page.waitForTimeout(1500);
    }
    await shot(run, c, 'client', 'home-after-register');
    await walkTabs(run, c, 'client', 'nav.tabs [data-act="tab"]');
    const code = (await api(base, 'GET', '/api/me')).body?.client?.code ?? null;

    // florist: role switch through the API, cashier with the client found
    const f = await session(sizeKey, theme, base + 1, 'Малика');
    await api(base + 1, 'POST', '/api/test/role', { role: 'florist' });
    await f.page.reload(); await f.page.waitForTimeout(1200);
    await shot(run, f, 'florist', 'desk');
    if (code && (await f.page.$('#q'))) {
      await f.page.fill('#q', code);
      await f.page.click('[data-act="search"]').catch(() => {});
      await f.page.waitForTimeout(800);
      for (const k of ['3', '0', '0', '000']) await f.page.click(`[data-act="key"][data-k="${k}"]`).catch(() => {});
      await shot(run, f, 'florist', 'desk-preview');
    }
    await walkTabs(run, f, 'florist', 'nav.tabs [data-act="stTab"], nav.tabs [data-act="otab"]');

    // owner: every tab, then «Ещё» items when the stock nav is on
    const o = await session(sizeKey, theme, base + 2, 'Владелица');
    await api(base + 2, 'POST', '/api/test/role', { role: 'owner' });
    await o.page.reload(); await o.page.waitForTimeout(1200);
    await shot(run, o, 'owner', 'start');
    await walkTabs(run, o, 'owner', 'nav.tabs [data-act="otab"], nav.tabs [data-act="stTab"]');
    if (await o.page.$('[data-act="stMore"]')) {
      await o.page.click('[data-act="stMore"]');
      const more = await o.page.$$eval('[data-act="stMoreGo"]', (els) => els.map((e) => e.getAttribute('data-tab')));
      for (const k of more) {
        if (!(await o.page.$(`[data-act="stMoreGo"][data-tab="${k}"]`))) await o.page.click('[data-act="stMore"]').catch(() => {});
        await o.page.click(`[data-act="stMoreGo"][data-tab="${k}"]`).catch(() => {});
        await shot(run, o, 'owner', `more-${k}`);
      }
    }
    for (const s of [c, f, o]) await s.ctx.close();
  }
}
await browser.close();

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
let bad = 0;
for (const run of report.runs) {
  const flagged = run.screens.filter((s) => s.issues.length || s.console.length || s.http.length);
  bad += flagged.length;
  console.log(`\n${run.device} (${run.size}, ${run.theme}): ${run.screens.length} screens, ${flagged.length} with findings`);
  for (const s of flagged) {
    const parts = [...s.issues.map((i) => `${i.kind}: ${i.detail}`), ...s.console.map((x) => `console: ${x}`), ...s.http.map((x) => `http: ${x}`)];
    console.log(`  ${s.file}\n    ${parts.slice(0, 6).join('\n    ')}${parts.length > 6 ? `\n    … +${parts.length - 6}` : ''}`);
  }
}
console.log(`\nscreenshots: ${path.relative(ROOT, OUT)}  report: ${path.relative(ROOT, path.join(OUT, 'report.json'))}`);
process.exit(bad ? 1 : 0);
