// End-to-end: the built Mini App (apps/miniapp/dist) in jsdom, talking to the Worker (`npm run dev`, TEST_MODE) on :8787.
// Run: `npm run dev` (root) in one terminal, then `npm run e2e -w apps/miniapp` (builds dist first).
// The Worker's TEST_KEY must equal E2E_TEST_KEY (default "local-test-key", as in apps/worker/.dev.vars.example).
// Exit code 1 if any check fails.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
const BASE = process.env.E2E_BASE || "http://localhost:8787";
const KEY = process.env.E2E_TEST_KEY || "local-test-key";
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8").replace(/<script[^>]*telegram-web-app[^>]*><\/script>/, "").replace(/<script type="module"[^>]*><\/script>/, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const jsFile = fs.readdirSync(path.join(DIST, "assets")).find(f => f.endsWith(".js"));
const js = fs.readFileSync(path.join(DIST, "assets", jsFile), "utf8");
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); };

function open(testUser, name) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: `${BASE}/?testUser=${testUser}&testName=${encodeURIComponent(name)}&testKey=${encodeURIComponent(KEY)}`, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  w.matchMedia = q => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.animate = function () { return { finished: Promise.resolve() }; };
  w.fetch = (u, o) => fetch(new URL(u, BASE), o);
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => randomUUID();
  w.addEventListener("error", e => errors.push(e.message));
  w.eval(js.replace(/import\.meta/g, "({})"));
  const d = w.document;
  const api = {
    w, d, errors,
    text: () => (d.getElementById("app").textContent + " " + d.getElementById("layer").textContent).replace(/\s+/g, " "),
    q: s => d.querySelector(s),
    click: s => { const el = typeof s === "string" ? d.querySelector(s) : s; if (!el) throw new Error("missing " + s); el.click(); },
    act: (name, attrs = "") => { const el = d.querySelector(`[data-act="${name}"]${attrs}`); if (!el) throw new Error("missing act " + name + attrs); el.click(); },
    toasts: () => [...d.querySelectorAll(".toast")].map(t => t.textContent).join(" | "),
    until: async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(100); } return false; },
    closeModals: async () => { for (let i = 0; i < 6; i++) { const b = d.getElementById("mBtn"); if (b) { b.click(); await wait(80); } else await wait(80); } },
  };
  return api;
}
// Owner tab: with «Склад» on (STOCK_ENABLED) Правила / Команда / Журнал live in «Ещё».
const ownerTab = (x, name) => { if (x.q(`[data-act="otab"][data-tab="${name}"]`)) x.act("otab", `[data-tab="${name}"]`); else { x.act("stMore"); x.act("stMoreGo", `[data-tab="${name}"]`); } };
const curl = (user, method, p, body) => fetch(BASE + p, { method, headers: { "X-Test-User": String(user), "X-Test-Key": KEY, "X-Test-Name": "Curl", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  const A = 900000000 + Math.floor(Math.random() * 99999999), B = A + 1;
  // ---------- setup: the local D1 persists between runs — reset the test clock and level-1 cashback to 1% ----------
  {
    const admin = A + 2;
    await curl(admin, "POST", "/api/test/role", { role: "owner" });
    await curl(admin, "POST", "/api/test/clock", { reset: true });
    const rules = (await curl(admin, "GET", "/api/owner/rules")).body;
    const pcts = [1, 3, 5];
    if (rules.levels.some((l, i) => l.pct !== pcts[i])) { rules.levels.forEach((l, i) => { l.pct = pcts[i] ?? l.pct; }); const r = await curl(admin, "PUT", "/api/owner/rules", rules); if (r.status !== 200) throw new Error("setup: rules reset failed " + JSON.stringify(r.body)); }
    await curl(admin, "POST", "/api/test/role", { role: "client" });
  }
  // ---------- client A registers in the browser ----------
  const ca = open(A, "Дилноза");
  check("client: onboarding shown", await ca.until(() => ca.text().includes("Медовая карта Honey Flowers")), ca.text().slice(0, 80));
  // Д1: «Как работает» bullets + the two texts + «Принимаю» before registering
  check("consent: bullets from the rules", await ca.until(() => ca.text().includes("Как работает Медовая карта") && ca.text().includes("15 000") && ca.text().includes("180 дней")), ca.text().slice(0, 300));
  check("consent: register disabled until «Принимаю»", ca.q('[data-act="testRegister"]')?.disabled === true, "");
  check("brand: logo on onboarding", !!ca.q('img.logo[src="/brand/honey-logo.webp"]'), "");
  ca.act("openLegal", '[data-page="rules"]');
  check("consent: rules page with placeholders and the draft banner", await ca.until(() => ca.text().includes("Правила программы лояльности") && ca.text().includes("[ФИО ИП]") && ca.text().includes("Черновик")), ca.text().slice(0, 200));
  ca.act("closeLegal"); await ca.until(() => ca.q("#consentCheck"));
  ca.act("openLegal", '[data-page="consent"]');
  check("consent: personal data page", await ca.until(() => ca.text().includes("Согласие на обработку персональных данных") && ca.text().includes("[ИНН]")), ca.text().slice(0, 200));
  ca.act("closeLegal"); await ca.until(() => ca.q("#consentCheck"));
  const cb = ca.q("#consentCheck"); cb.checked = true; cb.dispatchEvent(new ca.w.Event("change", { bubbles: true }));
  await ca.until(() => ca.q('[data-act="testRegister"]') && !ca.q('[data-act="testRegister"]').disabled);
  ca.q("#regPhone").value = "+998 90 123 45 " + String(A).slice(-2);
  ca.act("testRegister");
  check("client: registered, home with honeycomb", await ca.until(() => ca.text().includes("Привет, Дилноза") && ca.q("#comb")), ca.text().slice(0, 140));
  check("client: welcome bonus 15 000 shown", /15\s?000/.test(ca.q("#balN")?.textContent || ""), ca.q("#balN")?.textContent);
  check("consent: stored with the card", (await curl(A, "GET", "/api/me")).body.consent.required === false, "");
  check("client: honey timer always shown", ca.text().includes("Мёд сгорит") || ca.text().includes("Мёд сгорает"), ca.q(".timers")?.textContent);
  check("client: level rule shown", ca.text().includes("Уровень сохраняется"), ca.q(".timers")?.textContent);
  check("client: count-based progress", ca.text().includes("ещё 3 покупки"), ca.q(".prog")?.textContent);
  // Л6: optional birthday right after registration
  check("birthday: asked on home", !!ca.q("#bdayInput"), "");
  ca.q("#bdayInput").value = "1994-05-17"; ca.act("saveBirthday");
  check("birthday: saved once", await ca.until(() => ca.toasts().includes("Сохранено") && !ca.q(".bday-card")), ca.toasts());
  ca.act("tab", '[data-tab="card"]'); await wait(50);
  check("client: real QR rendered", !!ca.q(".qr svg rect, .qr svg path"), "");
  const code = ca.q(".code")?.textContent.trim();
  check("client: card code", /^HF\d+/.test(code || ""), code);
  ca.act("tab", '[data-tab="home"]'); await wait(50);

  // ---------- staff B: switch role in the test panel, find A by phone, charge ----------
  const sb = open(B, "Малика");
  await sb.until(() => sb.text().includes("Медовая карта"));
  // B has no client profile — onboarding view, test FAB available
  sb.act("openTest"); await wait(50);
  sb.act("testRole", '[data-role="florist"]');
  check("staff: florist screen after role switch", await sb.until(() => sb.text().includes("Начислить покупку")), sb.text().slice(0, 120));
  sb.q("#q").value = code; sb.act("search");
  check("staff: client found by code", await sb.until(() => sb.text().includes("Дилноза") && sb.q(".pad")), sb.text().slice(0, 160));
  // F1: picking from the matches list must open the client (lookup by id)
  { const me0 = (await curl(A, "GET", "/api/me")).body; const byId = await curl(B, "GET", "/api/staff/client?q=" + me0.client.id); check("staff: lookup by client id works", !!byId.body?.client && byId.body.client.id === me0.client.id, JSON.stringify(byId.body).slice(0, 120)); }
  for (const k of ["3", "5", "0", "000"]) sb.act("key", `[data-k="${k}"]`);
  check("staff: preview computed", await sb.until(() => sb.text().includes("Кешбэк 1%") && sb.text().includes("+3 500")), sb.text().match(/К оплате[^]*?Начислить/)?.[0]);
  sb.act("charge");
  check("staff: done screen", await sb.until(() => sb.text().includes("Начислено")), sb.toasts() || sb.text().slice(0, 200));

  // ---------- client A sees it live (polling) ----------
  check("client: live update balance 15 000 + 3 500", await ca.until(() => /18\s?500/.test(ca.q("#balN")?.textContent || ""), 10000), ca.q("#balN")?.textContent);

  // two more purchases via UI → 3rd cell gift
  for (let i = 0; i < 2; i++) {
    sb.act("nextBuy"); await wait(30);
    sb.q("#q").value = code; sb.act("search");
    await sb.until(() => sb.q(".pad"));
    for (const k of ["2", "0", "0", "000"]) sb.act("key", `[data-k="${k}"]`);
    await sb.until(() => sb.text().includes("Кешбэк"));
    if (i === 0) {
      // daily cell limit: the 2nd purchase on the same day must not fill a cell
      check("staff: daily limit shown in preview", sb.text().includes("сегодня уже была покупка"), sb.text().match(/Соты[^.]*|Ячейка[^.]*/)?.[0]);
    }
    sb.act("charge"); await sb.until(() => sb.text().includes("Начислено"));
  }
  // move clock to next days so cells count: use test clock +1 day and buy
  await curl(B, "POST", "/api/test/clock", { days: 1 });
  sb.act("nextBuy"); await wait(30);
  sb.q("#q").value = code; sb.act("search"); await sb.until(() => sb.q(".pad"));
  for (const k of ["2", "0", "0", "000"]) sb.act("key", `[data-k="${k}"]`);
  await sb.until(() => sb.text().includes("ячейка 2"));
  sb.act("charge"); await sb.until(() => sb.text().includes("Начислено"));
  await curl(B, "POST", "/api/test/clock", { days: 1 });
  sb.act("nextBuy"); await wait(30);
  sb.q("#q").value = code; sb.act("search"); await sb.until(() => sb.q(".pad"));
  for (const k of ["2", "0", "0", "000"]) sb.act("key", `[data-k="${k}"]`);
  check("staff: gift announced in preview for cell 3", await sb.until(() => sb.text().includes("ячейка 3") && sb.text().includes("откроется подарок")), sb.text().match(/Соты[^]*?Начислить/)?.[0]);
  sb.act("charge"); await sb.until(() => sb.text().includes("Начислено"));
  check("staff: result mentions gift", sb.text().includes("открыт подарок"), sb.text().match(/\+[^]*?Баланс/)?.[0]);
  const giftModal = await ca.until(() => ca.text().includes("Сюрприз в 3-й ячейке"), 12000);
  check("client: gift reveal modal appears live", giftModal, ca.text().slice(0, 200));
  await ca.closeModals();
  ca.act("tab", '[data-tab="gifts"]'); await wait(50);
  check("client: gift listed", ca.text().includes("Открытка в подарок"), ca.text().slice(0, 160));
  ca.act("tab", '[data-tab="home"]'); await wait(50);
  check("level: Королева улья after 3 purchase days, kept until …", await ca.until(() => ca.text().includes("Королева улья") && ca.text().includes("Уровень сохранится до"), 8000), ca.q(".timers")?.textContent);

  // ---------- reversal + double reversal ----------
  sb.act("askReverse"); await wait(50);
  sb.click('[data-reason="Ошибка в сумме"]'); sb.click("#revYes");
  check("staff: reversal ok", await sb.until(() => sb.toasts().includes("Покупка отменена")), sb.toasts());
  const ops = await curl(B, "GET", "/api/staff/recent");
  const reversed = ops.body.find(o => o.status === "reversed");
  const again = await curl(B, "POST", `/api/staff/purchase/${reversed.purchaseId}/reverse`, { reason: "повтор" });
  check("edge: second reversal rejected", again.status === 409, JSON.stringify(again.body));

  // ---------- idempotency ----------
  const me = (await curl(A, "GET", "/api/me")).body;
  const req = { clientId: me.client.id, amount: 150000, redeem: false, idempotencyKey: "fixed-key-" + A };
  const p1 = await curl(B, "POST", "/api/staff/purchase", req), p2 = await curl(B, "POST", "/api/staff/purchase", req);
  check("edge: replay returns same purchase", p1.body.purchaseId === p2.body.purchaseId && p2.body.replayed === true, `${p1.status}/${p2.status}`);
  const bad = await curl(B, "POST", "/api/staff/purchase", { ...req, idempotencyKey: "neg-" + A, amount: -5 });
  check("edge: negative amount rejected", bad.status === 400, JSON.stringify(bad.body));
  const asClient = await curl(A, "POST", "/api/staff/purchase", { ...req, idempotencyKey: "cl-" + A });
  check("edge: client cannot charge", asClient.status === 403, String(asClient.status));

  // ---------- redeem ----------
  const meR = (await curl(A, "GET", "/api/me")).body;
  const pv = await curl(B, "POST", "/api/staff/purchase/preview", { clientId: meR.client.id, amount: 20000, redeem: true });
  check("edge: redeem capped at 50%", pv.body.redeemed <= 10000 && pv.body.paid === 20000 - pv.body.redeemed - pv.body.discount, JSON.stringify(pv.body));

  // ---------- owner ----------
  sb.act("openTest"); await wait(30); sb.act("testRole", '[data-role="owner"]');
  check("owner: stats", await sb.until(() => sb.text().includes("участников")), sb.text().slice(0, 160));
  ownerTab(sb, "rules");
  await sb.until(() => sb.q('[data-key="lvpct"][data-i="0"]'));
  check("owner: rules switches shown", !!sb.q("#r-levelMode") && !!sb.q("#r-staffCanReverse") && !!sb.q("#r-birthdayEnabled") && sb.text().includes("от, покупок"), "");
  const inp = sb.q('[data-key="lvpct"][data-i="1"]'); inp.value = "4"; inp.dispatchEvent(new sb.w.Event("change", { bubbles: true }));
  await wait(30); sb.act("saveRules");
  check("owner: rules saved", await sb.until(() => sb.toasts().includes("Правила сохранены")), sb.toasts());
  await curl(B, "POST", "/api/test/clock", { days: 1 });
  const pv2 = await curl(B, "POST", "/api/staff/purchase/preview", { clientId: meR.client.id, amount: 100000, redeem: false });
  check("owner: new pct applies to next purchase", pv2.body.pct === 4 && pv2.body.cashback === 4000, JSON.stringify(pv2.body));
  ownerTab(sb, "staff"); await sb.until(() => sb.q("#newStaff"));
  sb.q("#newStaff").value = "+998 91 555 44 33"; sb.act("addStaff");
  check("owner: staff added", await sb.until(() => sb.toasts().includes("Сотрудник добавлен")), sb.toasts());
  ownerTab(sb, "ops");
  check("owner: ops log", await sb.until(() => sb.text().includes("Журнал операций") && sb.text().includes("отменена")), sb.text().slice(0, 200));

  // ---------- owner: client base («Клиенты») ----------
  sb.act("otab", '[data-tab="clients"]');
  check("clients: tab with list", await sb.until(() => sb.text().includes("Клиенты") && sb.text().includes("Дилноза") && sb.q('[data-act="openClient"]')), sb.text().slice(0, 200));
  sb.act("clientStatus", '[data-status="lost"]');
  check("clients: filter «Потерянные» hides an active client", await sb.until(() => sb.q('[data-status="lost"][aria-pressed="true"]') && !sb.text().includes("Загрузка") && !sb.text().includes("Дилноза")), sb.text().slice(0, 200));
  sb.act("clientStatus", '[data-status="active"]');
  check("clients: filter «Активные» shows her", await sb.until(() => sb.text().includes("Дилноза")), sb.text().slice(0, 200));
  sb.act("clientStatus", '[data-status=""]');
  const cq = sb.q("#cq"); cq.focus(); cq.value = code; cq.dispatchEvent(new sb.w.Event("input", { bubbles: true }));
  check("clients: search by code → one row, input kept", await sb.until(() => sb.d.querySelectorAll('[data-act="openClient"]').length === 1 && sb.text().includes(code)) && sb.q("#cq")?.value === code, sb.text().slice(0, 200));
  sb.act("openClient");
  check("clients: card opened (phone, history, honeycomb)", await sb.until(() => sb.text().includes("Скорректировать мёд") && sb.text().includes("+99890123") && sb.q("#comb") && sb.text().includes("История")), sb.text().slice(0, 240));
  const balBefore = (await curl(A, "GET", "/api/me")).body.client.balance;
  sb.act("openAdjust"); await wait(50);
  for (const k of ["1", "000"]) sb.click(`#layer .pad [data-k="${k}"]`);
  sb.click('#layer [data-reason="Компенсация"]');
  check("adjust: sheet shows +1 000", /\+1\s000/.test(sb.q("#adjAmt")?.textContent || ""), sb.q("#adjAmt")?.textContent);
  sb.click("#adjYes");
  check("adjust: toast and new balance on the card", await sb.until(() => sb.toasts().includes("Мёд скорректирован") && (sb.q("#cardBal")?.textContent || "").replace(/\s/g, "").startsWith(String(balBefore + 1000))), sb.toasts() + " / " + sb.q("#cardBal")?.textContent);
  const meAdj = (await curl(A, "GET", "/api/me")).body;
  check("adjust: client balance +1000 with reason in history", meAdj.client.balance === balBefore + 1000 && meAdj.client.history.some(h => h.kind === "manual" && h.reason === "Компенсация"), JSON.stringify(meAdj.client.history[0]));
  const note = sb.q("#cnote"); note.value = "Любит пионы; звонить после 18:00"; note.dispatchEvent(new sb.w.Event("input", { bubbles: true }));
  sb.act("saveNote");
  check("note: saved", await sb.until(() => sb.toasts().includes("Заметка сохранена")), sb.toasts());
  const card = await curl(B, "GET", `/api/owner/clients/${meAdj.client.id}`);
  check("note: stored on the server", card.body?.note === "Любит пионы; звонить после 18:00", JSON.stringify(card.body?.note));
  sb.act("closeClient");
  check("clients: back to the list", await sb.until(() => sb.q("#cq") && !sb.q("#cnote")), sb.text().slice(0, 120));
  sb.act("openExport"); await wait(50);
  sb.click("#expClients");
  check("export: clients link created", await sb.until(() => /\/api\/owner\/export\/clients\.csv\?token=[0-9a-f]+$/.test(sb.q("#expUrl")?.value || "")), sb.q("#expUrl")?.value || sb.toasts());
  const file = await fetch(sb.q("#expUrl").value);
  const bytes = new Uint8Array(await file.arrayBuffer());
  check("export: link downloads a CSV with BOM", file.status === 200 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && new TextDecoder().decode(bytes).includes(code), String(file.status));
  check("export: link is one-time", (await fetch(sb.q("#expUrl").value)).status === 410, "");
  sb.click("#expOps");
  check("export: operations link created", await sb.until(() => /operations\.csv\?token=/.test(sb.q("#expUrl")?.value || "")), sb.q("#expUrl")?.value);
  sb.click("#sheetBg"); await wait(30);
  sb.act("openClient"); await sb.until(() => sb.q('[data-act="chargeClient"]'));
  sb.act("chargeClient");
  check("clients: «Начислить покупку» opens the cash desk with the client", await sb.until(() => sb.q(".pad") && sb.text().includes("Дилноза") && sb.q('[data-tab="desk"][aria-current="page"]')), sb.text().slice(0, 160));
  sb.act("backToFind"); await wait(30);

  // ---------- Л9: credit by phone for a client not in the bot ----------
  sb.act("otab", '[data-tab="desk"]'); await sb.until(() => sb.q("#q"));
  const newPhone = "+99893" + String(A).slice(-7);
  sb.q("#q").value = newPhone; sb.act("search");
  check("phone credit: offered for an unknown full number", await sb.until(() => !!sb.q('[data-act="creditPhone"]')), sb.text().slice(0, 200));
  sb.act("creditPhone");
  check("phone credit: card opened, marked «ещё не в боте»", await sb.until(() => sb.q(".pad") && sb.text().includes("ещё не в боте")), sb.text().slice(0, 200));
  for (const k of ["1", "0", "0", "000"]) sb.act("key", `[data-k="${k}"]`);
  await sb.until(() => sb.text().includes("Кешбэк"));
  sb.act("charge");
  check("phone credit: purchase accrued", await sb.until(() => sb.text().includes("Начислено")), sb.toasts());
  const claimer = A + 5;
  const reg = await curl(claimer, "POST", "/api/test/register", { consent: true, phone: newPhone, name: "Позже в боте" });
  check("phone credit: claimed with accruals + welcome bonus", reg.status === 201 && reg.body.client.balance === 1000 + 15000, `${reg.status} ${JSON.stringify(reg.body?.client?.balance)}`);
  sb.act("nextBuy"); await wait(30);

  // ---------- expiry (мёд lives 180 days; a separate timer from the level) ----------
  await curl(B, "POST", "/api/test/clock", { days: 170 });
  const ex1 = await curl(B, "POST", "/api/test/run-expiry");
  await curl(B, "POST", "/api/test/clock", { days: 15 });
  const ex2 = await curl(B, "POST", "/api/test/run-expiry");
  const after = (await curl(A, "GET", "/api/me")).body;
  check("expiry: warned then burned", ex1.body.warned >= 1 && ex2.body.expired >= 1 && after.client.balance === 0, `${JSON.stringify(ex1.body)} ${JSON.stringify(ex2.body)} bal=${after.client.balance}`);
  check("client: expire in history", after.client.history.some(h => h.kind === "expire"), "");
  await curl(B, "POST", "/api/test/clock", { reset: true });

  // ---------- language ----------
  ca.act("tab", '[data-tab="profile"]'); await wait(50); ca.act("lang", '[data-l="uz"]');
  check("client: uz language", await ca.until(() => ca.text().includes("Tarix")), ca.text().slice(0, 100));
  const meLang = (await curl(A, "GET", "/api/me")).body;
  check("client: language saved on server", meLang.client.lang === "uz", meLang.client.lang);

  check("no JS errors (client)", ca.errors.length === 0, ca.errors.join("; "));
  check("no JS errors (staff)", sb.errors.length === 0, sb.errors.join("; "));
  for (const r of results) console.log(r[0], "-", r[1], r[0] === "FAIL" ? "→ " + r[2] : "");
  console.log(results.filter(r => r[0] === "PASS").length + "/" + results.length + " passed");
  process.exit(results.some(r => r[0] === "FAIL") ? 1 : 0);
})().catch(e => { console.error("CRASH", e); for (const r of results) console.log(r[0], "-", r[1], r[0] === "FAIL" ? "→ " + r[2] : ""); process.exit(1); });
