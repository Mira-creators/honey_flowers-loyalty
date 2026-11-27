/** Small DOM helpers: escaping, formatting, toasts, modals, sheets, confetti. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const sleep = (ms: number) => new Promise(r => setTimeout(r, reduceMotion() ? 0 : ms));

const TOAST_IC: Record<'info' | 'error' | 'ok', string> = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/></svg>',
  info: '',
};
/** Короткое сообщение внизу экрана. ok — зелень клевера, error — красный, info — тёмный. Встаёт над вкладками. */
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info') {
  document.querySelectorAll('.toast').forEach(o => o.remove()); // one at a time: a new message replaces the old
  const t = document.createElement('div');
  t.className = 'toast ' + kind + (document.querySelector('.tabs') ? ' has-tabs' : '');
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.innerHTML = TOAST_IC[kind]; const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 3800 : 2200);
  setTimeout(() => t.remove(), kind === 'error' ? 4200 : 2600);
}

const layer = () => $('layer')!;
export function closeLayer() { layer().innerHTML = ''; }

/** Centered modal. `onBtn` may return false to keep it open (e.g. two-step reveal). */
export function modal(html: string, btnText: string, onBtn?: () => boolean | void): Promise<void> {
  layer().innerHTML = `<div class="modal"><div class="mcard">${html}<button class="b acc full" id="mBtn">${esc(btnText)}</button></div></div>`;
  return new Promise(res => {
    $('mBtn')!.onclick = () => { if (onBtn && onBtn() === false) return; closeLayer(); res(); };
  });
}

/** Bottom sheet with arbitrary content; returns the sheet element for wiring. */
export function sheet(html: string, onClose?: () => void): HTMLElement {
  layer().innerHTML = `<div class="sheet-bg" id="sheetBg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = $('sheetBg')!;
  bg.addEventListener('click', e => { if (e.target === bg) { closeLayer(); onClose?.(); } });
  return bg.querySelector('.sheet') as HTMLElement;
}

export function confetti() {
  if (reduceMotion()) return;
  const c = document.createElement('div'); c.className = 'confetti';
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = i % 3 ? 'var(--c-petal)' : 'var(--c-accent)';
    p.style.animationDuration = 1.7 + Math.random() * 1.6 + 's';
    p.style.animationDelay = Math.random() * 0.5 + 's';
    c.appendChild(p);
  }
  document.body.appendChild(c); setTimeout(() => c.remove(), 4200);
}

/** Debounce helper for live previews. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
