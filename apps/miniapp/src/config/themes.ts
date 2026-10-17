/**
 * ДИЗАЙН — единственное место, где задаётся внешний вид Mini App.
 * Новый бренд = новая запись в THEMES (или правка существующей): палитра светлая и тёмная,
 * шрифты, скругления, форма ячейки, маскот (пчёлка), цветок в ячейке.
 * Активная тема — ACTIVE_THEME. Логика и экраны тему не знают, только CSS-переменные.
 */

export type CellShape = 'hex' | 'circle' | 'softhex';

export interface Theme {
  name: string;
  fonts: { display: string; body: string; weight: number; spacing: string };
  radius: { card: string; btn: string };
  cell: CellShape;
  light: Record<string, string>;
  dark: Record<string, string>;
  /** SVG of a flower drawn inside a filled cell, centred at (cx, cy), ~30px wide */
  bloom: (cx: number, cy: number) => string;
  /** SVG of the mascot, centred at (0,0), ~40px wide at scale 1 */
  mascot: (scale?: number) => string;
}

const BEE = (s = 1) => `<g transform="scale(${s})">
  <ellipse class="wing" cx="-4" cy="-13" rx="8" ry="6"/><ellipse class="wing b" cx="6" cy="-13" rx="7" ry="5.5"/>
  <ellipse class="bee-body" cx="0" cy="0" rx="14" ry="9.5"/>
  <path class="bee-stripe" d="M-5 -8.5Q-7 0 -5 8.5"/><path class="bee-stripe" d="M3 -8.8Q1 0 3 8.8"/>
  <circle class="bee-head" cx="16" cy="-1" r="6.5"/><circle class="bee-eye" cx="18" cy="-2.6" r="1.5"/>
  <path d="M-14 0h-5" stroke="var(--c-bee-stripe)" stroke-width="1.6" stroke-linecap="round"/></g>`;

