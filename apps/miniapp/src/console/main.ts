/**
 * «Кабинет владельца» — owner analytics on a computer (apps/miniapp/console.html).
 * Login: console.html#t=<one-time token> from the Mini App → POST /api/web/session → Bearer
 * session (12 h). TEST_MODE: the Mini App's X-Test-User login works too.
 * Design: the Mini App themes (src/config/themes.ts CSS variables), desktop-first.
 */
import './console.css';
import type { EditableRulesDTO, WebMeDTO } from '@honey/contracts';
import { ACTIVE_THEME, applyTheme, THEMES } from '../config/themes';
import { getTestUser, setTestUser } from '../api';
import { ApiErr, authMode, capi, clearSession, getSession, hooks, setSession } from './api';
import { wireChartTooltips } from './chart';
import { acts, changes, esc, isDayKey, PRESETS, q, section, SECTIONS, setQuery, shell, submits, toast, urlPeriod, type Section } from './core';
import { clientsView, levels, loadClients } from './views/clients';
import { cohortsView, loadCohorts } from './views/cohorts';
import { importView, loadImport } from './views/importer';
import { loadOps, opsView } from './views/operations';
import { loadOverview, overviewView } from './views/overview';

const root = document.getElementById('console')!;
let me: WebMeDTO | null = null;
let screen: 'loading' | 'app' | 'expired' | 'login' | 'forbidden' = 'loading';
let screenMsg = '';
let testMode = false;

// ------------------------------------------------------------------ theme

let themeId = ACTIVE_THEME;
try { const t = localStorage.getItem('honey.theme'); if (t && THEMES[t]) themeId = t; } catch { /* ignore */ }
const dark = matchMedia('(prefers-color-scheme: dark)');
const paint = () => applyTheme(themeId, dark.matches);
paint();
dark.addEventListener?.('change', paint);

// ------------------------------------------------------------------ views

const VIEWS: Record<Section, { view: () => string; load: () => Promise<void>; title: string; period: boolean }> = {
  overview: { view: overviewView, load: () => loadOverview(), title: 'Обзор', period: true },
  clients: { view: clientsView, load: () => loadClients(), title: 'Клиенты', period: true },
  ops: { view: opsView, load: () => loadOps(), title: 'Покупки и операции', period: true },
  cohorts: { view: cohortsView, load: () => loadCohorts(), title: 'Удержание клиентов', period: false },
  import: { view: importView, load: () => loadImport(), title: 'Импорт базы клиентов', period: false },
};

function periodPicker(): string {
  const { from, to } = urlPeriod();
  const active = PRESETS.find(([, , f]) => { const p = f(); return p.from === from && p.to === to; })?.[0];
  return `<form class="cx-period" data-submit="period">
    <div class="cx-seg" role="group" aria-label="Период">${PRESETS.map(([k, l]) => `<button type="button" data-act="preset" data-k="${k}" aria-pressed="${k === active}">${l}</button>`).join('')}</div>
    <label class="cx-dates"><input type="date" name="from" value="${from}" aria-label="С"> — <input type="date" name="to" value="${to}" aria-label="По"></label>
    <button class="cx-btn" type="submit">Показать</button></form>`;
}

function mascot() {
  return `<svg viewBox="-34 -34 68 56" width="40" aria-hidden="true">${THEMES[themeId]!.mascot(1)}</svg>`;
}

