// End-to-end smoke for the briefing features: the built Mini App (apps/miniapp/dist) in jsdom
// against a running Worker in TEST_MODE (default http://localhost:8787, override with E2E_BASE).
//   node test/e2e-demo.js prep   «Моя карта» toggle + registration, self-operation refusal (UI + API)
//   node test/e2e-demo.js demo   test panel: seed demo data with progress → owner client base / card /
//                                stats → grant sheet (honey) + API grants (gift, honey) → clear demo
// Without an argument both phases run. Exit code 1 if any check fails.
// The demo phase seeds ~250 clients and removes them again; run it on a local/dev database only.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BASE = process.env.E2E_BASE || "http://localhost:8787";
const KEY = process.env.E2E_TEST_KEY || "local-test-key";
const PHASE = process.argv[2] || "all";
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8").replace(/<script[^>]*telegram-web-app[^>]*><\/script>/, "").replace(/<script type="module"[^>]*><\/script>/, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const jsFile = fs.readdirSync(path.join(DIST, "assets")).find(f => f.endsWith(".js"));
const js = fs.readFileSync(path.join(DIST, "assets", jsFile), "utf8");
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); console.log(`${ok ? "PASS" : "FAIL"} - ${name} ${ok ? "" : String(extra).slice(0, 300)}`); };

