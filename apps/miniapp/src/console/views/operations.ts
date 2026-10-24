import type { ConsoleOpKind, ConsoleOperationRow, ConsoleOperationsPageDTO, ConsoleOpsTotals, StaffDTO } from '@honey/contracts';
import { ApiErr, capi } from '../api';
import { acts, esc, fmt, intParam, q, setQuery, shell, submits, tashkent, toast, urlPeriod } from '../core';
import { csvLine, downloadCsv, EXPORT_CAP } from '../files';

export const KIND_LABELS: Record<ConsoleOpKind, string> = {
  purchase: 'Покупка',
  reversal: 'Отмена покупки',
  redeem: 'Списание мёда',
  adjust: 'Корректировка',
  gift: 'Выдача подарка',
  welcome: 'Приветственный бонус',
  expire: 'Сгорание мёда',
};
const KINDS = Object.keys(KIND_LABELS) as ConsoleOpKind[];

let staff: StaffDTO[] | null = null;
let rows: ConsoleOperationRow[] = [];
let page: ConsoleOperationsPageDTO | null = null;
let totals: ConsoleOpsTotals | null = null;
let error: string | null = null;
let loading = false;
let loadedFor = '';
let exporting: string | null = null;

function apiQuery(): URLSearchParams {
  const u = q();
  const { from, to } = urlPeriod();
  const out = new URLSearchParams({ from, to });
  const kinds = (u.get('kinds') ?? '').split(',').filter((k) => KINDS.includes(k as ConsoleOpKind));
  if (kinds.length) out.set('kinds', kinds.join(','));
  if (u.get('staff')) out.set('staff', u.get('staff')!);
  if (intParam(u.get('minAmount'))) out.set('minAmount', intParam(u.get('minAmount')));
  if (intParam(u.get('maxAmount'))) out.set('maxAmount', intParam(u.get('maxAmount')));
  return out;
}

export async function loadOps(force = false) {
  const key = apiQuery().toString();
  if (!force && key === loadedFor && page) return;
  loadedFor = key;
  page = null;
  rows = [];
  totals = null;
  error = null;
  loading = true;
  shell.renderView();
  try {
    const [p, st] = await Promise.all([capi.ops(`${key}&limit=100&totals=1`), staff ? Promise.resolve(staff) : capi.staff().catch(() => [])]);
    staff = st;
    if (key !== loadedFor) return;
    page = p;
    rows = p.rows;
    totals = p.totals;
  } catch (e) {
    error = (e as ApiErr).message;
  } finally {
    loading = false;
  }
  shell.renderView();
}

async function more() {
  if (!page?.nextCursor || loading) return;
  loading = true;
  shell.renderView();
  try {
    const key = loadedFor;
    const p = await capi.ops(`${key}&limit=100&cursor=${encodeURIComponent(page.nextCursor)}`);
    if (key !== loadedFor) return;
    rows = rows.concat(p.rows);
    page = { ...page, nextCursor: p.nextCursor };
  } catch (e) {
    toast((e as ApiErr).message, 'error');
  } finally {
    loading = false;
  }
  shell.renderView();
}

function filtersForm(): string {
  const u = q();
  const chosen = new Set((u.get('kinds') ?? '').split(',').filter(Boolean));
  const all = chosen.size === 0;
  return `<form class="cx-filters" data-submit="opsFilter">
    <fieldset class="cx-f"><legend>Тип операции</legend>${KINDS.map((k) => `<label class="cx-check"><input type="checkbox" name="kinds" value="${k}" ${all || chosen.has(k) ? 'checked' : ''}> ${KIND_LABELS[k]}</label>`).join('')}</fieldset>
    <label class="cx-f"><span>Сотрудник</span><select name="staff"><option value="">Все</option>${(staff ?? []).map((s) => `<option value="${esc(s.id)}" ${u.get('staff') === s.id ? 'selected' : ''}>${esc(s.name)}${s.active ? '' : ' (отключён)'}</option>`).join('')}</select></label>
    <label class="cx-f"><span>Сумма заказа, сум</span><span class="cx-range"><input name="minAmount" inputmode="numeric" placeholder="от" value="${esc(u.get('minAmount') ?? '')}"><input name="maxAmount" inputmode="numeric" placeholder="до" value="${esc(u.get('maxAmount') ?? '')}"></span>
      <small class="cx-mut">С суммой показываются только покупки и отмены</small></label>
    <div class="cx-f-actions"><button class="cx-btn acc" type="submit">Применить</button><button class="cx-btn" type="button" data-act="opsReset">Сбросить</button></div>
  </form>`;
}

