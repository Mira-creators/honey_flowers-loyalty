/**
 * «Склад» in the Mini App (prototype, shown only when GET /api/stock/status answers — STOCK_ENABLED):
 *  - florist / manager: tabs Касса · Букет · Склад (свежесть, списание, приход) · Витрина;
 *  - owner: Касса · Склад · Клиенты · Статистика · Ещё (Правила, Команда, Журнал).
 * Clients see nothing new. Screens use only the theme CSS variables (stock.css).
 */
import './stock.css';
import { S, actions, app, type OwnerTab } from '../../state';
import { tg } from '../../tg';
import { closeLayer, esc, sheet } from '../../ui/dom';
import { IC } from '../../ui/icons';
import { loadRecent } from '../staff';
import { builderView, openBuilder } from './builder';
import { freshView, openFresh } from './fresh';
import { catalogView, openStockHome, stockHomeView } from './owner';
import { receiptView } from './receipt';
import { sapi } from './sapi';
import { backFromSell, sellView } from './sell';
import { openShowcase, showcaseView } from './showcase';
import { ST, saveFloristTab, savedFloristTab, type FloristTab } from './st';

export { ST };

let probing: Promise<void> | null = null;
let probedFor = '';

/** Probe the module once per role (404 → off: the app keeps its usual screens). */
export function stockBoot(role: string): Promise<void> {
  if (role === 'client') { ST.status = null; probedFor = role; return Promise.resolve(); }
  if (probedFor === role && ST.probed) return Promise.resolve();
  if (probing) return probing;
  probing = (async () => {
    try { ST.status = await sapi.status(); } catch { ST.status = null; }
    ST.probed = true;
    probedFor = role;
    ST.ftab = 'desk';
    ST.screen = role === 'owner' ? 'home' : 'bouquet';
    probing = null;
    // A1: a florist re-opens the app on the stock tab she used last (one tap less per bouquet).
    const last = role === 'owner' || !ST.status ? 'desk' : savedFloristTab();
    if (last !== 'desk') openTab(last); else app.render();
  })();
  return probing;
}

export const stockOn = () => !!ST.status;
/** Florist is on a stock tab (not the cash desk). */
export const floristInStock = () => stockOn() && ST.ftab !== 'desk';

const OWNER_MORE: Array<[OwnerTab, string]> = [['rules', 'Правила'], ['staff', 'Команда'], ['ops', 'Журнал']];
const IC_FLOWER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3"/><path d="M12 5c0-2 2-3 3-2s0 3-1 4M12 5c0-2-2-3-3-2s0 3 1 4M9 8c-2 0-3 2-2 3s3 0 4-1M15 8c2 0 3 2 2 3s-3 0-4-1M12 11v10M12 17c-2-2-5-2-6-1M12 16c2-2 4-2 5-1"/></svg>';
const IC_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>';
const IC_SHOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>';
const IC_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Bottom tabs, or null when the stock module is off (main.ts then uses its own). */
export function stockNav(role: string): string | null {
  if (!stockOn()) return null;
  const btn = (act: string, attrs: string, current: boolean, icon: string, label: string) => `<button data-act="${act}" ${attrs} ${current ? 'aria-current="page"' : ''}>${icon}${label}</button>`;
  let items: string[];
  if (role === 'owner') {
    const t = S.owner.tab;
    items = [
      btn('otab', 'data-tab="desk"', t === 'desk', IC.card, 'Касса'),
      btn('stOwnerStock', '', t === 'stock', IC_BOX, 'Склад'),
      btn('otab', 'data-tab="clients"', t === 'clients', IC.clients, 'Клиенты'),
      btn('otab', 'data-tab="stats"', t === 'stats', IC.stats, 'Статистика'),
      btn('stMore', '', OWNER_MORE.some(([k]) => k === t), IC_MORE, 'Ещё'),
    ];
  } else {
    const t = ST.ftab;
    items = [
      btn('stTab', 'data-tab="desk"', t === 'desk', IC.card, 'Касса'),
      btn('stTab', 'data-tab="bouquet"', t === 'bouquet', IC_FLOWER, 'Букет'),
      btn('stTab', 'data-tab="fresh"', t === 'fresh', IC_BOX, 'Склад'),
      btn('stTab', 'data-tab="showcase"', t === 'showcase', IC_SHOW, 'Витрина'),
    ];
  }
  return `<nav class="tabs" style="grid-template-columns:repeat(${items.length},1fr)" aria-label="Разделы">${items.join('')}</nav>`;
}

export function stockView(): string {
  const owner = S.me?.role === 'owner';
  const s = ST.screen;
  const body = s === 'home' ? (owner ? stockHomeView() : freshView())
    : s === 'bouquet' ? builderView() : s === 'fresh' ? freshView() : s === 'showcase' ? showcaseView()
    : s === 'receipt' ? receiptView() : s === 'sell' ? sellView() : catalogView();
  const back = owner && (s === 'bouquet' || s === 'fresh' || s === 'showcase') ? '<button class="back" data-act="stHome">‹ Склад</button>' : '';
  return `<main class="scr st" id="scr">${back}${body}</main>`;
}
export const stockKey = () => 'stk-' + ST.screen;

/** Telegram BackButton inside stock screens; true when handled. */
export function stockBack(): boolean {
  const owner = S.me?.role === 'owner';
  const inStock = owner ? S.owner.tab === 'stock' : floristInStock();
  if (!inStock) return false;
  if (ST.screen === 'sell' && !ST.sell.result) { tg.backButton(() => backFromSell()); return true; }
  if (owner && ST.screen !== 'home') { tg.backButton(() => void openStockHome()); return true; }
  if (!owner && ST.screen === 'receipt') { tg.backButton(() => void openFresh()); return true; }
  tg.backButton(null);
  return true;
}

function openTab(t: FloristTab) {
  ST.ftab = t;
  saveFloristTab(t);
  if (t === 'desk') { app.render(); void loadRecent(); return; }
  if (t === 'bouquet') void openBuilder();
  else if (t === 'fresh') void openFresh();
  else void openShowcase();
}

actions.stTab = (el) => { tg.haptic('select'); openTab(el.dataset.tab as FloristTab); };
actions.stOwnerStock = () => { tg.haptic('select'); S.owner.tab = 'stock'; void openStockHome(); };
actions.stMore = () => {
  sheet(`<h4>Ещё</h4><div class="list">${OWNER_MORE.map(([k, l]) => `<button class="it btn-it" data-act="stMoreGo" data-tab="${k}"><div class="ic">${k === 'rules' ? IC.rules : k === 'staff' ? IC.people : IC.list}</div><div><div class="t">${esc(l)}</div></div><span class="mut">›</span></button>`).join('')}</div>`);
};
actions.stMoreGo = (el, e) => { closeLayer(); actions.otab!(el, e); };
