/** Client screens: onboarding, honeycomb home, QR card, gifts, profile. */
import type { ClientSummaryDTO, LevelInfo, HistoryItemDTO, GiftDTO } from '@honey/contracts';
import { S, actions, app } from '../state';
import { T, type Texts } from '../config/texts';
import { THEMES } from '../config/themes';
import { api, ApiErr } from '../api';
import { tg } from '../tg';
import { esc, fmt, toast, modal, confetti, sleep } from '../ui/dom';
import { IC } from '../ui/icons';
import { combSVG, fly, beeAt, dropToBalance, countUp, giftSvg } from '../ui/comb';
import { qrSvg } from '../ui/qr';

const th = () => THEMES[S.themeId];
/** Chat that takes orders (from the shop's channel description). Change here if the shop changes it. */
const ORDER_CHAT = 'honey_uz';
const L = () => T(S.lang);
const dstr = (iso: string) => { const d = new Date(iso); return L().date(d.getDate(), L().months[d.getMonth()]); };
// 'YYYY-MM-DD' Tashkent calendar day: format without time-zone conversion.
const dayStr = (ymd: string) => { const [, m, d] = ymd.split('-').map(Number); return L().date(d, L().months[(m || 1) - 1]); };
// Owner-edited names win; the uz table only translates the default level ids.
const lvName = (l: LevelInfo) => (S.lang === 'uz' && L().levels[l.id]) ? L().levels[l.id] : l.name;
const giftText = (type: string) => L().giftTypes[type] ?? { t: type, p: '' };
const giftCells = (c: ClientSummaryDTO) => Object.keys(c.card.gifts).map(Number).sort((a, b) => a - b);

/* ---------------- views ---------------- */
export function clientView(): string {
  const me = S.me!;
  if (!me.registered || !me.client) return onboarding();
  const c = me.client;
  const body = S.screen === 'card' ? cardView(c) : S.screen === 'gifts' ? giftsView(c) : S.screen === 'profile' ? profileView(c) : homeView(c);
  return `<main class="scr" id="scr">${body}</main>${tabs(c)}`;
}

function tabs(c: ClientSummaryDTO) {
  const t = L().tabs, avail = c.gifts.filter(g => g.status === 'available').length;
  return `<nav class="tabs" aria-label="Разделы">${(['home', 'card', 'gifts', 'profile'] as const).map(k =>
    `<button data-act="tab" data-tab="${k}" ${S.screen === k ? 'aria-current="page"' : ''}>${IC[k]}${t[k]}${k === 'gifts' && avail ? `<span class="dot">${avail}</span>` : ''}</button>`).join('')}</nav>`;
}

export function homeView(c: ClientSummaryDTO, shown?: { filled?: number; justFilled?: number; balance?: number }) {
  const t = L(), lv = c.level, nx = c.next;
  const filled = shown?.filled ?? c.card.filled, bal = shown?.balance ?? c.balance;
  const pct = nx ? Math.max(3, Math.min(100, (c.spent - lv.from) / Math.max(1, nx.from - lv.from) * 100)) : 100;
  const avail = c.gifts.filter(g => g.status === 'available').length;
  const ahead = giftCells(c).filter(n => n > filled).length;
  return `
    <div class="top-row"><h2 class="disp">${esc(t.hello(c.name))}</h2><span class="lvl"><i><svg viewBox="-24 -24 48 40" width="16" aria-hidden="true">${th().mascot(0.55)}</svg></i>${esc(lvName(lv))} · ${lv.pct}%</span></div>
    <div class="comb-card"><div class="comb-meta"><span>${t.cardMeta(c.card.cycle, filled, c.card.cells)}</span><span>${t.ahead(ahead)}</span></div>${combSVG(th(), c.card, filled, shown?.justFilled)}</div>
    <div class="bal" id="bal"><span class="l">${t.balLbl}</span><span class="n" id="balN">${fmt(bal)}<small>${t.unit}</small></span><span class="e">${c.expiresOn && c.balance > 0 ? t.until(dayStr(c.expiresOn)) : ''}</span></div>
    <div class="prog"><div class="r"><span>${nx ? esc(t.toLevel(lvName(nx), nx.pct)) : t.top}</span><b>${nx ? t.left(fmt(nx.left)) : t.topNote}</b></div><div class="track"><i style="width:${pct}%"></i></div></div>
    <div class="grid2">
      <button class="b" data-act="tab" data-tab="card">${IC.card}${t.myCard}</button>
      <button class="b" data-act="tab" data-tab="gifts">${IC.gifts}${t.gifts}${avail ? `<span class="cnt">${avail}</span>` : ''}</button>
      <button class="b pri full" data-act="order">${t.order}</button>
    </div>`;
}

function cardView(c: ClientSummaryDTO) {
  return `<h2 class="h disp">${L().myCard}</h2><div class="qr">${qrSvg(c.code)}</div><div class="code">${esc(c.code)}</div><p class="mut center">${L().cardHint}</p>`;
}