function open(testUser, name) {
  const errors = [];
  const dom = new JSDOM(html, { url: `${BASE}/?testUser=${testUser}&testName=${encodeURIComponent(name)}&testKey=${encodeURIComponent(KEY)}`, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = q => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.animate = function () { return { finished: Promise.resolve() }; };
  w.fetch = (u, o) => fetch(new URL(u, BASE), o);
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => randomUUID();
  w.addEventListener("error", e => errors.push(e.message));
  w.eval(js.replace(/import\.meta/g, "({})"));
  const d = w.document;
  return {
    w, d, errors,
    text: () => (d.getElementById("app").textContent + " " + d.getElementById("layer").textContent).replace(/\s+/g, " "),
    q: s => d.querySelector(s),
    qa: s => [...d.querySelectorAll(s)],
    act: (name, attrs = "") => { const el = d.querySelector(`[data-act="${name}"]${attrs}`); if (!el) throw new Error("missing act " + name + attrs); el.click(); },
    toasts: () => [...d.querySelectorAll(".toast")].map(t => t.textContent).join(" | "),
    type: (sel, v) => { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); },
    until: async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await wait(100); } return false; },
  };
}
const curl = (user, method, p, body, headers = {}) =>
  fetch(BASE + p, { method, headers: { "X-Test-User": String(user), "X-Test-Key": KEY, "X-Test-Name": "Curl", "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const fmtNum = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

async function prep() {
  const OWNER = 900000000 + Math.floor(Math.random() * 99999999), FLORIST = OWNER + 1;
  await curl(OWNER, "POST", "/api/test/role", { role: "owner" });
  await curl(OWNER, "POST", "/api/test/clock", { reset: true });

  // ---------- «Моя карта»: the owner has no client card yet → onboarding → registers → honeycomb ----------
  const o = open(OWNER, "Хозяйка");
  check("owner: owner screens", await o.until(() => o.text().includes("Статистика")), o.text().slice(0, 120));
  check("owner: «Моя карта» toggle visible", !!o.q('[data-act="myCardOn"]'));
  o.act("myCardOn");
  check("my card: onboarding for a staff member without a card", await o.until(() => o.text().includes("Назад к работе") && !!o.q("#regPhone")), o.text().slice(0, 160));
  o.q("#regPhone").value = "+998 93 555 " + String(OWNER).slice(-4, -2) + " " + String(OWNER).slice(-2);
  o.act("testRegister");
  check("my card: registered, honeycomb + QR tab", await o.until(() => o.text().includes("Привет, Хозяйка") && !!o.q("#comb")), o.text().slice(0, 160));
  o.act("tab", '[data-tab="card"]');
  check("my card: QR of the own card", await o.until(() => !!o.q(".qr svg")), "");
  o.act("myCardOff");
  check("my card: «Назад к работе» returns to owner screens", await o.until(() => o.text().includes("Статистика") && !o.text().includes("Назад к работе")), o.text().slice(0, 120));

  // ---------- self-operation: a florist cannot charge their own card ----------
  const phone = "+998 94 777 " + String(FLORIST).slice(-4, -2) + " " + String(FLORIST).slice(-2);
  const reg = await curl(FLORIST, "POST", "/api/test/register", { phone, name: "Нигора" });
  check("florist: registered as a client", reg.status === 201, JSON.stringify(reg.body).slice(0, 120));
  await curl(FLORIST, "POST", "/api/test/role", { role: "florist" });
  const ownId = reg.body.client.id;
  const self = await curl(FLORIST, "POST", "/api/staff/purchase", { clientId: ownId, amount: 200000, redeem: false, idempotencyKey: randomUUID() });
  check("API: own-card purchase → 403 self_operation", self.status === 403 && self.body?.error?.code === "self_operation" && self.body.error.message === "Нельзя проводить покупку на свою карту — попросите коллегу", JSON.stringify(self.body));
  const f = open(FLORIST, "Нигора");
  check("florist: desk", await f.until(() => f.text().includes("Начислить покупку")), f.text().slice(0, 120));
  f.q("#q").value = reg.body.client.code; f.act("search");
  check("florist UI: own card shows the refusal and the charge button is disabled",
    await f.until(() => f.text().includes("Нельзя проводить покупку на свою карту") && f.q('[data-act="charge"]')?.disabled === true), f.text().slice(0, 300));
  for (const k of ["2", "0", "0", "000"]) f.act("key", `[data-k="${k}"]`);
  check("florist UI: preview answers with the self-operation message",
    await f.until(() => f.q(".calc .bad")?.textContent.includes("Нельзя проводить покупку на свою карту")), f.q(".calc")?.textContent);
  check("florist: «Моя карта» toggle on the desk", !!f.q('[data-act="myCardOn"]'));
  check("no JS errors (prep)", o.errors.length + f.errors.length === 0, [...o.errors, ...f.errors].join("; "));
  o.w.close(); f.w.close();
}

async function demo() {
  const OWNER = 900000000 + Math.floor(Math.random() * 99999999);
  await curl(OWNER, "POST", "/api/test/role", { role: "owner" });
  await curl(OWNER, "POST", "/api/test/clock", { reset: true });
  const o = open(OWNER, "Владелец");
  await o.until(() => o.text().includes("Статистика"));

  // ---------- test panel: «Заполнить демо-данными» with progress ----------
  o.act("openTest");
  check("test panel: demo buttons", await o.until(() => !!o.q('[data-act="demoSeed"]') && !!o.q('[data-act="demoClear"]')), o.text().slice(-400));
  const seen = new Set();
  const t0 = Date.now();
  o.act("demoSeed");
  const done = await o.until(() => { const t = o.q("#demoTxt")?.textContent; if (t) seen.add(t); return o.toasts().includes("Готово: 250"); }, 180000);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check(`test panel: seeding finished (${secs}s)`, done, o.toasts());
  check("test panel: progress «Заполняю… N/250» shown and growing", [...seen].some(t => /^Заполняю… \d+\/250$/.test(t)) && seen.size >= 5, [...seen].slice(0, 5).join(", "));

  // ---------- owner numbers ----------
  const stats = (await curl(OWNER, "GET", "/api/owner/stats")).body;
  check("stats: >= 250 clients, purchases, revenue, мёд burned and spent",
    stats.clients >= 250 && stats.purchases > 600 && stats.revenueWithCard > 100_000_000 && stats.points.expired > 0 && stats.points.redeemed > 0 && stats.giftsUsed > 0, JSON.stringify(stats));
  console.log("  stats:", JSON.stringify({ clients: stats.clients, purchases: stats.purchases, purchases7d: stats.purchases7d, revenue: stats.revenueWithCard, repeat90d: stats.repeatRate90d, points: stats.points, giftsUnlocked: stats.giftsUnlocked, giftsUsed: stats.giftsUsed, perWeek: stats.perWeek.map(w => w.purchases) }));
  const dist = {};
  for (const st of ["active", "sleeping", "lost", "expiring"]) {
    let n = 0, cursor = null;
    do { const p = (await curl(OWNER, "GET", `/api/owner/clients?status=${st}&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`)).body; n += p.items.length; cursor = p.nextCursor; } while (cursor);
    dist[st] = n;
  }
  console.log("  statuses:", JSON.stringify(dist));
  check("client base: statuses well distributed", dist.active > 90 && dist.lost > 60 && dist.sleeping > 15 && dist.expiring > 3, JSON.stringify(dist));
  const top = (await curl(OWNER, "GET", "/api/owner/clients?sort=spent_desc&limit=5")).body.items;
  console.log("  top spenders:", top.map(r => `${r.name}: ${r.spent} сум, ${r.levelName}, ${r.purchases} покупок, мёд ${r.balance}`).join(" | "));
  check("client base: top spender is «Королева улья» or «Медовая» with plausible sums", ["queen", "honey"].includes(top[0].levelId) && top[0].spent > 2_000_000 && top[0].spent < 40_000_000, JSON.stringify(top[0]));
  const card = (await curl(OWNER, "GET", `/api/owner/clients/${top[0].id}`)).body;
  check("client card = list row (balance, spent, level)", card.balance === top[0].balance && card.spent === top[0].spent && card.level.id === top[0].levelId && card.history.length > 3, JSON.stringify({ card: [card.balance, card.spent, card.level.id], row: [top[0].balance, top[0].spent, top[0].levelId] }));

  // ---------- API grants on a demo client ----------
  const target = top[1];
  const g = await curl(OWNER, "POST", `/api/owner/clients/${target.id}/grant`, { kind: "gift", giftId: "card", reason: "день рождения" }, { "Idempotency-Key": randomUUID() });
  check("API grant: gift → 201, source grant", g.status === 201 && g.body.gift?.source === "grant" && g.body.gift.reason === "день рождения", JSON.stringify(g.body).slice(0, 200));
  const hk = randomUUID();
  const h = await curl(OWNER, "POST", `/api/owner/clients/${target.id}/grant`, { kind: "honey", points: 15000, reason: "извинение за задержку" }, { "Idempotency-Key": hk });
  check("API grant: honey → balance +15 000", h.status === 201 && h.body.client.balance === target.balance + 15000, JSON.stringify(h.body).slice(0, 200));
  const h2 = await curl(OWNER, "POST", `/api/owner/clients/${target.id}/grant`, { kind: "honey", points: 15000, reason: "извинение за задержку" }, { "Idempotency-Key": hk });
  check("API grant: replay is idempotent", h2.status === 200 && h2.body.replayed === true && h2.body.client.balance === target.balance + 15000, JSON.stringify(h2.body).slice(0, 120));
  const row = (await curl(OWNER, "GET", `/api/owner/clients?q=${encodeURIComponent(target.code)}`)).body.items[0];
  check("client_stats follows the grants (list row)", row.balance === target.balance + 15000 && row.giftsAvailable === target.giftsAvailable + 1, JSON.stringify(row));
  // limit 50: a shared local DB may hold operations dated in the future by earlier test-clock runs.
  const ops = (await curl(OWNER, "GET", "/api/owner/operations?limit=50")).body;
  check("journal: grants with reason and author", ops.some(x => x.kind === "gift_granted" && x.reason === "день рождения") && ops.some(x => x.kind === "manual" && x.reason === "извинение за задержку"), JSON.stringify(ops.slice(0, 3)));

  // ---------- UI: client base → card → «🎁 Подарок или мёд» sheet ----------
  o.act("otab", '[data-tab="clients"]');
  check("UI: client list shows demo clients", await o.until(() => o.qa('[data-act="openClient"]').length >= 20), o.text().slice(0, 200));
  // A demo client (ids de300000-…), so «Удалить демо-данные» takes the grant away again.
  const first = o.qa('[data-act="openClient"]').find(el => el.dataset.id.startsWith("de300000-"));
  const firstId = first.dataset.id;
  first.click();
  check("UI: client card with the grant button", await o.until(() => !!o.q('[data-act="grantFromCard"]')), o.text().slice(0, 200));
  const before = (await curl(OWNER, "GET", `/api/owner/clients/${firstId}`)).body.balance;
  o.act("grantFromCard");
  check("grant sheet: gift kinds from the rules", await o.until(() => o.qa('[data-act="grantGift"]').length >= 2), o.text().slice(-300));
  o.act("grantKind", '[data-kind="honey"]');
  await o.until(() => !!o.q('[data-act="grantPreset"]'));
  o.act("grantPreset", '[data-points="20000"]');
  o.act("grantSubmit");
  check("grant sheet: a reason is required", await o.until(() => o.toasts().includes("Укажите повод")), o.toasts());
  o.act("grantReason", '[data-reason="День рождения"]');
  o.act("grantSubmit");
  check("grant sheet: success toast", await o.until(() => o.toasts().includes("+20 000 мёда") || o.toasts().includes("+20 000 мёда")), o.toasts());
  check("grant sheet: card reloads with the new balance", await o.until(() => o.q("#cardBal")?.textContent.replace(/\D/g, "") === String(before + 20000)), o.q("#cardBal")?.textContent + " expected " + (before + 20000));

  // ---------- «Удалить демо-данные» (two taps) ----------
  o.act("openTest");
  await o.until(() => !!o.q('[data-act="demoClear"]'));
  o.act("demoClear");
  check("test panel: clear asks for confirmation", await o.until(() => o.q('[data-act="demoClear"]').textContent.includes("Точно удалить")), o.q('[data-act="demoClear"]')?.textContent);
  o.act("demoClear");
  check("test panel: demo removed", await o.until(() => o.toasts().includes("Удалено демо-клиентов: 250"), 30000), o.toasts());
  const after = (await curl(OWNER, "GET", "/api/owner/clients?limit=100")).body.items;
  check("client base has no demo clients any more", after.every(r => !r.id.startsWith("de300000-")), after.length);
  check("no JS errors (demo)", o.errors.length === 0, o.errors.join("; "));
  void fmtNum;
  o.w.close();
}

(async () => {
  try {
    if (PHASE === "prep" || PHASE === "all") await prep();
    if (PHASE === "demo" || PHASE === "all") await demo();
  } catch (e) { check("harness crashed", false, e.stack); }
  const failed = results.filter(r => r[0] === "FAIL");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
