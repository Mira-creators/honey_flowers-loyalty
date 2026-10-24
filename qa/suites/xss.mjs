// Stored XSS probe for the Mini App: user-controlled text (client name from Telegram/registration,
// staff name, owner note, reversal / adjustment reasons) rendered on every screen that shows it.
// Uses the built apps/miniapp/dist in jsdom, the same way as apps/miniapp/test/e2e.js.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { as, ctx, newKey, setRole } from '../lib/api.mjs';
import { area } from '../lib/report.mjs';
import { ROOT } from '../lib/worker.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DIST = path.join(ROOT, 'apps', 'miniapp', 'dist');
const P = (id) => `<img src=x id=${id} onerror=window.__xss=1>`;

function open(testUser, name) {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace(/<script[^>]*telegram-web-app[^>]*><\/script>/, '').replace(/<script type="module"[^>]*><\/script>/, '').replace(/<link rel="stylesheet"[^>]*>/g, '');
  const js = fs.readFileSync(path.join(DIST, 'assets', fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.endsWith('.js'))), 'utf8');
  const dom = new JSDOM(html, { url: `${ctx.base}/?testUser=${testUser}&testName=${encodeURIComponent(name)}&testKey=${encodeURIComponent(ctx.key)}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.animate = function () { return { finished: Promise.resolve() }; };
  w.fetch = (u, o) => fetch(new URL(u, ctx.base), o);
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => randomUUID();
  w.eval(js.replace(/import\.meta/g, '({})'));
  const d = w.document;
  return {
    d, w,
    text: () => (d.getElementById('app').textContent + ' ' + d.getElementById('layer').textContent).replace(/\s+/g, ' '),
    q: (s) => d.querySelector(s),
    act: (n, a = '') => { const el = d.querySelector(`[data-act="${n}"]${a}`); if (!el) throw new Error('missing act ' + n + a); el.click(); },
    until: async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* */ } await wait(100); } return false; },
    injected: () => [...d.querySelectorAll('[id^="xss"]')].map((e) => e.id),
  };
}

export async function run() {
  const s = area('mini app XSS');
  const C = 900_700_001, S = 900_700_002, O = 900_700_003;
  const reg = await as(C).post('/api/test/register', { phone: '+998977700001', name: P('xssName') });
  s.eq('client with an HTML name registered', reg.status, 201);
  const client = reg.body.client;
  await setRole(S, 'florist');
  await setRole(O, 'owner');
  const buy = await as(S).post('/api/staff/purchase', { clientId: client.id, amount: 150_000, redeem: false, idempotencyKey: newKey('x') });
  await as(S).post(`/api/staff/purchase/${buy.body.purchaseId}/reverse`, { reason: P('xssReason') });
  await as(S).post('/api/staff/purchase', { clientId: client.id, amount: 120_000, redeem: false, idempotencyKey: newKey('x') });
  await as(O).post(`/api/owner/clients/${client.id}/adjust`, { points: 1_000, reason: P('xssAdjust') });
  await as(O).put(`/api/owner/clients/${client.id}/note`, { note: P('xssNote') });
  await as(O).post('/api/owner/staff', { phoneOrTelegramId: 'id:5550123', role: 'florist', name: P('xssStaff') });

  const check = (label, app) => {
    const inj = app.injected();
    s.check(`${label}: user text is not rendered as HTML`, inj.length === 0 && !app.w.__xss, inj);
  };

  // client's own screens
  const ca = open(C, 'X');
  s.check('client home rendered', await ca.until(() => ca.q('#comb')), ca.text().slice(0, 120));
  check('client home', ca);
  for (const tab of ['card', 'gifts', 'profile']) {
    try { ca.act('tab', `[data-tab="${tab}"]`); await wait(150); check(`client tab ${tab}`, ca); } catch (e) { s.check(`client tab ${tab} reachable`, false, String(e)); }
  }

  // florist: search the client, recent operations
  const st = open(S, P('xssTesterName'));
  s.check('florist desk rendered', await st.until(() => st.q('#q')), st.text().slice(0, 120));
  await st.until(() => st.text().includes('<img'), 4000);
  check('florist desk (recent operations)', st);
  st.q('#q').value = client.code; st.act('search');
  s.check('florist found the client', await st.until(() => st.q('.pad')), st.text().slice(0, 160));
  check('florist client screen', st);

  // owner: every tab + client card
  const ow = open(O, 'Owner');
  s.check('owner screen rendered', await ow.until(() => ow.q('[data-act="otab"]')), ow.text().slice(0, 120));
  for (const tab of ['stats', 'clients', 'rules', 'staff', 'ops']) {
    ow.act('otab', `[data-tab="${tab}"]`);
    await ow.until(() => !ow.text().includes('Загрузка'), 4000);
    await wait(300);
    check(`owner tab ${tab}`, ow);
  }
  ow.act('otab', '[data-tab="clients"]');
  s.check('owner client list shows the client', await ow.until(() => ow.q('[data-act="openClient"]')), ow.text().slice(0, 160));
  ow.q('#cq').value = client.code; ow.q('#cq').dispatchEvent(new ow.w.Event('input', { bubbles: true }));
  await ow.until(() => ow.d.querySelectorAll('[data-act="openClient"]').length === 1 && ow.q(`[data-act="openClient"][data-id="${client.id}"]`));
  ow.act('openClient', `[data-id="${client.id}"]`);
  s.check('owner client card opened', await ow.until(() => ow.q('#cnote')), ow.text().slice(0, 160));
  await wait(300);
  check('owner client card (name, note, history reasons)', ow);
  s.check('owner client card shows the HTML as text', ow.text().includes('<img src=x id=xssName'), ow.text().slice(0, 200));
  for (const a of [ca, st, ow]) a.w.close(); // stop the apps' polling timers
}