function layout(): string {
  const s = section();
  const v = VIEWS[s];
  return `<div class="cx">
    <aside class="cx-nav">
      <div class="cx-brand">${mascot()}<div><b class="disp">Honey Flowers</b><div class="cx-mut">Кабинет владельца</div></div></div>
      <nav>${SECTIONS.map(([k, l]) => `<a href="?${navQuery(k)}" data-act="nav" data-s="${k}" ${k === s ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div class="cx-who">${esc(me?.name ?? '')}${me?.via === 'testHeader' ? ' <span class="cx-tag">тест</span>' : ''}
        ${me?.sessionExpiresAt ? `<div class="cx-mut">вход до ${esc(new Date(me.sessionExpiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))}</div>` : ''}
        <button class="cx-link" data-act="logout">Выйти</button></div>
    </aside>
    <main class="cx-main">
      <header class="cx-top"><h1 class="disp">${v.title}</h1>${v.period ? periodPicker() : ''}</header>
      <section id="view" aria-live="polite">${v.view()}</section>
    </main></div>`;
}

/** Keep the period when switching sections; drop section-specific filters. */
function navQuery(s: Section): string {
  const { from, to } = urlPeriod();
  const p = new URLSearchParams();
  if (s !== 'overview') p.set('s', s);
  if (q().get('from')) { p.set('from', from); p.set('to', to); }
  return p.toString();
}

function messageScreen(title: string, text: string, extra = ''): string {
  return `<div class="cx-center"><div class="cx-card cx-msg">${mascot()}<h1 class="disp">${esc(title)}</h1><p>${esc(text)}</p>${extra}</div></div>`;
}

function render() {
  if (screen === 'loading') root.innerHTML = '<div class="cx-center"><div class="cx-loading">Открываем кабинет…</div></div>';
  else if (screen === 'expired') root.innerHTML = messageScreen('Ссылка устарела', screenMsg || 'Ссылка устарела, запросите новую в приложении.', `<p class="cx-mut">В медовой карте в Telegram: Статистика → «Открыть кабинет на компьютере». Ссылка действует 10 минут и открывается один раз.</p>${testMode ? testLoginForm() : ''}`);
  else if (screen === 'forbidden') root.innerHTML = messageScreen('Только для владельца', screenMsg, testMode && authMode() === 'test' ? '<button class="cx-btn acc" data-act="becomeOwner">Тест: переключиться на роль владельца</button>' : '');
  else if (screen === 'login') root.innerHTML = messageScreen('Кабинет владельца', 'Откройте кабинет по ссылке из медовой карты: Статистика → «Открыть кабинет на компьютере».', testMode ? testLoginForm() : '');
  else root.innerHTML = layout();
}
function renderView() {
  if (screen !== 'app') return;
  const el = document.getElementById('view');
  if (el) el.innerHTML = VIEWS[section()].view();
}
shell.render = render;
shell.renderView = renderView;

function testLoginForm(): string {
  return `<form class="cx-filters cx-testlogin" data-submit="testLogin"><b>Тестовый вход (TEST_MODE)</b>
    <label class="cx-f"><span>Имя</span><input name="name" value="${esc(getTestUser()?.name ?? '')}" placeholder="Например, Мадина"></label>
    <label class="cx-f"><span>Ключ тестового доступа (TEST_KEY)</span><input name="key" type="password" value="${esc(getTestUser()?.key ?? '')}"></label>
    <button class="cx-btn acc" type="submit">Войти как тестер</button>
    <p class="cx-mut">Тот же вход, что в мини-приложении в браузере. Нужна роль «Владелец».</p></form>`;
}

async function go(s: Section, push = true) {
  if (s !== section()) {
    setQuery({ s: s === 'overview' ? null : s }, push);
  }
  render();
  await VIEWS[s].load();
}
shell.go = (s) => void go(s);

// ------------------------------------------------------------------ boot

hooks.onExpired = (msg) => {
  screen = 'expired';
  screenMsg = msg;
  render();
};

async function boot() {
  render();
  const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search); // never keep the token in the address bar
    try {
      const s = await capi.exchange(m[1]!);
      setSession({ token: s.session, expiresAt: s.expiresAt, name: s.name });
    } catch (e) {
      const err = e as ApiErr;
      testMode = (await capi.health().catch(() => ({ testMode: false }))).testMode;
      screen = err.status === 403 ? 'forbidden' : 'expired';
      screenMsg = err.message;
      return render();
    }
  }
  if (!authMode()) {
    testMode = (await capi.health().catch(() => ({ testMode: false }))).testMode;
    screen = 'login';
    return render();
  }
  try {
    me = await capi.me();
    testMode = me.testMode;
  } catch (e) {
    const err = e as ApiErr;
    testMode = (await capi.health().catch(() => ({ testMode: false }))).testMode;
    if (err.status === 401) { screen = getSession() ? 'expired' : 'login'; screenMsg = err.message; }
    else if (err.status === 403) { screen = 'forbidden'; screenMsg = err.message; }
    else { screen = 'expired'; screenMsg = err.message; }
    return render();
  }
  try {
    const rules = await fetchRules();
    levels.splice(0, levels.length, ...rules.levels.map((l) => ({ id: l.id, name: l.name })));
  } catch { /* the level filter just stays empty */ }
  screen = 'app';
  await go(section(), false);
}

async function fetchRules(): Promise<EditableRulesDTO> {
  const headers: Record<string, string> = {};
  const s = getSession();
  if (s) headers.Authorization = `Bearer ${s.token}`;
  else { const tu = getTestUser(); if (tu) { headers['X-Test-User'] = tu.id; headers['X-Test-Key'] = tu.key; headers['X-Test-Name'] = encodeURIComponent(tu.name); } }
  const res = await fetch('/api/owner/rules', { headers });
  if (!res.ok) throw new Error('rules');
  return res.json() as Promise<EditableRulesDTO>;
}

// ------------------------------------------------------------------ actions

acts.nav = (el, e) => {
  e.preventDefault();
  const s = el.dataset.s as Section;
  const qs = navQuery(s);
  history.pushState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  void go(s, false);
};
acts.preset = (el) => {
  const p = PRESETS.find(([k]) => k === el.dataset.k)?.[2]();
  if (!p) return;
  setQuery({ from: p.from, to: p.to }, true);
  void go(section(), false);
};
submits.period = (form) => {
  const fd = new FormData(form);
  const from = String(fd.get('from') ?? ''), to = String(fd.get('to') ?? '');
  if (!isDayKey(from) || !isDayKey(to) || from > to) { toast('Проверьте даты периода', 'error'); return; }
  setQuery({ from, to }, true);
  void go(section(), false);
};
acts.logout = async () => {
  if (authMode() === 'session') await capi.logout().catch(() => undefined);
  clearSession();
  me = null;
  screen = 'login';
  screenMsg = '';
  render();
  toast('Вы вышли из кабинета', 'ok');
};
submits.testLogin = async (form) => {
  const fd = new FormData(form);
  const name = String(fd.get('name') ?? '').trim(), key = String(fd.get('key') ?? '').trim();
  if (name.length < 2 || !key) { toast('Введите имя и ключ', 'error'); return; }
  const prev = getTestUser();
  if (prev) { try { localStorage.setItem('honey.testUser', JSON.stringify({ ...prev, name, key })); } catch { /* ignore */ } }
  else setTestUser(name, key);
  clearSession();
  screen = 'loading';
  await boot();
};
acts.becomeOwner = async () => {
  try { await capi.testRole('owner'); screen = 'loading'; await boot(); }
  catch (e) { toast((e as ApiErr).message, 'error'); }
};

// ------------------------------------------------------------------ events

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const fn = acts[el.dataset.act!];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch((err) => toast((err as Error).message || 'Ошибка', 'error')); }
});
document.addEventListener('change', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLInputElement>('[data-change]');
  if (el && changes[el.dataset.change!]) Promise.resolve(changes[el.dataset.change!]!(el)).catch((err) => toast((err as Error).message, 'error'));
});
document.addEventListener('submit', (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  const fn = submits[form.dataset.submit!];
  if (fn) Promise.resolve(fn(form)).catch((err) => toast((err as Error).message, 'error'));
});
window.addEventListener('popstate', () => { if (screen === 'app') void go(section(), false); });
wireChartTooltips(root);

void boot();
