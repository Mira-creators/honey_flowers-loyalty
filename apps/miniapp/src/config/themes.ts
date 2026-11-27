/**
 * ДИЗАЙН — единственное место, где задаётся внешний вид Mini App.
 * Новый бренд = новая запись в THEMES (или правка существующей): палитра светлая и тёмная,
 * шрифты, скругления, форма ячейки, маскот (пчёлка), цветок в ячейке.
 * Активная тема — ACTIVE_THEME. Логика и экраны тему не знают, только CSS-переменные.
 * Шрифты подключены локально (@fontsource, без запросов к внешним серверам): Cormorant Garamond.
 * Шрифты старых тем (Unbounded, Golos, Manrope, Comfortaa, Nunito) больше не грузятся из Google —
 * у них работает запасной системный шрифт; чтобы вернуть, добавьте пакет @fontsource/<шрифт> в main.ts.
 * Маскот — шмель из ui/mascot.ts (рисунки подменяются файлами, см. src/assets/mascot/README.md).
 */
import { mascotG } from '../ui/mascot';

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

/** The mascot (a bumblebee placeholder until Мираслава's art; swappable by files, see ui/mascot.ts). */
const BEE = (s = 1) => mascotG('flying', s);

/** Clover head from the logo: a pink ball of florets over a green trefoil (~30 px). */
function cloverBloom(cx: number, cy: number): string {
  let leaves = '';
  for (const a of [210, 330, 90]) {
    const r = (a * Math.PI) / 180;
    leaves += `<circle cx="${(cx + 7.5 * Math.cos(r)).toFixed(1)}" cy="${(cy + 3 + 7.5 * Math.sin(r)).toFixed(1)}" r="6" fill="var(--c-leaf)" opacity=".9"/>`;
  }
  let head = `<circle cx="${cx}" cy="${cy - 2}" r="9.5" fill="var(--c-petal)"/>`;
  const pts: Array<[number, number]> = [[0, -9], [-5, -7], [5, -7], [-7.5, -2], [0, -3.5], [7.5, -2], [-4.5, 2.5], [4.5, 2.5], [0, 5.5]];
  for (const [dx, dy] of pts) head += `<ellipse cx="${cx + dx}" cy="${cy - 2 + dy}" rx="2.2" ry="3.2" fill="var(--c-petal-deep)" opacity=".75" transform="rotate(${dx * 4} ${cx + dx} ${cy - 2 + dy})"/>`;
  return leaves + head + `<path d="M${cx - 3} ${cy - 5}q3-2 6 0" stroke="#fff" stroke-width="1" fill="none" opacity=".7"/>`;
}