function giftsView(c: ClientSummaryDTO) {
  const t = L();
  const rows = c.gifts.map((g: GiftDTO) => `<div class="it ${g.status !== 'available' ? 'dim' : ''}"><div class="ic">${giftSvg}</div><div><div class="t">${esc(giftText(g.type).t)}</div><div class="s">${g.status === 'available' ? t.giftAvail : g.status === 'used' ? t.giftUsed(g.usedAt ? dstr(g.usedAt) : '') : t.giftRevoked}${g.reason ? ' · ' + esc(g.reason) : ''}</div></div><span class="mut">${g.status === 'available' ? '🎁' : g.status === 'used' ? '✓' : '—'}</span></div>`).join('');
  const locked = giftCells(c).filter(n => n > c.card.filled).map(() => `<div class="it lock"><div class="ic">?</div><div><div class="t">${t.surprise}</div><div class="s">${t.surpriseHint}</div></div><span></span></div>`).join('');
  return `<h2 class="h disp">${t.gifts}</h2><div class="list">${rows || `<p class="mut" style="margin:0 0 4px">${t.noGifts}</p>`}${locked}</div>`;
}

/** One history line. `t` = text table (the owner's client card passes Russian). */
export function histRow(h: HistoryItemDTO, t: Texts = L()) {
  const dstr = (iso: string) => { const d = new Date(iso); return t.date(d.getDate(), t.months[d.getMonth()]); };
  let title: string, sub: string;
  if (h.kind === 'purchase') {
    title = t.hPurchase(fmt(h.purchaseAmount ?? 0));
    sub = t.hPurchaseSub(h.pct ?? 0, h.cell, h.redeemed ? fmt(h.redeemed) : '') + (h.status === 'reversed' ? ` · ${t.hReversed}` : '');
  } else { title = t.kinds[h.kind] ?? h.kind; sub = h.reason ? esc(h.reason) : ''; }
  const p = h.points;
  return `<div class="it ${h.status === 'reversed' ? 'dim' : ''}"><div class="ic sm">${new Date(h.at).getDate()}</div><div><div class="t">${title}</div><div class="s">${dstr(h.at)}${sub ? ' · ' + sub : ''}</div></div><span class="amt ${p >= 0 ? 'p' : 'm'}">${p === 0 ? '0' : (p > 0 ? '+' : '−') + fmt(Math.abs(p))}</span></div>`;
}

function profileView(c: ClientSummaryDTO) {
  const t = L();
  return `<div class="prof"><div class="ava">${esc(c.name.slice(0, 1).toUpperCase())}</div><div><div class="disp" style="font-size:18px">${esc(c.name)}</div><div class="mut">${esc(c.phoneMasked)} · ${esc(lvName(c.level))}</div></div></div>
    <div class="sub">${t.lang}</div><div class="langs"><button data-act="lang" data-l="ru" aria-pressed="${S.lang === 'ru'}">Русский</button><button data-act="lang" data-l="uz" aria-pressed="${S.lang === 'uz'}">O'zbekcha</button></div>
    <div class="sub">${t.history}</div><div class="list">${c.history.length ? c.history.map(h => histRow(h)).join('') : `<p class="mut">${t.noHistory}</p>`}</div>`;
}

function onboarding() {
  const t = L(), me = S.me!;
  const browser = !tg.inTelegram;
  return `<main class="scr"><div class="onb">
    <svg viewBox="-34 -34 68 56" width="132" aria-hidden="true"><g class="bee-idle">${th().mascot(1.5)}</g></svg>
    <h2 class="disp">${t.onbTitle}</h2><p>${t.onbText}</p>
    ${me.rules.welcomeBonus > 0 ? `<div class="gift-pill">${t.onbGift(fmt(me.rules.welcomeBonus))}</div>` : ''}
    ${browser && me.testMode ? `
      <div class="form" style="width:100%">
        <label class="fl" for="regName">Имя</label><input id="regName" value="${esc(me.firstName || '')}" autocomplete="off">
        <label class="fl" for="regPhone">Телефон</label><input id="regPhone" inputmode="tel" value="+998 90 " autocomplete="off">
        <button class="b acc full" data-act="testRegister" style="margin-top:8px">Зарегистрироваться (тест без Telegram)</button>
      </div>` : `
      <button class="b acc full" data-act="share" ${S.waitingContact ? 'disabled' : ''} style="margin-top:6px">${S.waitingContact ? t.waiting : t.share}</button>`}
    <p class="consent">${t.consent}</p></div></main>`;
}

