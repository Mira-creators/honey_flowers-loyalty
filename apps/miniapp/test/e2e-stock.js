// «Склад» smoke test: the built Mini App (dist) in jsdom against a Worker with TEST_MODE=1 and STOCK_ENABLED=1.
// Flows: USD receipt «одной суммой» (owner), bouquet assembly (florist), the stock_short sheet, selling
// to a client (honey appears), showcase disassembly, write-off approval (florist → owner).
// Run: a QA worker on E2E_BASE (e.g. `QA_PORT=8851 node qa/run.mjs --only=stock` starts one), then
//      E2E_BASE=http://127.0.0.1:8851 E2E_TEST_KEY=qa-test-key node test/e2e-stock.js
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BASE = process.env.E2E_BASE || "http://127.0.0.1:8851";
const KEY = process.env.E2E_TEST_KEY || "local-test-key";
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8").replace(/<script[^>]*telegram-web-app[^>]*><\/script>/, "").replace(/<script type="module"[^>]*><\/script>/, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const jsFile = fs.readdirSync(path.join(DIST, "assets")).find((f) => f.endsWith(".js"));
const js = fs.readFileSync(path.join(DIST, "assets", jsFile), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, ok ? "" : String(extra).slice(0, 300)]); };

function open(testUser, name) {
  const errors = [];
  const dom = new JSDOM(html, { url: `${BASE}/?testUser=${testUser}&testName=${encodeURIComponent(name)}&testKey=${encodeURIComponent(KEY)}`, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.animate = function () { return { finished: Promise.resolve() }; };
  w.fetch = (u, o) => fetch(new URL(u, BASE), o);
  w.structuredClone = structuredClone;
  w.crypto.randomUUID = () => randomUUID();
  w.addEventListener("error", (e) => errors.push(e.message));
  w.eval(js.replace(/import\.meta/g, "({})"));
  const d = w.document;
  return {
    w, d, errors,
    text: () => (d.getElementById("app").textContent + " " + d.getElementById("layer").textContent).replace(/\s+/g, " "),
    q: (s) => d.querySelector(s),
    qa: (s) => [...d.querySelectorAll(s)],
    act: (name, attrs = "") => { const el = d.querySelector(`[data-act="${name}"]${attrs}`); if (!el) throw new Error("missing act " + name + attrs); el.click(); },
    toasts: () => [...d.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "),
    until: async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* not yet */ } await wait(80); } return false; },
    /** set a value and fire the delegated input/change handlers */
    type: (sel, value) => { const el = typeof sel === "string" ? d.querySelector(sel) : sel; if (!el) throw new Error("missing " + sel); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); },
  };
}
const curl = (user, method, p, body) => fetch(BASE + p, { method, headers: { "X-Test-User": String(user), "X-Test-Key": KEY, "X-Test-Name": "Curl", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  const O = 900000000 + Math.floor(Math.random() * 90000000), F = O + 1, C = O + 2;
  try {
    // ---------- setup: roles, client, starter catalog ----------
    await curl(O, "POST", "/api/test/role", { role: "owner" });
    await curl(O, "POST", "/api/test/clock", { reset: true });
    await curl(F, "POST", "/api/test/role", { role: "florist" });
    const phone = "+99890" + String(C).slice(-7);
    const reg = await curl(C, "POST", "/api/test/register", { consent: true, phone, name: "Гульнора" });
    check("setup: client registered", reg.status === 201, JSON.stringify(reg.body));
    const status = await curl(O, "GET", "/api/stock/status");
    check("setup: stock module is on", status.status === 200, status.status);

    // ---------- owner: «Склад» tab, catalog seed, USD receipt «одной суммой» ----------
    const ow = open(O, "Велимира");
    check("owner: «Склад» tab shown", await ow.until(() => ow.q('[data-act="stOwnerStock"]')), ow.text().slice(0, 200));
    check("owner: overflow in «Ещё»", !!ow.q('[data-act="stMore"]') && !ow.q('[data-act="otab"][data-tab="rules"]'));
    ow.act("stOwnerStock");
    check("owner: overview loads", await ow.until(() => ow.text().includes("стоимость остатка")), ow.text().slice(0, 300));
    if (ow.q('[data-act="stSeed"]')) { ow.act("stSeed"); await ow.until(() => ow.toasts().includes("Добавлено")); }
    else await curl(O, "POST", "/api/owner/stock/catalog/seed", {});
    const cat = (await curl(F, "GET", "/api/stock/catalog")).body;
    const qtyOf = async (sku) => (await curl(F, "GET", "/api/stock/catalog")).body.items.find((i) => i.sku === sku).qty;
    const rnBefore = cat.items.find((i) => i.sku === "RN60")?.qty ?? 0;
    const id = (sku) => cat.items.find((i) => i.sku === sku).id;
    check("catalog: starter items", cat.items.length >= 30, cat.items.length);
    ow.act("stGo", '[data-s="receipt"]');
    check("receipt: form shown", await ow.until(() => ow.text().includes("Валюта прихода") && ow.q('[data-change="stRecItem"]')), ow.text().slice(0, 200));
    ow.act("stRecCur", '[data-v="USD"]'); await wait(30);
    ow.type("#stRecFx", "12850");
    ow.act("stRecMode", '[data-v="total"]'); await wait(30);
    ow.type('[data-change="stRecItem"][data-k="0"]', id("RN60")); await wait(30);
    ow.type('[data-input="stRecQty"][data-k="0"]', "2");
    ow.act("stRecAdd"); await wait(30);
    ow.type('[data-change="stRecItem"][data-k="1"]', id("EUC")); await wait(30);
    ow.type('[data-input="stRecQty"][data-k="1"]', "30");
    ow.type('[data-change="stRecUnit"][data-k="1"]', "base"); await wait(30);
    ow.type('[data-change="stRecPer"][data-k="1"]', "unit"); await wait(30);
    ow.type('[data-input="stRecPrice"][data-k="1"]', "0,45");
    ow.type("#stRecTotal", "62,5");
    ow.act("stRecCheck");
    check("receipt: USD preview (dollars and сум, manual line ✎)", await ow.until(() => ow.text().includes("$ ≈") && ow.text().includes("✎") && ow.text().includes("803")), ow.toasts() || ow.text().slice(-500));
    ow.act("stRecPost");
    check("receipt: posted", await ow.until(() => ow.toasts().includes("Приход №")), ow.toasts());
    const rnAfter = await qtyOf("RN60");
    check("receipt: 2 packs = 50 stems on stock", rnAfter - rnBefore === 50, `${rnBefore} → ${rnAfter}`);
    // a UZS receipt through the API for the other flows
    const r2 = await curl(O, "POST", "/api/stock/receipts", { idempotencyKey: "e2e-" + randomUUID(), currency: "UZS", priceMode: "lines", confirm: true, lines: [{ itemId: id("EUW"), qty: 10, unit: "base", price: 15000, per: "unit" }, { itemId: id("KRF"), qty: 20, unit: "base", price: 4000, per: "unit" }] });
    check("receipt (API, UZS): posted", r2.status === 201, JSON.stringify(r2.body));

    // ---------- florist: tabs, bouquet builder, live cost, «Собран → продать» ----------
    const fl = open(F, "Дилноза");
    check("florist: tabs Касса · Букет · Склад · Витрина", await fl.until(() => fl.q('[data-act="stTab"][data-tab="bouquet"]') && fl.q('[data-act="stTab"][data-tab="showcase"]')), fl.text().slice(0, 200));
    fl.act("stTab", '[data-tab="bouquet"]');
    check("builder: tiles shown", await fl.until(() => fl.q(`[data-item="${id("RN60")}"]`)), fl.text().slice(0, 200));
    for (let i = 0; i < 15; i++) fl.act("stAdd", `[data-id="${id("RN60")}"]`);
    for (let i = 0; i < 3; i++) fl.act("stAdd", `[data-id="${id("EUC")}"]`);
    fl.act("stAdd", `[data-id="${id("KRF")}"]`);
    await wait(50);
    const costTxt = fl.q("#stCost")?.textContent || "";
    check("builder: live cost > 0", /\d/.test(costTxt) && !/^0\s/.test(costTxt), costTxt);
    check("builder: cost shares vs 33 % / 25 %", fl.text().includes("/ 33%") && fl.text().includes("/ 25%"), fl.text().slice(-400));
    fl.act("stAssemble");
    check("builder: assembled → sale screen", await fl.until(() => fl.text().includes("Продать букет №")), fl.toasts() || fl.text().slice(0, 300));

    // ---------- sell to the client ----------
    fl.q("#stSellQ").value = phone; fl.act("stFindClient");
    check("sell: client found", await fl.until(() => fl.text().includes("Гульнора")), fl.toasts() || fl.text().slice(0, 300));
    check("sell: loyalty preview", await fl.until(() => fl.text().includes("Кешбэк")), fl.text().slice(-300));
    const before = (await curl(C, "GET", "/api/me")).body.client.balance;
    fl.act("stPaid");
    check("sell: «Продано» with honey", await fl.until(() => fl.text().includes("Продано") && fl.text().includes("мёда клиенту")), fl.toasts() || fl.text().slice(0, 300));
    const after = (await curl(C, "GET", "/api/me")).body.client.balance;
    check("sell: client's honey balance grew", after > before, `${before} → ${after}`);
    fl.act("stSellNext");

    // ---------- stock_short sheet ----------
    await fl.until(() => fl.q('[data-act="stTab"][data-tab="bouquet"]'));
    fl.act("stTab", '[data-tab="bouquet"]');
    await fl.until(() => fl.q(`[data-item="${id("EUW")}"]`));
    fl.act("stQty", `[data-id="${id("EUW")}"]`);
    await fl.until(() => fl.q("#stQtyIn"));
    const euwHave = await qtyOf("EUW");
    fl.q("#stQtyIn").value = String(euwHave + 2); fl.q("#stQtyOk").click(); await wait(50);
    fl.act("stAssemble");
    check("short: sheet «Не хватает» with both options", await fl.until(() => fl.text().includes("Не хватает на складе") && fl.q('[data-act="stShortForce"]') && fl.q('[data-act="stShortEdit"]')), fl.toasts() || fl.text().slice(-300));
    check(`short: need ${euwHave + 2}, have ${euwHave}`, fl.text().includes(`нужно ${euwHave + 2}, на складе ${euwHave}`), fl.text().slice(-300));
    fl.act("stShortEdit"); await wait(50);
    check("short: «Изменить состав» closes the sheet", !fl.text().includes("Не хватает на складе"));

    // ---------- showcase bouquet → disassembly ----------
    fl.act("stQty", `[data-id="${id("EUW")}"]`);
    await fl.until(() => fl.q("#stQtyIn"));
    fl.q("#stQtyIn").value = "5"; fl.q("#stQtyOk").click(); await wait(50);
    fl.act("stKind", '[data-v="showcase"]'); await wait(30);
    fl.act("stAssemble");
    check("showcase: bouquet on the showcase", await fl.until(() => fl.toasts().includes("на витрине")), fl.toasts());
    const mine = (await curl(F, "GET", "/api/stock/bouquets")).body.find((b) => b.status === "on_showcase" && b.lines.length === 1 && b.lines[0].itemId === id("EUW") && b.lines[0].qty === 5);
    fl.act("stTab", '[data-tab="showcase"]');
    check("showcase: list shows it", await fl.until(() => fl.q(`[data-act="stDisasm"][data-id="${mine?.id}"]`)), fl.text().slice(0, 300));
    fl.act("stDisasm", `[data-id="${mine.id}"]`);
    await fl.until(() => fl.q("#stDisOk"));
    fl.q(`[data-good="${id("EUW")}"]`).value = "3"; fl.q("#stDisOk").click();
    check("disassembly: 3 back, 2 waste", await fl.until(() => /вернули 3.*в отходы 2/.test(fl.toasts())), fl.toasts());
    const euwAfter = await qtyOf("EUW");
    check("disassembly: EUW back on stock (−5 + 3)", euwAfter === euwHave - 2, `${euwHave} → ${euwAfter}`);

    // ---------- write-off above the threshold → owner approval ----------
    fl.act("stTab", '[data-tab="fresh"]');
    check("fresh: lots listed", await fl.until(() => fl.q('[data-act="stWo"]')), fl.text().slice(0, 300));
    const rnLot = (await curl(F, "GET", "/api/stock/freshness")).body;
    // the biggest RN60 lot; enough stems for ≥ 200 000 сум (approval threshold)
    const lot = ["overdue", "today", "soon", "fresh"].flatMap((g) => rnLot.groups[g].lots).filter((l) => l.itemId === id("RN60")).sort((a, b) => b.valueUzs - a.valueUzs)[0];
    const woQty = Math.min(lot.qty, Math.ceil(200_001 / (lot.valueUzs / lot.qty)));
    await fl.until(() => fl.q(`[data-act="stWo"][data-lot="${lot.lotId}"]`));
    fl.act("stWo", `[data-lot="${lot.lotId}"]`);
    await fl.until(() => fl.q("#woOk"));
    fl.q("#woQty").value = String(woQty); fl.q("#woOk").click();
    const woOk = await fl.until(() => fl.toasts().includes("ждёт подтверждения"));
    check(`write-off: ${woQty} roses → pending approval`, woOk, fl.toasts());
    ow.act("stOwnerStock");
    const myWo = (await curl(O, "GET", "/api/owner/stock/approvals")).body.find((p) => p.actor.includes("Дилноза") && p.lines.some((l) => l.qty === woQty));
    // Other suites may leave pending write-offs in the same DB: wait for THIS one's button, not any.
    check("approval: owner sees «На подтверждение»", await ow.until(() => ow.text().includes("На подтверждение") && ow.q(`[data-act="stApprove"][data-id="${myWo?.docId}"]`)), ow.text().slice(0, 400));
    ow.act("stApprove", `[data-id="${myWo?.docId}"]`);
    check("approval: approved", await ow.until(() => ow.toasts().includes("подтверждено")), ow.toasts());
    const pend = await curl(O, "GET", "/api/owner/stock/approvals");
    check("approval: this write-off is no longer pending", Array.isArray(pend.body) && !!myWo && !pend.body.some((p) => p.docId === myWo.docId), JSON.stringify(pend.body).slice(0, 200));

    // ---------- client UI unchanged ----------
    const cl = open(C, "Гульнора");
    check("client: no stock tabs", await cl.until(() => cl.text().includes("Гульнора") || cl.q("#comb")) && !cl.q('[data-act="stTab"]') && !cl.q('[data-act="stOwnerStock"]'), cl.text().slice(0, 200));
    check("no page errors", [ow, fl, cl].every((x) => x.errors.length === 0), [ow, fl, cl].flatMap((x) => x.errors).join(" | "));
  } catch (e) {
    results.push(["FAIL", "CRASH", e.stack]);
  }
  for (const [s, n, x] of results) console.log(`${s}  ${n}${x ? "  — " + x : ""}`);
  const passed = results.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