export const THEMES: Record<string, Theme> = {
  honey: {
    name: 'Медовый',
    fonts: { display: '"Unbounded", "Arial Black", sans-serif', body: '"Golos Text", "Segoe UI", sans-serif', weight: 700, spacing: '-0.01em' },
    radius: { card: '22px', btn: '14px' },
    cell: 'hex',
    light: { bg: '#FFFDF8', surface: '#FFFFFF', surface2: '#F7F0E1', ink: '#2A1C0D', muted: '#7A6A55', line: '#ECE1CB',
      accent: '#E8A317', 'accent-deep': '#A86A06', 'on-accent': '#2A1C0D', comb: '#F6CF6E', cell: '#FFFFFF', 'cell-line': '#E9DCC2',
      petal: '#F2A7B8', 'petal-deep': '#D9708A', good: '#4F7C47', bad: '#C2412D', notif: '#2A1C0D', 'notif-ink': '#FFF7E8',
      'bee-body': '#F6C431', 'bee-line': '#2A1C0D', 'bee-stripe': '#2A1C0D', wing: '#FFFFFF' },
    dark: { bg: '#17130D', surface: '#211B12', surface2: '#2B2317', ink: '#F6EBD6', muted: '#B8A78C', line: '#3A2F20',
      accent: '#F2B23A', 'accent-deep': '#F6C460', 'on-accent': '#1F1505', comb: '#8A5F14', cell: '#211B12', 'cell-line': '#47392A',
      petal: '#E68FA4', 'petal-deep': '#F2A9BA', good: '#8DB580', bad: '#F08A76', notif: '#F6EBD6', 'notif-ink': '#1F1505',
      'bee-body': '#F6C431', 'bee-line': '#1F1505', 'bee-stripe': '#1F1505', wing: '#FFF8EA' },
    bloom: (cx, cy) => { let p = ''; for (let k = 0; k < 5; k++) { const a = (-90 + k * 72) * Math.PI / 180; p += `<circle cx="${(cx + 8 * Math.cos(a)).toFixed(1)}" cy="${(cy + 8 * Math.sin(a)).toFixed(1)}" r="6.6" fill="var(--c-petal)"/>`; } return p + `<circle cx="${cx}" cy="${cy}" r="5.2" fill="var(--c-accent)"/>`; },
    mascot: BEE,
  },
  minimal: {
    name: 'Минимал',
    fonts: { display: '"Cormorant Garamond", Georgia, serif', body: '"Manrope", "Segoe UI", sans-serif', weight: 600, spacing: '0' },
    radius: { card: '6px', btn: '4px' },
    cell: 'circle',
    light: { bg: '#FBFAF7', surface: '#FFFFFF', surface2: '#F2F0EB', ink: '#141414', muted: '#77736B', line: '#E2DED6',
      accent: '#141414', 'accent-deep': '#9A7B3C', 'on-accent': '#F7F3EA', comb: '#E9DFC8', cell: '#FFFFFF', 'cell-line': '#D9D4CA',
      petal: '#C9A86A', 'petal-deep': '#9A7B3C', good: '#3E6B4E', bad: '#A33A2A', notif: '#141414', 'notif-ink': '#F7F3EA',
      'bee-body': '#FFFFFF', 'bee-line': '#141414', 'bee-stripe': '#141414', wing: '#FFFFFF' },
    dark: { bg: '#0F0F0E', surface: '#181816', surface2: '#21201D', ink: '#F2EEE6', muted: '#A39E94', line: '#33312C',
      accent: '#E8DDC4', 'accent-deep': '#D4B475', 'on-accent': '#141414', comb: '#4A3F2A', cell: '#181816', 'cell-line': '#3A3833',
      petal: '#D4B475', 'petal-deep': '#E2C68E', good: '#88B596', bad: '#E7907F', notif: '#F2EEE6', 'notif-ink': '#141414',
      'bee-body': '#181816', 'bee-line': '#F2EEE6', 'bee-stripe': '#F2EEE6', wing: '#21201D' },
    bloom: (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="13" fill="none" stroke="var(--c-petal-deep)" stroke-width="1.2"/><circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="var(--c-petal-deep)" stroke-width="1.2"/><circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="var(--c-petal-deep)" stroke-width="1.2"/><circle cx="${cx}" cy="${cy}" r="2" fill="var(--c-petal-deep)"/>`,
    mascot: BEE,
  },
  powder: {
    name: 'Пудровый',
    fonts: { display: '"Comfortaa", "Trebuchet MS", sans-serif', body: '"Nunito", "Segoe UI", sans-serif', weight: 700, spacing: '0' },
    radius: { card: '28px', btn: '20px' },
    cell: 'softhex',
    light: { bg: '#FFF8F7', surface: '#FFFFFF', surface2: '#FCEBEA', ink: '#3B2730', muted: '#8E7480', line: '#F3D9DB',
      accent: '#E98BA0', 'accent-deep': '#B4506A', 'on-accent': '#FFFFFF', comb: '#F8C9D2', cell: '#FFFFFF', 'cell-line': '#F0D3D7',
      petal: '#F4B3C1', 'petal-deep': '#C9617B', good: '#5F8E6B', bad: '#B53A3A', notif: '#3B2730', 'notif-ink': '#FFF1F3',
      'bee-body': '#FFD66B', 'bee-line': '#3B2730', 'bee-stripe': '#3B2730', wing: '#FFFFFF' },
    dark: { bg: '#1A1215', surface: '#24181D', surface2: '#2F2026', ink: '#FBE9EE', muted: '#C6A7B2', line: '#43303A',
      accent: '#F09AAE', 'accent-deep': '#F7B6C4', 'on-accent': '#2A1219', comb: '#7A3A4B', cell: '#24181D', 'cell-line': '#4E3743',
      petal: '#E99AAC', 'petal-deep': '#F7B6C4', good: '#93C29F', bad: '#F2958A', notif: '#FBE9EE', 'notif-ink': '#2A1219',
      'bee-body': '#FFD66B', 'bee-line': '#2A1219', 'bee-stripe': '#2A1219', wing: '#FFF5F7' },
    bloom: (cx, cy) => { let p = ''; for (let k = 0; k < 8; k++) p += `<ellipse cx="${cx}" cy="${cy - 8}" rx="5" ry="8.5" fill="var(--c-petal)" opacity=".85" transform="rotate(${k * 45} ${cx} ${cy})"/>`; for (let k = 0; k < 5; k++) p += `<ellipse cx="${cx}" cy="${cy - 4.5}" rx="3.6" ry="5.5" fill="var(--c-petal-deep)" transform="rotate(${k * 72 + 20} ${cx} ${cy})"/>`; return p + `<circle cx="${cx}" cy="${cy}" r="2.6" fill="var(--c-bee-body)"/>`; },
    mascot: BEE,
  },
};

/** Тема по умолчанию. В TEST_MODE её можно переключить на панели тестирования. */
export const ACTIVE_THEME = 'honey';

export function applyTheme(id: string, dark: boolean, root: HTMLElement = document.documentElement): Theme {
  const th = THEMES[id] ?? THEMES[ACTIVE_THEME];
  const pal = dark ? th.dark : th.light;
  for (const k in pal) root.style.setProperty('--c-' + k, pal[k]);
  root.style.setProperty('--font-display', th.fonts.display);
  root.style.setProperty('--font-body', th.fonts.body);
  root.style.setProperty('--fw-display', String(th.fonts.weight));
  root.style.setProperty('--ls-display', th.fonts.spacing);
  root.style.setProperty('--r-card', th.radius.card);
  root.style.setProperty('--r-btn', th.radius.btn);
  root.style.colorScheme = dark ? 'dark' : 'light';
  return th;
}
