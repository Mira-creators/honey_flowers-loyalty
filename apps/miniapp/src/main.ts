/** Entry: boot, auth, routing by role, polling for live client updates, delegated events. */
import './styles.css';
import type { ClientSummaryDTO, MeDTO } from '@honey/contracts';
import { S, actions, changes, app, resetStaff, type OwnerTab } from './state';
import { applyTheme, THEMES, ACTIVE_THEME } from './config/themes';
import { T } from './config/texts';
import { api, ApiErr, getTestUser, setTestUser } from './api';
import { tg } from './tg';
import { esc, toast } from './ui/dom';
import { IC } from './ui/icons';
import { clientView, animateClientChange } from './screens/client';
import { staffView, loadRecent } from './screens/staff';
import { ownerView, loadOwnerTab } from './screens/owner';
import { testButton } from './screens/testbar';

const root = document.getElementById('app')!;

/* ---------- theme ---------- */
try { const t = localStorage.getItem('honey.theme'); if (t && THEMES[t]) S.themeId = t; } catch { /* ignore */ }
function paintTheme() {
  const dark = tg.colorScheme() === 'dark';
  const th = applyTheme(S.themeId ?? ACTIVE_THEME, dark);
  tg.setColors((dark ? th.dark : th.light).bg);
}
tg.ready(); paintTheme(); tg.onThemeChanged(paintTheme);

/* ---------- navigation for staff roles ---------- */
const NAV: Record<string, Array<[OwnerTab, string, string]>> = {
  manager: [['desk', 'Касса', IC.card], ['ops', 'Журнал', IC.list]],
  owner: [['desk', 'Касса', IC.card], ['stats', 'Статистика', IC.stats], ['rules', 'Правила', IC.rules], ['staff', 'Команда', IC.people], ['ops', 'Журнал', IC.list]],
};
function staffNav(role: string) {
  const items = NAV[role]; if (!items) return '';
  return `<nav class="tabs" style="grid-template-columns:repeat(${items.length},1fr)" aria-label="Разделы">${items.map(([k, l, ic]) => `<button data-act="otab" data-tab="${k}" ${S.owner.tab === k ? 'aria-current="page"' : ''}>${ic}${l}</button>`).join('')}</nav>`;
}
actions.otab = el => {
  S.owner.tab = el.dataset.tab as OwnerTab; tg.haptic('select');
  if (S.owner.tab === 'desk') { if (S.staff.step === 'find') loadRecent(); } else loadOwnerTab();
  render();
};

/* ---------- render ---------- */
function render() {
  const prevScroll = document.getElementById('scr')?.scrollTop ?? 0;
  const prevKey = root.dataset.view;
  let html: string, key: string;
  if (S.needsLogin) { html = loginView(); key = 'login'; }
  else if (S.fatal || !S.me) { html = S.loading ? `<main class="scr center-all"><div class="spinner" aria-label="Загрузка"></div></main>` : errorView(); key = 'err'; }
  else {
    const role = S.me.role;
    if (role === 'client') { html = clientView(); key = 'c-' + (S.me.registered ? S.screen : 'onb'); }
    else if (role === 'florist') { html = staffView(); key = 's-' + S.staff.step; }
    else { html = (S.owner.tab === 'desk' ? staffView() : ownerView()) + staffNav(role); key = 'o-' + S.owner.tab + (S.owner.tab === 'desk' ? S.staff.step : ''); }
  }
  root.innerHTML = html + testButton();
  root.dataset.view = key;
  const scr = document.getElementById('scr');
  if (scr && prevKey === key) scr.scrollTop = prevScroll;
  setBack();
}
app.render = render;

function setBack() {
  if (!S.me) return tg.backButton(null);
  if (S.me.role === 'client' && S.me.registered && S.screen !== 'home') return tg.backButton(() => { S.screen = 'home'; render(); });
  if (S.me.role !== 'client' && (S.me.role === 'florist' || S.owner.tab === 'desk') && S.staff.step !== 'find') return tg.backButton(() => { resetStaff(); render(); loadRecent(); });
  tg.backButton(null);
}

