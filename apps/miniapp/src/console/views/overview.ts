import type { ConsoleMetrics, ConsoleOverviewDTO } from '@honey/contracts';
import { ApiErr, capi } from '../api';
import { barChart } from '../chart';
import { acts, esc, fmt, fmtDay, pct, q, setQuery, shell, urlPeriod } from '../core';

let data: ConsoleOverviewDTO | null = null;
let error: string | null = null;
let loadedFor = '';

const METRICS: Array<[string, string, string]> = [
  ['revenue', 'Выручка', 'сум'],
  ['purchases', 'Покупки', 'шт.'],
  ['buyers', 'Покупатели', 'чел.'],
];

export async function loadOverview(force = false) {
  const { from, to } = urlPeriod();
  const key = `${from}|${to}`;
  if (!force && key === loadedFor && data) return;
  loadedFor = key;
  error = null;
  data = null;
  shell.renderView();
  try {
    const d = await capi.overview(new URLSearchParams({ from, to }).toString());
    if (loadedFor === key) data = d;
  } catch (e) {
    error = (e as ApiErr).message;
  }
  shell.renderView();
}

function delta(cur: number, prev: number, isShare = false, lowerIsBetter = false): string {
  if (!prev && !cur) return '<span class="cx-delta">без изменений</span>';
  if (!prev) return '<span class="cx-delta" title="В прошлом периоде данных нет">новое</span>';
  const d = isShare ? cur - prev : (cur - prev) / prev;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const good = lowerIsBetter ? d < 0 : d > 0;
  const txt = isShare ? `${sign}${Math.abs(d * 100).toFixed(1).replace('.', ',')} п.п.` : `${sign}${pct(Math.abs(d))}`;
  return `<span class="cx-delta ${d === 0 ? '' : good ? 'up' : 'down'}" title="Прошлый период">${d > 0 ? '▲' : d < 0 ? '▼' : ''} ${txt}</span>`;
}

function tile(label: string, value: string, cur: number, prev: number, prevText: string, opts: { share?: boolean; lowerIsBetter?: boolean; hint?: string } = {}) {
  return `<div class="cx-kpi"${opts.hint ? ` title="${esc(opts.hint)}"` : ''}>
    <div class="cx-kpi-l">${esc(label)}</div>
    <div class="cx-kpi-v">${value}</div>
    <div class="cx-kpi-d">${delta(cur, prev, opts.share, opts.lowerIsBetter)} <span class="cx-mut">было ${prevText}</span></div></div>`;
}

function tiles(c: ConsoleMetrics, p: ConsoleMetrics) {
  return `<div class="cx-kpis">
    ${tile('Выручка через программу, сум', fmt(c.revenue), c.revenue, p.revenue, fmt(p.revenue), { hint: 'Сумма покупок с картой, без отменённых' })}
    ${tile('Покупок', fmt(c.purchases), c.purchases, p.purchases, fmt(p.purchases))}
    ${tile('Средний чек, сум', fmt(c.avgCheck), c.avgCheck, p.avgCheck, fmt(p.avgCheck))}
    ${tile('Активных клиентов', fmt(c.activeClients), c.activeClients, p.activeClients, fmt(p.activeClients), { hint: 'Купили хотя бы раз за период' })}
    ${tile('Новых клиентов', fmt(c.newClients), c.newClients, p.newClients, fmt(p.newClients), { hint: 'Зарегистрировались в Telegram за период (импортированные не считаются)' })}
    ${tile('Повторные покупки', pct(c.repeatShare), c.repeatShare, p.repeatShare, pct(p.repeatShare), { share: true, hint: 'Доля покупок от клиентов, которые уже покупали раньше' })}
  </div>
  <h3 class="cx-h3">Мёд и подарки</h3>
  <div class="cx-kpis small">
    ${tile('Мёда начислено', fmt(c.honeyAccrued), c.honeyAccrued, p.honeyAccrued, fmt(p.honeyAccrued), { hint: 'Кешбэк, бонусы и ручные начисления за вычетом отмен. Стартовый мёд из импорта не входит' })}
    ${tile('Мёда списано', fmt(c.honeyRedeemed), c.honeyRedeemed, p.honeyRedeemed, fmt(p.honeyRedeemed))}
    ${tile('Мёда сгорело', fmt(c.honeyExpired), c.honeyExpired, p.honeyExpired, fmt(p.honeyExpired), { lowerIsBetter: true })}
    ${tile('Подарков открыто', fmt(c.giftsUnlocked), c.giftsUnlocked, p.giftsUnlocked, fmt(p.giftsUnlocked))}
    ${tile('Подарков выдано', fmt(c.giftsUsed), c.giftsUsed, p.giftsUsed, fmt(p.giftsUsed))}
  </div>`;
}

export function overviewView(): string {
  if (error) return `<div class="cx-err">${esc(error)} <button class="cx-link" data-act="ovReload">Повторить</button></div>`;
  if (!data) return '<div class="cx-loading">Считаем…</div>';
  const d = data;
  const metric = METRICS.find(([k]) => k === q().get('m')) ?? METRICS[0]!;
  const gLabel = { day: 'по дням', week: 'по неделям', month: 'по месяцам' }[d.granularity];
  const points = d.series.map((s) => ({
    label: d.granularity === 'month' ? fmtDay(s.bucket).replace(/^1 /, '') : fmtDay(s.bucket),
    title: d.granularity === 'day' ? fmtDay(s.bucket, true) : d.granularity === 'week' ? `неделя с ${fmtDay(s.bucket, true)}` : fmtDay(s.bucket, true).replace(/^1 /, ''),
    value: metric[0] === 'revenue' ? s.revenue : metric[0] === 'purchases' ? s.purchases : s.buyers,
  }));
  return `<p class="cx-mut cx-sub">${fmtDay(d.from, true)} — ${fmtDay(d.to, true)} · сравнение с ${fmtDay(d.prevFrom, true)} — ${fmtDay(d.prevTo, true)}</p>
    ${tiles(d.current, d.previous)}
    <div class="cx-card">
      <div class="cx-card-h"><h3 class="cx-h3">${esc(metric[1])} ${gLabel}</h3>
        <div class="cx-seg" role="group" aria-label="Показатель">${METRICS.map(([k, l]) => `<button data-act="ovMetric" data-m="${k}" aria-pressed="${k === metric[0]}">${l}</button>`).join('')}</div></div>
      ${barChart(points, metric[2], `${metric[1]} ${gLabel}`)}
    </div>`;
}

acts.ovReload = () => loadOverview(true);
acts.ovMetric = (el) => {
  setQuery({ m: el.dataset.m === 'revenue' ? null : el.dataset.m });
  shell.renderView();
};
