/**
 * Hand-rolled SVG bar chart (no chart library): one series at a time (the owner switches the
 * metric — never two y-axes), theme accent bars with a 4px rounded top, recessive grid,
 * a hover tooltip per bar (hit target = the whole column), labels in ink colours.
 */
import { esc, fmt, short } from './core';

export interface BarPoint { label: string; title: string; value: number }

const W = 920, H = 260, PAD_L = 64, PAD_R = 12, PAD_T = 14, PAD_B = 34;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function barChart(points: BarPoint[], unit: string, ariaLabel: string): string {
  if (!points.length) return '<p class="cx-mut">Нет данных за период.</p>';
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
  const step = iw / points.length;
  const bw = Math.max(2, Math.min(36, step - 2)); // 2px surface gap between bars
  const y = (v: number) => PAD_T + ih - (v / max) * ih;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f, yy = y(v).toFixed(1);
    return `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yy}" y2="${yy}" class="cx-grid"/><text x="${PAD_L - 8}" y="${yy}" dy="4" text-anchor="end" class="cx-axis">${esc(short(v))}</text>`;
  }).join('');
  const every = Math.max(1, Math.ceil(points.length / 12));
  const bars = points.map((p, i) => {
    const x = PAD_L + i * step + (step - bw) / 2;
    const h = Math.max(p.value > 0 ? 1.5 : 0, (p.value / max) * ih);
    const top = PAD_T + ih - h;
    const r = Math.min(4, bw / 2, h);
    // Rounded top corners only; the data-end is anchored to the baseline.
    const d = h > 0
      ? `M${x.toFixed(1)},${(PAD_T + ih).toFixed(1)} V${(top + r).toFixed(1)} Q${x.toFixed(1)},${top.toFixed(1)} ${(x + r).toFixed(1)},${top.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)},${top.toFixed(1)} ${(x + bw).toFixed(1)},${(top + r).toFixed(1)} V${(PAD_T + ih).toFixed(1)} Z`
      : '';
    const label = i % every === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - PAD_B + 16}" text-anchor="middle" class="cx-axis">${esc(p.label)}</text>` : '';
    return `<g class="cx-bar" data-tip="${esc(`${p.title}: ${fmt(p.value)} ${unit}`)}">
      <rect x="${(PAD_L + i * step).toFixed(1)}" y="${PAD_T}" width="${step.toFixed(1)}" height="${ih}" class="cx-hit"/>
      ${d ? `<path d="${d}" class="cx-barfill"/>` : ''}${label}</g>`;
  }).join('');
  return `<div class="cx-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${grid}
    <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${PAD_T + ih}" y2="${PAD_T + ih}" class="cx-base"/>${bars}</svg><div class="cx-tip" hidden></div></div>`;
}

/** Hover tooltip for every .cx-bar (delegated; call once). */
export function wireChartTooltips(root: HTMLElement) {
  root.addEventListener('pointermove', (e) => {
    const bar = (e.target as Element).closest?.('.cx-bar') as SVGGElement | null;
    const chart = (e.target as Element).closest?.('.cx-chart') as HTMLElement | null;
    root.querySelectorAll('.cx-bar.on').forEach((b) => b !== bar && b.classList.remove('on'));
    const tip = chart?.querySelector<HTMLElement>('.cx-tip');
    if (!bar || !chart || !tip) {
      root.querySelectorAll<HTMLElement>('.cx-tip').forEach((t) => (t.hidden = true));
      return;
    }
    bar.classList.add('on');
    tip.textContent = bar.dataset.tip ?? '';
    tip.hidden = false;
    const r = chart.getBoundingClientRect();
    const x = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, e.clientX - r.left + 12));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(0, e.clientY - r.top - 36)}px`;
  });
  root.addEventListener('pointerleave', () => root.querySelectorAll<HTMLElement>('.cx-tip').forEach((t) => (t.hidden = true)));
}