function loginView() {
  return `<main class="scr"><div class="onb">
    <svg viewBox="-34 -34 68 56" width="120" aria-hidden="true"><g class="bee-idle">${THEMES[S.themeId].mascot(1.5)}</g></svg>
    <h2 class="disp">Медовая карта Honey Flowers</h2>
    <p>${T(S.lang).openInTg}</p>
    <div class="form" style="width:100%;margin-top:10px">
      <label class="fl" for="tName">Тестовый вход без Telegram — ваше имя</label><input id="tName" autocomplete="off" placeholder="Например, Велимира">
      <button class="b acc full" data-act="testLogin" style="margin-top:8px">Войти как тестер</button>
      <p class="mut" style="font-size:12px">Работает только в тестовой версии. Сканер QR и уведомления доступны только в Telegram.</p>
    </div></div></main>`;
}
actions.testLogin = async () => {
  const n = (document.getElementById('tName') as HTMLInputElement).value.trim();
  if (n.length < 2) { toast('Введите имя', 'error'); return; }
  setTestUser(n); S.needsLogin = false; S.loading = true; render(); await refresh();
};
function errorView() {
  const t = T(S.lang);
  return `<main class="scr center-all"><div class="onb"><h2 class="disp">${t.errorTitle}</h2><p>${esc(S.fatal ?? '')}</p><button class="b acc" data-act="retry">${t.retry}</button></div></main>`;
}
actions.retry = async () => { S.fatal = null; S.loading = true; render(); await refresh(); };

/* ---------- data ---------- */
const changed = (a: ClientSummaryDTO, b: ClientSummaryDTO) =>
  a.balance !== b.balance || a.card.filled !== b.card.filled || a.card.cycle !== b.card.cycle || a.level.id !== b.level.id ||
  a.gifts.length !== b.gifts.length || a.gifts.some((g, i) => g.status !== b.gifts[i]?.status) || a.history[0]?.id !== b.history[0]?.id || a.lang !== b.lang;

async function refresh(animate = true) {
  let me: MeDTO;
  try { me = await api.me(); }
  catch (e) {
    const err = e as ApiErr;
    S.loading = false;
    if (err.status === 401 && !tg.inTelegram) { S.needsLogin = true; render(); return; }
    if (!S.me) { S.fatal = err.message; render(); } else toast(err.message, 'error');
    return;
  }
  const prev = S.me;
  const first = !prev;
  S.me = me; S.loading = false; S.fatal = null;
  if (first) S.lang = me.client?.lang ?? ((navigator.language || '').startsWith('uz') ? 'uz' : 'ru');
  else if (me.client && prev?.client && me.client.lang !== prev.client.lang) S.lang = me.client.lang;
  if (first || prev?.role !== me.role) {
    if (me.role === 'owner' && S.owner.tab === 'desk' && first) S.owner.tab = 'stats';
    if (me.role === 'florist' || me.role === 'manager' || (me.role === 'owner' && S.owner.tab === 'desk')) loadRecent();
    if (me.role === 'owner' && S.owner.tab !== 'desk') loadOwnerTab();
    if (me.role === 'manager' && S.owner.tab !== 'desk' && S.owner.tab !== 'ops') S.owner.tab = 'desk';
    return render();
  }
  if (me.role === 'client' && prev?.client && me.client && prev.registered && me.registered) {
    if (!changed(prev.client, me.client) && prev.clockOffsetDays === me.clockOffsetDays) return;
    if (animate && !S.animating) { await animateClientChange(prev.client, me.client); }
  }
  if (!S.animating) render();
}
app.refresh = refresh;

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const fn = actions[el.dataset.act!];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch(err => toast((err as Error).message || 'Ошибка', 'error')); }
});
document.addEventListener('change', e => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-change]');
  if (el && changes[el.dataset.change!]) changes[el.dataset.change!](el);
});
document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.key === 'Enter' && t.id === 'q') actions.search?.(t, e);
  if (e.key === 'Enter' && t.id === 'tName') actions.testLogin?.(t, e);
});

/* ---------- live polling: the client sees a purchase made on the florist's phone ---------- */
setInterval(() => {
  if (document.visibilityState !== 'visible' || S.animating || !S.me) return;
  if (document.getElementById('layer')?.children.length) return;
  if (S.me.role === 'client' && S.me.registered) refresh();
}, 4000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me) refresh(); });

/* ---------- boot ---------- */
if (!tg.inTelegram && !getTestUser()) { S.needsLogin = true; S.loading = false; render(); }
else { render(); refresh(false); }
