/** Owner console: shared state, delegated actions, URL-backed filters, formatting. */

export type Section = 'overview' | 'clients' | 'ops' | 'cohorts' | 'import';
export const SECTIONS: Array<[Section, string]> = [
  ['overview', 'Обзор'],
  ['clients', 'Клиенты'],
  ['ops', 'Покупки'],
  ['cohorts', 'Удержание'],
  ['import', 'Импорт базы'],
];

/** Delegated handlers: data-act="x" (click), data-change="x" (change), data-submit="x" (form submit). */
export const acts: Record<string, (el: HTMLElement, e: Event) => void | Promise<void>> = {};
export const changes: Record<string, (el: HTMLInputElement | HTMLSelectElement) => void | Promise<void>> = {};
export const submits: Record<string, (form: HTMLFormElement) => void | Promise<void>> = {};

/** Set by main.ts. */
export const shell = {
  render: () => {},
  renderView: () => {},
  go: (_s: Section) => {},
};

// ------------------------------------------------------------------ URL state (bookmarkable views)

export const q = () => new URLSearchParams(location.search);

/** Replace some query params (null/'' deletes) and keep the rest. push = new history entry. */
export function setQuery(patch: Record<string, string | number | null | undefined>, push = false) {
  const p = q();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') p.delete(k);
    else p.set(k, String(v));
  }
  const url = `${location.pathname}${p.toString() ? `?${p}` : ''}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

export function section(): Section {
  const s = q().get('s');
  return (SECTIONS.find(([k]) => k === s)?.[0] ?? 'overview') as Section;
}

// ------------------------------------------------------------------ dates (Tashkent, UTC+5, no DST)

const TZ_MS = 5 * 3600_000;
export const todayKey = () => new Date(Date.now() + TZ_MS).toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const isDayKey = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The period of the URL (?from&to), default = the last 30 days. */
export function urlPeriod(): { from: string; to: string } {
  const p = q();
  const from = p.get('from');
  const to = p.get('to');
  if (isDayKey(from) && isDayKey(to) && from <= to) return { from, to };
  const t = todayKey();
  return { from: addDays(t, -29), to: t };
}

export const PRESETS: Array<[string, string, () => { from: string; to: string }]> = [
  ['7', '7 дней', () => ({ from: addDays(todayKey(), -6), to: todayKey() })],
  ['30', '30 дней', () => ({ from: addDays(todayKey(), -29), to: todayKey() })],
  ['90', '90 дней', () => ({ from: addDays(todayKey(), -89), to: todayKey() })],
  ['month', 'Этот месяц', () => ({ from: `${todayKey().slice(0, 8)}01`, to: todayKey() })],
  ['prev', 'Прошлый месяц', () => {
    const first = `${todayKey().slice(0, 8)}01`;
    const last = addDays(first, -1);
    return { from: `${last.slice(0, 8)}01`, to: last };
  }],
  ['year', '12 месяцев', () => ({ from: addDays(todayKey(), -364), to: todayKey() })],
];

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** '2026-09-03' → '3 сен 2026' (year omitted when it is the current one, unless forced). */
export function fmtDay(key: string | null | undefined, withYear = false): string {
  if (!key) return '—';
  const [y, m, d] = key.slice(0, 10).split('-').map(Number) as [number, number, number];
  const showYear = withYear || String(y) !== todayKey().slice(0, 4);
  return `${d} ${MONTHS[m - 1]}${showYear ? ` ${y}` : ''}`;
}
export const monthName = (ym: string) => `${MONTHS_NOM[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** ISO instant → Tashkent local 'YYYY-MM-DD HH:MM'. */
export function tashkent(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(Date.parse(iso) + TZ_MS).toISOString().slice(0, 16).replace('T', ' ');
}
export const tashkentDay = (iso: string | null | undefined) => (iso ? tashkent(iso).slice(0, 10) : null);

// ------------------------------------------------------------------ numbers / html

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace('.', ',')}%`;

/** Compact money for axes: 1 250 000 → "1,3 млн". */
export function short(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} млрд`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} млн`;
  if (a >= 1e4) return `${Math.round(n / 1e3)} тыс`;
  return fmt(n);
}

export function plural(n: number, one: string, few: string, many: string) {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? few : many;
}

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const t = document.createElement('div');
  t.className = `cx-toast ${kind}`;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 2800);
}

/** Integer from a filter input ("1 200 000" ok), or '' when empty/invalid. */
export function intParam(v: string | null | undefined): string {
  if (!v) return '';
  const n = Number(String(v).replace(/[\s ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : '';
}