export const THEMES: Record<string, Theme> = {
  /**
   * «Клевер» — from the Honey Flowers logo (docs/brand/honey-logo.jpg): white / cream paper, clover
   * greens, clover pink, the amber of the HONEY lettering (#F89C00 sampled) for мёд and the main
   * buttons, dark text. Headings: Cormorant Garamond (bundled, @fontsource), like the logo's serif.
   */
  clover: {
    name: 'Клевер',
    fonts: { display: '"Cormorant Garamond", Georgia, "Times New Roman", serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', weight: 700, spacing: '0.005em' },
    radius: { card: '20px', btn: '14px' },
    cell: 'hex',
    light: { bg: '#FFFEFA', surface: '#FFFFFF', surface2: '#F7F5EC', ink: '#1F261B', muted: '#68705F', line: '#E4E7D8',
      accent: '#F49A00', 'accent-deep': '#A85F00', 'on-accent': '#241500', comb: '#F7BE4F', 'comb-hi': '#FFE3A1', cell: '#FFFFFF', 'cell-line': '#CFDDC2',
      petal: '#F4B3C2', 'petal-deep': '#B93A5B', good: '#3E7A3A', bad: '#B8402F', notif: '#1F261B', 'notif-ink': '#FFFCF2',
      'bee-body': '#F6B400', 'bee-line': '#1C1C17', 'bee-stripe': '#1C1C17', wing: '#FFFFFF', leaf: '#6A9A52', 'leaf-deep': '#3E7A3A',
      wash: 'radial-gradient(110% 55% at 0% 0%, rgba(106,154,82,.08), transparent 62%), radial-gradient(90% 45% at 100% 100%, rgba(210,77,110,.06), transparent 60%)',
      'comb-wash': 'radial-gradient(80% 70% at 30% 20%, rgba(247,190,79,.16), transparent 70%), radial-gradient(70% 60% at 85% 90%, rgba(106,154,82,.10), transparent 70%)',
      // Дизайн-система (B1): мягкие подложки, предупреждение, затемнение, тень, фокус.
      'on-bad': '#FFFFFF', 'on-petal': '#3A1420', 'on-good': '#FFFFFF', warn: '#9A5A00',
      'accent-soft': '#FFF7E8', 'good-soft': '#EAF3E4', 'bad-soft': '#FBEAE6', 'warn-soft': '#FFF2D6', 'petal-soft': '#FCE9EE', 'leaf-soft': '#EEF4E8',
      scrim: 'rgba(20,24,16,.48)', shadow: 'rgba(31,38,27,.16)', focus: '#3E7A3A', 'qr-bg': '#FFFFFF', skel: '#EFEEE4', 'skel-hi': '#F8F7F0' },
    dark: { bg: '#131911', surface: '#1B2318', surface2: '#232E20', ink: '#F3F1E6', muted: '#ADB5A1', line: '#33402E',
      accent: '#F7A928', 'accent-deep': '#FFC566', 'on-accent': '#1C1200', comb: '#A86C0A', 'comb-hi': '#D9952A', cell: '#1B2318', 'cell-line': '#3B4A34',
      petal: '#E58BA1', 'petal-deep': '#F3A6B9', good: '#8DC17F', bad: '#F08A76', notif: '#F3F1E6', 'notif-ink': '#131911',
      'bee-body': '#F6B400', 'bee-line': '#0D110C', 'bee-stripe': '#0D110C', wing: '#E9F0E2', leaf: '#7FB069', 'leaf-deep': '#9FCC89',
      wash: 'radial-gradient(110% 55% at 0% 0%, rgba(127,176,105,.08), transparent 62%), radial-gradient(90% 45% at 100% 100%, rgba(229,139,161,.06), transparent 60%)',
      'comb-wash': 'radial-gradient(80% 70% at 30% 20%, rgba(247,169,40,.10), transparent 70%)',
      'on-bad': '#1A0B07', 'on-petal': '#2A0F18', 'on-good': '#10190E', warn: '#FFC566',
      'accent-soft': '#3A2C10', 'good-soft': '#223221', 'bad-soft': '#3A211C', 'warn-soft': '#3A2E14', 'petal-soft': '#3A2028', 'leaf-soft': '#22301E',
      scrim: 'rgba(0,0,0,.6)', shadow: 'rgba(0,0,0,.5)', focus: '#9FCC89', 'qr-bg': '#FFFFFF', skel: '#232E20', 'skel-hi': '#2D3A29' },
    bloom: cloverBloom,
    mascot: BEE,
  },
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
export const ACTIVE_THEME = 'clover';

/**
 * Роли цветов дизайн-системы (B1), которых может не быть в теме: выводятся из основных.
 * Полный список ролей и где их применять — src/ui/README.md.
 */
export const COLOR_ROLES = ['bg', 'surface', 'surface2', 'ink', 'muted', 'line', 'accent', 'accent-deep', 'on-accent', 'accent-soft',
  'leaf', 'leaf-deep', 'leaf-soft', 'petal', 'petal-deep', 'petal-soft', 'on-petal', 'good', 'good-soft', 'on-good', 'bad', 'bad-soft', 'on-bad',
  'warn', 'warn-soft', 'scrim', 'shadow', 'focus', 'notif', 'notif-ink', 'qr-bg', 'knob', 'skel', 'skel-hi'] as const;

function themeDefaults(pal: Record<string, string>, dark: boolean): Record<string, string> {
  const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, ${pal.surface})`;
  return {
    'comb-hi': pal.comb, leaf: pal.good, 'leaf-deep': pal.good, wash: 'none', 'comb-wash': 'none',
    'on-bad': '#FFFFFF', 'on-petal': pal.ink, 'on-good': '#FFFFFF', warn: pal['accent-deep'],
    'accent-soft': mix(pal.accent, 16), 'good-soft': mix(pal.good, 14), 'bad-soft': mix(pal.bad, 14), 'warn-soft': mix(pal.accent, 22),
    'petal-soft': mix(pal.petal, 30), 'leaf-soft': mix(pal.good, 12),
    scrim: dark ? 'rgba(0,0,0,.6)' : 'rgba(15,10,4,.5)', shadow: dark ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.16)', focus: pal.accent,
    'qr-bg': '#FFFFFF', knob: '#FFFFFF', skel: pal.surface2, 'skel-hi': pal.surface,
  };
}

export function applyTheme(id: string, dark: boolean, root: HTMLElement = document.documentElement): Theme {
  const th = THEMES[id] ?? THEMES[ACTIVE_THEME];
  const pal = dark ? th.dark : th.light;
  // Optional entries (themes before «Клевер» do not define them).
  const full: Record<string, string> = { ...themeDefaults(pal, dark), ...pal };
  for (const k in full) root.style.setProperty('--c-' + k, full[k]);
  root.style.setProperty('--font-display', th.fonts.display);
  root.style.setProperty('--font-body', th.fonts.body);
  root.style.setProperty('--fw-display', String(th.fonts.weight));
  root.style.setProperty('--ls-display', th.fonts.spacing);
  root.style.setProperty('--r-card', th.radius.card);
  root.style.setProperty('--r-btn', th.radius.btn);
  root.style.colorScheme = dark ? 'dark' : 'light';
  return th;
}