function totalsBar(t: ConsoleOpsTotals): string {
  const p = t.byKind.purchase, r = t.byKind.reversal;
  const parts = KINDS.filter((k) => t.byKind[k].count > 0).map((k) => {
    const x = t.byKind[k];
    const money = k === 'purchase' || k === 'reversal' ? ` на ${fmt(x.amount)} сум` : '';
    const honey = x.points ? ` · мёд ${x.points > 0 ? '+' : '−'}${fmt(Math.abs(x.points))}` : '';
    return `<span class="cx-chip-stat"><b>${KIND_LABELS[k]}</b>: ${fmt(x.count)}${money}${honey}</span>`;
  });
  return `<div class="cx-sumbar wrap"><span><b>${fmt(t.count)}</b> операций</span>${parts.join('')}
    ${p.count ? `<span class="cx-chip-stat"><b>Итого покупок за вычетом отмен:</b> ${fmt(p.amount - r.amount)} сум</span>` : ''}
    <span class="cx-grow"></span><button class="cx-btn" data-act="opsExport" ${exporting || !t.count ? 'disabled' : ''}>${exporting ? esc(exporting) : `Скачать CSV (${fmt(Math.min(t.count, EXPORT_CAP))})`}</button></div>`;
}

const signed = (n: number) => (n ? `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}` : '0');

export function opsView(): string {
  const body = error
    ? `<div class="cx-err">${esc(error)} <button class="cx-link" data-act="opsReload">Повторить</button></div>`
    : !page
      ? '<div class="cx-loading">Загрузка…</div>'
      : !rows.length
        ? '<p class="cx-mut">За период операций нет.</p>'
        : `<div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Когда (Ташкент)</th><th>Операция</th><th>Клиент</th><th>Сотрудник</th><th class="num">Сумма, сум</th><th class="num">Мёд</th><th>Комментарий</th></tr></thead><tbody>
          ${rows.map((r) => `<tr class="${r.status === 'reversed' && r.kind === 'purchase' ? 'cx-struck' : ''}">
            <td class="nowrap">${esc(tashkent(r.at))}</td>
            <td>${KIND_LABELS[r.kind]}${r.status === 'reversed' && r.kind === 'purchase' ? ' <span class="cx-tag">отменена</span>' : ''}</td>
            <td>${esc(r.clientName || '—')}<div class="cx-mut">${esc(r.clientPhone ?? '')}</div></td>
            <td>${esc(r.staffName ?? '—')}</td>
            <td class="num">${r.amount === null ? '' : fmt(r.amount)}</td>
            <td class="num">${signed(r.points)}${r.redeemed ? `<div class="cx-mut">мёдом ${fmt(r.redeemed)}</div>` : ''}</td>
            <td>${esc(r.reason ?? '')}</td></tr>`).join('')}
          </tbody></table></div>
          ${page.nextCursor ? `<button class="cx-btn cx-more" data-act="opsMore" ${loading ? 'disabled' : ''}>${loading ? 'Загрузка…' : `Показать ещё (показано ${fmt(rows.length)}${totals ? ` из ${fmt(totals.count)}` : ''})`}</button>` : ''}`;
  return `<div class="cx-split"><aside class="cx-side">${filtersForm()}</aside><div class="cx-content">${totals ? totalsBar(totals) : ''}${body}</div></div>`;
}

submits.opsFilter = (form) => {
  const fd = new FormData(form);
  const kinds = fd.getAll('kinds').map(String);
  setQuery({
    kinds: kinds.length === KINDS.length || !kinds.length ? null : kinds.join(','),
    staff: String(fd.get('staff') ?? '') || null,
    minAmount: intParam(String(fd.get('minAmount') ?? '')) || null,
    maxAmount: intParam(String(fd.get('maxAmount') ?? '')) || null,
  }, true);
  void loadOps();
};
acts.opsReset = () => {
  setQuery({ kinds: null, staff: null, minAmount: null, maxAmount: null }, true);
  void loadOps();
};
acts.opsReload = () => loadOps(true);
acts.opsMore = () => more();

acts.opsExport = async () => {
  if (!page || exporting) return;
  const key = loadedFor;
  const lines: string[] = [];
  let cursor: string | null = null;
  try {
    do {
      exporting = `Выгружаем… ${fmt(lines.length)}`;
      shell.renderView();
      const p: ConsoleOperationsPageDTO = await capi.ops(`${key}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const r of p.rows) {
        if (lines.length >= EXPORT_CAP) break;
        lines.push(csvLine([
          tashkent(r.at), KIND_LABELS[r.kind], r.status === 'reversed' && r.kind === 'purchase' ? 'отменена' : '', r.clientName, r.clientPhone ?? '',
          r.staffName ?? '', r.amount ?? '', r.points, r.redeemed || '', r.reason ?? '',
        ]));
      }
      cursor = lines.length >= EXPORT_CAP ? null : p.nextCursor;
    } while (cursor);
    const { from, to } = urlPeriod();
    downloadCsv(`операции_${from}_${to}.csv`, ['Дата и время (Ташкент)', 'Операция', 'Статус', 'Клиент', 'Телефон', 'Сотрудник', 'Сумма заказа, сум', 'Мёд (изменение)', 'Оплачено мёдом', 'Комментарий'], lines);
    toast(`Выгружено ${fmt(lines.length)} операций`, 'ok');
  } catch (e) {
    toast((e as ApiErr).message, 'error');
  } finally {
    exporting = null;
    shell.renderView();
  }
};
