/**
 * КОМПОНЕНТЫ дизайн-системы (B1): функции, которые отдают готовую разметку.
 * Экраны (и чат «Склад») собирают интерфейс из них, а не пишут классы и стили руками:
 *   btn, field, card, note, tag, kv, sheetHead, pageHead, sprig — строительные блоки;
 *   loadingState, skeleton, emptyState, errorState — состояния экрана;
 *   busy — защита от двойного нажатия; net (ui/net.ts) — баннер «нет сети».
 * Стили — ui/components.css, токены — ui/tokens.css, цвета — config/themes.ts. Витрина — screens/kitShowcase.ts.
 * Все тексты, которые приходят сюда, экранируются, кроме полей с суффиксом Html (их готовит вызывающий).
 */
import { esc } from './dom';
import { mascotSvg, type MascotPose } from './mascot';

/* ---------- иконки состояний (24×24, цвет — currentColor) ---------- */
const svg = (body: string, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const KI = {
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/>'),
  warn: svg('<path d="M12 3.5l9 16H3z"/><path d="M12 10v4.5M12 17.3v.2"/>'),
  bad: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  gift: svg('<rect x="4" y="10" width="16" height="10" rx="1.5"/><rect x="3" y="7" width="18" height="4" rx="1"/><path d="M12 7v13M12 7c-2-5-8-4-6-1M12 7c2-5 8-4 6-1"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 2),
  offline: svg('<path d="M2.5 9a15 15 0 0119 0M5.5 12.5a10.5 10.5 0 0113 0M8.7 16a5.6 5.6 0 016.6 0"/><circle cx="12" cy="19.5" r=".6" fill="currentColor"/><path d="M3 3l18 18"/>'),
  online: svg('<path d="M2.5 9a15 15 0 0119 0M5.5 12.5a10.5 10.5 0 0113 0M8.7 16a5.6 5.6 0 016.6 0"/><circle cx="12" cy="19.5" r=".6" fill="currentColor"/>'),
  /** Веточка клевера для разделителей. */
  sprig: `<svg viewBox="0 0 22 14" aria-hidden="true"><path d="M1 12C6 11 9 8 11 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="11" cy="4" r="2.6" fill="var(--c-leaf)"/><circle cx="14.5" cy="5.5" r="2.6" fill="var(--c-leaf)"/><circle cx="12.8" cy="1.9" r="2.4" fill="var(--c-leaf)"/><circle cx="18.5" cy="9.5" r="2.8" fill="var(--c-petal)"/></svg>`,
};

type Kind = 'info' | 'good' | 'warn' | 'bad' | 'gift';
const KIND_IC: Record<Kind, string> = { info: KI.info, good: KI.ok, warn: KI.warn, bad: KI.bad, gift: KI.gift };

/** Атрибуты data-act и прочие data-* для кнопок, как принято в main.ts (делегированные события). */
type Data = Record<string, string | number | undefined>;
const dataAttrs = (d?: Data) => d ? Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('') : '';

/* ---------- Кнопки ---------- */
export type BtnVariant = 'primary' | 'secondary' | 'dark' | 'ghost' | 'leaf' | 'soft' | 'danger' | 'danger-outline';
const VARIANT_CLS: Record<BtnVariant, string> = { primary: 'acc', secondary: '', dark: 'pri', ghost: 'ghost', leaf: 'leaf', soft: 'soft', danger: 'danger', 'danger-outline': 'danger-outline' };
export interface BtnOpts {
  /** Действие (data-act) — обработчик в actions. */
  act?: string; data?: Data; id?: string;
  variant?: BtnVariant;
  /** sm — 36 px (вторичные в плотных списках), md — 44 px, lg — 52 px (главное действие кассы). */
  size?: 'sm' | 'md' | 'lg';
  full?: boolean; disabled?: boolean; busy?: boolean;
  /** Иконка (SVG) перед текстом. */
  iconHtml?: string;
  /** Подпись для экранного диктора, если на кнопке только иконка. */
  label?: string;
  type?: 'button' | 'submit';
}
/** Кнопка. Главная на экране — одна, variant 'primary' (янтарь HONEY). */
export function btn(text: string, o: BtnOpts = {}): string {
  const cls = ['b', VARIANT_CLS[o.variant ?? 'secondary'], o.size === 'lg' ? 'big' : o.size === 'sm' ? 'sm' : '', o.full ? 'full' : '',
    o.busy ? 'is-busy' : '', !text && o.iconHtml ? 'ic-only' : ''].filter(Boolean).join(' ');
  const act = o.act ? ` data-act="${esc(o.act)}"` : '';
  const aria = o.label ? ` aria-label="${esc(o.label)}"` : '';
  return `<button type="${o.type ?? 'button'}" class="${cls}"${o.id ? ` id="${esc(o.id)}"` : ''}${act}${dataAttrs(o.data)}${aria}${o.disabled || o.busy ? ' disabled' : ''}${o.busy ? ' aria-busy="true"' : ''}>${o.iconHtml ?? ''}${text ? `<span>${esc(text)}</span>` : ''}</button>`;
}

/* ---------- Поля ---------- */
export interface FieldOpts {
  id: string; label: string;
  value?: string | number; placeholder?: string; hint?: string; error?: string;
  type?: 'text' | 'tel' | 'number' | 'date' | 'search' | 'password';
  inputmode?: 'numeric' | 'decimal' | 'tel' | 'text' | 'search';
  /** Подпись справа внутри поля, например «сум». */
  suffix?: string;
  autocomplete?: string; maxlength?: number; disabled?: boolean; required?: boolean;
  /** Готовый <select>/<textarea> вместо <input>. */
  controlHtml?: string;
}
/** Поле с подписью, подсказкой и ошибкой. Ошибку можно показать позже: setFieldError(id, text). */
export function field(o: FieldOpts): string {
  const hintId = `${o.id}-h`, errId = `${o.id}-e`;
  const input = o.controlHtml ?? `<input id="${esc(o.id)}" type="${o.type ?? 'text'}"${o.inputmode ? ` inputmode="${o.inputmode}"` : ''}${o.value !== undefined ? ` value="${esc(o.value)}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.autocomplete ? ` autocomplete="${esc(o.autocomplete)}"` : ''}${o.maxlength ? ` maxlength="${o.maxlength}"` : ''}${o.disabled ? ' disabled' : ''}${o.required ? ' required' : ''} aria-describedby="${hintId} ${errId}"${o.error ? ' aria-invalid="true"' : ''}>`;
  return `<div class="field${o.error ? ' err' : ''}" data-field="${esc(o.id)}">
    <label for="${esc(o.id)}">${esc(o.label)}</label>
    ${o.suffix ? `<div class="affix">${input}<span>${esc(o.suffix)}</span></div>` : input}
    <div class="hint" id="${hintId}">${o.hint ? esc(o.hint) : ''}</div>
    <div class="err-t" id="${errId}" role="alert">${o.error ? esc(o.error) : ''}</div>
  </div>`;
}
/** Показать или снять ошибку у поля без перерисовки экрана. */
export function setFieldError(id: string, error: string | null): void {
  const box = document.querySelector<HTMLElement>(`[data-field="${id.replace(/["\\]/g, '\\$&')}"]`);
  if (!box) return;
  box.classList.toggle('err', !!error);
  const e = box.querySelector('.err-t'); if (e) e.textContent = error ?? '';
  box.querySelector('input,select,textarea')?.toggleAttribute('aria-invalid', !!error);
}

/* ---------- Карточки, плашки, бейджи, строки ---------- */
export function card(bodyHtml: string, o: { tone?: 'plain' | 'soft' | 'honey' | 'raised'; titleHtml?: string; asideHtml?: string; over?: string } = {}): string {
  const head = o.titleHtml || o.asideHtml ? `<div class="card-h"><h3>${o.titleHtml ?? ''}</h3>${o.asideHtml ?? ''}</div>` : '';
  return `<section class="card${o.tone && o.tone !== 'plain' ? ' ' + o.tone : ''}">${o.over ? `<div class="over">${esc(o.over)}</div>` : ''}${head}${bodyHtml}</section>`;
}
/** Плашка-подсказка: info (зелень), good, warn (янтарь), bad, gift (розовый клевер). */
export function note(textHtml: string, kind: Kind = 'info'): string {
  return `<div class="note ${kind}" role="${kind === 'bad' || kind === 'warn' ? 'alert' : 'note'}">${KIND_IC[kind]}<div>${textHtml}</div></div>`;
}
export function tag(text: string, tone: 'plain' | 'honey' | 'good' | 'bad' | 'warn' | 'gift' = 'plain'): string {
  return `<span class="tag${tone === 'plain' ? '' : ' ' + tone}">${esc(text)}</span>`;
}
/** Строка «ключ — значение» (предпросмотр начисления, итог чека). */
export function kv(key: string, valueHtml: string, tone?: 'honey' | 'good' | 'gift'): string {
  return `<div class="kv"><span>${esc(key)}</span><b${tone ? ` class="${tone}"` : ''}>${valueHtml}</b></div>`;
}
export const sprig = () => `<div class="sprig" aria-hidden="true">${KI.sprig}</div>`;
export function pageHead(title: string, o: { sub?: string; asideHtml?: string } = {}): string {
  return `<header class="page-h"><div><h2>${esc(title)}</h2>${o.sub ? `<p>${esc(o.sub)}</p>` : ''}</div>${o.asideHtml ?? ''}</header>`;
}
/** Шапка листа с крестиком; закрытие — действие closeSheet (main.ts) или своё. */
export function sheetHead(title: string, o: { sub?: string; closeAct?: string; closeLabel?: string } = {}): string {
  return `<div class="sheet-h"><div><h4>${esc(title)}</h4>${o.sub ? `<p>${esc(o.sub)}</p>` : ''}</div><button class="x" data-act="${esc(o.closeAct ?? 'closeSheet')}" aria-label="${esc(o.closeLabel ?? 'Закрыть')}">${KI.close}</button></div>`;
}

/* ---------- Состояния экрана ---------- */
const art = (pose: MascotPose, cls = '') => `<div class="art">${mascotSvg(pose, 1.25, cls)}</div>`;

/** Загрузка: шмель летает, подпись под ним. Для списков лучше skeleton(). */
export function loadingState(text: string): string {
  return `<div class="state" role="status" aria-live="polite">${art('flying', 'bee-idle')}<p>${esc(text)}</p></div>`;
}
/** Скелет на месте будущего содержимого: h — заголовок, t — строка, s — короткая строка, blk — карточка, row — строка списка. */
export function skeleton(parts: Array<'h' | 't' | 's' | 'blk' | 'row'> = ['h', 'blk', 'row', 'row', 'row']): string {
  return `<div class="skel" aria-hidden="true">${parts.map(p => `<i${p === 't' ? '' : ` class="${p}"`}></i>`).join('')}</div>`;
}
export interface StateOpts { title: string; text?: string; action?: { text: string; act: string; data?: Data; variant?: BtnVariant }; compact?: boolean; pose?: MascotPose }
/** Пусто: шмель сидит, короткое объяснение и, если есть, что сделать. */
export function emptyState(o: StateOpts): string {
  return `<div class="state${o.compact ? ' compact' : ''}">${art(o.pose ?? 'sitting')}<h3>${esc(o.title)}</h3>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.action ? btn(o.action.text, { act: o.action.act, data: o.action.data, variant: o.action.variant ?? 'primary' }) : ''}</div>`;
}
/** Ошибка: что случилось человеческим языком и кнопка «Повторить». code — служебный номер мелко (для поддержки). */
export function errorState(o: StateOpts & { code?: string }): string {
  return `<div class="state error${o.compact ? ' compact' : ''}" role="alert">${art(o.pose ?? 'sitting')}<h3>${esc(o.title)}</h3>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.action ? btn(o.action.text, { act: o.action.act, data: o.action.data, variant: o.action.variant ?? 'primary' }) : ''}${o.code ? `<p class="code">${esc(o.code)}</p>` : ''}</div>`;
}

/* ---------- Защита от двойного нажатия ---------- */
const inFlight = new Set<string>();
/**
 * Выполнить действие один раз, пока оно не закончится: повторные нажатия игнорируются,
 * кнопка показывает «занято». key — что именно защищаем (например 'purchase'); btn — нажатая кнопка.
 * Возвращает undefined, если действие уже выполняется.
 */
export async function busy<R>(key: string, el: HTMLElement | null | undefined, fn: () => Promise<R>): Promise<R | undefined> {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  const b = el instanceof HTMLButtonElement ? el : null;
  const wasDisabled = b?.disabled ?? false;
  if (b) { b.classList.add('is-busy'); b.disabled = true; b.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  finally {
    inFlight.delete(key);
    // The button may have been re-rendered away; only restore one still in the document.
    if (b && b.isConnected) { b.classList.remove('is-busy'); b.disabled = wasDisabled; b.removeAttribute('aria-busy'); }
  }
}
export const isBusy = (key: string) => inFlight.has(key);
