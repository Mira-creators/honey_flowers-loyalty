/** Honeycomb card: SVG drawing + motion (bee flight, honey pour, drop into balance). */
import type { CardDTO } from '@honey/contracts';
import type { Theme } from '../config/themes';
import { $, reduceMotion } from './dom';

// 10 cells laid out 3 · 4 · 3; the path snakes the way a bee would fly.
const POS: Record<number, [number, number]> = { 1: [94, 62], 2: [150, 62], 3: [206, 62], 4: [234, 110], 5: [178, 110], 6: [122, 110], 7: [66, 110], 8: [94, 158], 9: [150, 158], 10: [206, 158] };
const START: [number, number] = [38, 26];
const R = 29;

const hexPts = (cx: number, cy: number, r: number) => [-90, -30, 30, 90, 150, 210].map(a => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)] as [number, number]);

function shape(th: Theme, cx: number, cy: number, r: number, attrs: string) {
  if (th.cell === 'circle') return `<circle cx="${cx}" cy="${cy}" r="${(r * 0.9).toFixed(1)}" ${attrs}/>`;
  const v = hexPts(cx, cy, r);
  if (th.cell === 'hex') return `<polygon points="${v.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" ${attrs}/>`;
  const t = 0.26; let d = '';
  for (let i = 0; i < 6; i++) {
    const p = v[i], prev = v[(i + 5) % 6], next = v[(i + 1) % 6];
    const a = [p[0] + (prev[0] - p[0]) * t, p[1] + (prev[1] - p[1]) * t], b = [p[0] + (next[0] - p[0]) * t, p[1] + (next[1] - p[1]) * t];
    d += `${i ? 'L' : 'M'}${a[0].toFixed(1)} ${a[1].toFixed(1)}Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return `<path d="${d}Z" ${attrs}/>`;
}
export const giftIcon = (cx: number, cy: number, s = 1) => `<g class="gift-ic" transform="translate(${cx},${cy}) scale(${s})"><rect x="-10" y="-4" width="20" height="14" rx="2"/><rect x="-12" y="-9" width="24" height="6" rx="1.5"/><path d="M0 -9V10M0 -9c-3-7-11-6-8-1M0 -9c3-7 11-6 8-1"/></g>`;
export const giftSvg = `<svg viewBox="-16 -14 32 28" aria-hidden="true">${giftIcon(0, 0, 1)}</svg>`;

export const beeAt = (filled: number): [number, number] => filled <= 0 ? START : [POS[Math.min(filled, 10)][0] + 15, POS[Math.min(filled, 10)][1] - 24];

/** `filledShown` lets the caller draw the pre-purchase state while the bee is still flying. */
export function combSVG(th: Theme, card: CardDTO, filledShown: number, justFilled?: number) {
  let defs = '', g = '';
  const n = Math.min(card.cells, 10);
  for (let i = 1; i <= n; i++) {
    const [cx, cy] = POS[i];
    const done = i <= filledShown, gift = card.gifts[String(i)], next = i === filledShown + 1;
    defs += `<clipPath id="cp${i}">${shape(th, cx, cy, R, '')}</clipPath>`;
    g += shape(th, cx, cy, R, `id="cell${i}" class="${done ? 'c-done' : gift ? 'c-gift' : 'c-empty'}${next ? ' c-next' : ''}"`);
    if (done) {
      g += `<g clip-path="url(#cp${i})"><rect class="honey${i === justFilled ? ' pour' : ''}" x="${cx - R}" y="${cy - R}" width="${2 * R}" height="${2 * R}"/></g>`;
      g += `<g class="bloom${i === justFilled ? ' pop' : ''}">${gift ? giftIcon(cx, cy) : th.bloom(cx, cy)}</g>`;
    } else if (gift) g += `<text class="c-q" x="${cx}" y="${cy + 8}" text-anchor="middle">?</text>`;
    else g += `<text class="c-num" x="${cx}" y="${cy + 4}" text-anchor="middle">${i}</text>`;
  }
  const [bx, by] = beeAt(filledShown);
  return `<svg id="comb" viewBox="0 0 300 200" role="img" aria-label="${filledShown} / ${card.cells}"><defs>${defs}</defs>${g}<path id="trail" class="trail" d=""/><g id="bee" transform="translate(${bx},${by})"><g class="bee-idle">${th.mascot(0.8)}</g></g></svg>`;
}

export function fly(from: [number, number], to: [number, number]): Promise<void> {
  return new Promise(res => {
    const bee = $('bee'), trail = $('trail');
    if (!bee || !trail || reduceMotion()) return res();
    const cx = (from[0] + to[0]) / 2, cy = Math.min(from[1], to[1]) - 48;
    trail.setAttribute('d', `M${from[0]} ${from[1]}Q${cx} ${cy} ${to[0]} ${to[1]}`);
    const t0 = performance.now(), dur = 1050;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = (1 - e) ** 2 * from[0] + 2 * (1 - e) * e * cx + e * e * to[0];
      const y = (1 - e) ** 2 * from[1] + 2 * (1 - e) * e * cy + e * e * to[1];
      bee.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      if (t < 1) requestAnimationFrame(step); else { trail.setAttribute('d', ''); res(); }
    };
    requestAnimationFrame(step);
  });
}

export function dropToBalance(cell: number | null): Promise<void> {
  const dst = $('balN');
  if (reduceMotion() || !dst || typeof (dst as HTMLElement).animate !== 'function') return Promise.resolve();
  const src = cell ? document.getElementById('cell' + cell) : null;
  const a = src ? src.getBoundingClientRect() : { left: innerWidth / 2, top: 220, width: 0, height: 0 };
  const b = dst.getBoundingClientRect();
  const d = document.createElement('div'); d.className = 'drop'; document.body.appendChild(d);
  const x0 = a.left + a.width / 2 - 8, y0 = a.top + a.height / 2 - 10, x1 = b.left + 30, y1 = b.top + 4;
  const anim = d.animate([
    { transform: `translate(${x0}px,${y0}px) scale(1)` },
    { transform: `translate(${(x0 + x1) / 2 + 30}px,${Math.min(y0, y1) - 30}px) scale(1.1)`, offset: 0.45 },
    { transform: `translate(${x1}px,${y1}px) scale(.3)`, opacity: 0.3 },
  ], { duration: 750, easing: 'cubic-bezier(.45,0,.55,1)' });
  return anim.finished.then(() => {
    d.remove();
    const bal = $('bal'); if (bal) { bal.classList.remove('pulse'); void bal.offsetWidth; bal.classList.add('pulse'); }
  }, () => d.remove());
}

export function countUp(from: number, to: number, unit: string, fmt: (n: number) => string) {
  const el = $('balN'); if (!el) return;
  if (reduceMotion()) { el.innerHTML = `${fmt(to)}<small>${unit}</small>`; return; }
  const t0 = performance.now(), dur = 800;
  const step = (now: number) => { const t = Math.min(1, (now - t0) / dur); el.innerHTML = `${fmt(from + (to - from) * t)}<small>${unit}</small>`; if (t < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
