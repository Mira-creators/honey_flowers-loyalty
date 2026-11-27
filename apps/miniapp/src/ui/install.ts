/**
 * Подключение общих частей дизайн-системы (B1) — вызывается один раз из main.ts:
 *  - баннер «Нет интернета» / «Связь восстановлена» сверху экрана (без перерисовки экранов);
 *  - общее действие closeSheet для крестика в шапке листа (kit.sheetHead).
 */
import { S, actions } from '../state';
import { T } from '../config/texts';
import { closeLayer } from './dom';
import { KI } from './kit';

let bar: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function ensureBar(): HTMLElement {
  if (bar && bar.isConnected) return bar;
  bar = document.createElement('div');
  bar.className = 'net-bar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
  document.body.appendChild(bar);
  return bar;
}

/** Показать состояние сети. Экспортировано для витрины и тестов. */
export function showNet(online: boolean): void {
  const b = ensureBar(), t = T(S.lang);
  clearTimeout(hideTimer);
  b.innerHTML = `${online ? KI.online : KI.offline}<span>${online ? t.netBack : t.netOff}</span>`;
  b.classList.toggle('back', online);
  // Next frame, so the slide-in transition runs even right after creation.
  requestAnimationFrame(() => b.classList.add('on'));
  if (online) hideTimer = setTimeout(() => b.classList.remove('on'), 2500);
}

export function installUi(): void {
  addEventListener('offline', () => showNet(false));
  addEventListener('online', () => showNet(true));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) showNet(false);
  actions.closeSheet = () => closeLayer();
}