/* ---------------- actions ---------------- */
actions.tab = el => { S.screen = el.dataset.tab as typeof S.screen; app.render(); { const scr = document.getElementById('scr'); if (scr) scr.scrollTop = 0; } tg.haptic('select'); };
actions.order = () => { tg.openTelegramLink(`https://t.me/${ORDER_CHAT}`); };
actions.lang = async el => {
  const l = el.dataset.l as 'ru' | 'uz'; if (l === S.lang) return;
  S.lang = l; app.render();
  try { await api.setLang({ lang: l }); } catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.share = async () => {
  S.waitingContact = true; app.render();
  const ok = await tg.requestContact();
  if (!ok) { S.waitingContact = false; app.render(); toast(L().shareFailed, 'error'); return; }
  // The contact goes to the bot; poll until the Worker has created the client (webhook may be slow: up to ~60 s).
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    await app.refresh();
    if (S.me?.registered) { S.waitingContact = false; app.render(); tg.haptic('success'); return; }
  }
  S.waitingContact = false; app.render(); toast(L().shareFailed, 'error');
};
actions.testRegister = async () => {
  const name = (document.getElementById('regName') as HTMLInputElement).value.trim();
  const phone = (document.getElementById('regPhone') as HTMLInputElement).value.trim();
  if (!name || phone.replace(/\D/g, '').length < 12) { toast('Введите имя и телефон в формате +998 XX XXX XX XX', 'error'); return; }
  try { await api.test.register(phone, name); await app.refresh(); } catch (e) { toast((e as ApiErr).message, 'error'); }
};

/* ---------------- live updates: animate what changed since the last snapshot ---------------- */
export async function animateClientChange(prev: ClientSummaryDTO, next: ClientSummaryDTO) {
  const t = L(), root = document.getElementById('scr');
  const newGifts = next.gifts.filter(g => g.status === 'available' && !prev.gifts.some(p => p.id === g.id));
  const lvlUp = next.level.id !== prev.level.id && next.level.from > prev.level.from;
  const sameCycle = next.card.cycle === prev.card.cycle;
  const lastPurchase = next.history.find(h => h.kind === 'purchase' && !prev.history.some(p => p.id === h.id));
  // Bonus мёд granted by the owner (no purchase): honey drops into the balance + a toast.
  const grantHoney = lastPurchase ? undefined : next.history.find(h => h.kind === 'manual' && h.points > 0 && !prev.history.some(p => p.id === h.id));
  if (!root || S.screen !== 'home') {
    if (newGifts.length || lvlUp || lastPurchase) toast(lastPurchase ? t.plusPoints(fmt(lastPurchase.cashback ?? Math.max(0, lastPurchase.points))) : t.newGift, 'ok');
    else if (grantHoney) toast(t.grantHoney(fmt(grantHoney.points), grantHoney.reason ?? ''), 'ok');
    return;
  }
  S.animating = true;
  try {
    const startBal = prev.balance;
    if (sameCycle && next.card.filled > prev.card.filled) {
      root.innerHTML = homeView(next, { filled: prev.card.filled, balance: startBal });
      await fly(beeAt(prev.card.filled), beeAt(next.card.filled));
      root.innerHTML = homeView(next, { filled: next.card.filled, justFilled: next.card.filled, balance: startBal });
      tg.haptic('success');
      await sleep(650);
      await dropToBalance(next.card.filled);
      countUp(startBal, next.balance, t.unit, fmt);
    } else if (!sameCycle) {
      root.innerHTML = homeView(next, { balance: startBal });
      countUp(startBal, next.balance, t.unit, fmt);
      await modal(`<div class="k">${t.mCardK}</div><h3 class="disp">${t.mCardT}</h3><p>${t.mCardP}</p>`, t.mCardB);
    } else if (next.balance !== startBal) {
      root.innerHTML = homeView(next, { balance: startBal });
      if (next.balance > startBal) await dropToBalance(null);
      countUp(startBal, next.balance, t.unit, fmt);
    }
    if (lastPurchase && !newGifts.length) {
      const ng = giftCells(next).find(n => n > next.card.filled);
      toast(t.accruedToast(fmt(lastPurchase.cashback ?? Math.max(0, lastPurchase.points)), ng ? ng - next.card.filled : 0, lastPurchase.redeemed ? fmt(lastPurchase.redeemed) : ''), 'ok');
    }
    if (grantHoney) toast(t.grantHoney(fmt(grantHoney.points), grantHoney.reason ?? ''), 'ok');
    for (const g of newGifts) { await sleep(400); await giftModal(g); }
    if (lvlUp) {
      await sleep(400);
      await modal(`<div class="k">${t.mLvlK}</div><h3 class="disp">${esc(lvName(next.level))} · ${next.level.pct}%</h3><p>${t.mLvlP(next.level.pct)}</p>`, t.mLvlB);
      confetti();
    }
  } finally { S.animating = false; }
}

function giftModal(g: GiftDTO) {
  const t = L(), gt = giftText(g.type); let opened = false;
  return modal(`<div class="k">${g.source === 'grant' ? t.mGrantK : t.mGiftK(g.cell)}</div><div class="flip" id="flip"><div class="flip-in"><div class="face front"><span class="q">?</span></div><div class="face back">${giftSvg}<b>${esc(gt.t)}</b></div></div></div><p>${esc(gt.p)}${g.reason ? `<br><b>${esc(g.reason)}</b>` : ''}</p>`, t.mOpen, () => {
    if (!opened) { opened = true; document.getElementById('flip')?.classList.add('on'); const b = document.getElementById('mBtn'); if (b) b.textContent = t.mTake; confetti(); tg.haptic('success'); return false; }
  });
}
