import type { ConsoleClientSort, ConsoleClientRow, ConsoleClientsPageDTO } from '@honey/contracts';
import { ApiErr, capi } from '../api';
import { acts, esc, fmt, fmtDay, intParam, isDayKey, q, setQuery, shell, submits, tashkent, tashkentDay, toast, urlPeriod } from '../core';
import { csvLine, downloadCsv, EXPORT_CAP } from '../files';

/** Levels for the filter (from the rules), set by main.ts. */
export const levels: Array<{ id: string; name: string }> = [];

const FILTERS = ['cper', 'level', 'minCount', 'maxCount', 'minTotal', 'maxTotal', 'minAvg', 'maxAvg', 'activity', 'bmonth', 'regFrom', 'regTo', 'gift', 'linked', 'cq'] as const;

let rows: ConsoleClientRow[] = [];
let page: ConsoleClientsPageDTO | null = null;
let error: string | null = null;
let loading = false;
let loadedFor = '';
let exporting: string | null = null;

/** API query of the current URL (without cursor/limit). */
function apiQuery(): URLSearchParams {
  const u = q();
  const out = new URLSearchParams();
  if (u.get('cper') === '1') {
    const { from, to } = urlPeriod();
    out.set('from', from);
    out.set('to', to);
  }
  for (const k of ['level', 'activity', 'bmonth', 'gift', 'linked'] as const) if (u.get(k)) out.set(k, u.get(k)!);
  for (const k of ['minCount', 'maxCount', 'minTotal', 'maxTotal', 'minAvg', 'maxAvg'] as const) if (intParam(u.get(k))) out.set(k, intParam(u.get(k)));
  if (isDayKey(u.get('regFrom')) && isDayKey(u.get('regTo'))) { out.set('regFrom', u.get('regFrom')!); out.set('regTo', u.get('regTo')!); }
  if (u.get('cq')) out.set('q', u.get('cq')!);
  out.set('sort', u.get('sort') ?? 'last');
  out.set('dir', u.get('dir') === 'asc' ? 'asc' : 'desc');
  return out;
}

export async function loadClients(force = false) {
  const key = apiQuery().toString();
  if (!force && key === loadedFor && page) return;
  loadedFor = key;
  rows = [];
  page = null;
  error = null;
  loading = true;
  shell.renderView();
  try {
    const p = await capi.clients(`${key}&limit=100`);
    if (loadedFor !== key) return;
    page = p;
    rows = p.rows;
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
    const p = await capi.clients(`${key}&limit=100&cursor=${encodeURIComponent(page.nextCursor)}`);
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

const ACTIVITY: Array<[string, string]> = [['', 'Любая'], ['active', 'Активные (покупали < 30 дн.)'], ['sleeping', 'Засыпающие (30–60 дн.)'], ['gone', 'Ушедшие (60+ дн.)'], ['never', 'Ещё не покупали']];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function filtersForm(): string {
  const u = q();
  const v = (k: string) => esc(u.get(k) ?? '');
  const sel = (k: string, opts: Array<[string, string]>) => `<select name="${k}">${opts.map(([val, l]) => `<option value="${esc(val)}" ${(u.get(k) ?? '') === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const range = (label: string, a: string, b: string, ph = '') => `<label class="cx-f"><span>${label}</span><span class="cx-range"><input name="${a}" inputmode="numeric" placeholder="от${ph}" value="${v(a)}"><input name="${b}" inputmode="numeric" placeholder="до${ph}" value="${v(b)}"></span></label>`;
  const { from, to } = urlPeriod();
  return `<form class="cx-filters" data-submit="clientsFilter">
    <label class="cx-f"><span>Покупки считать</span>${sel('cper', [['', 'За всё время'], ['1', `За период ${fmtDay(from)} — ${fmtDay(to)}`]])}</label>
    <label class="cx-f"><span>Поиск</span><input name="cq" placeholder="имя, телефон или HF-код" value="${v('cq')}"></label>
    <label class="cx-f"><span>Уровень</span>${sel('level', [['', 'Любой'], ...levels.map((l) => [l.id, l.name] as [string, string])])}</label>
    <label class="cx-f"><span>Последняя покупка</span>${sel('activity', ACTIVITY)}</label>
    ${range('Кол-во покупок', 'minCount', 'maxCount')}
    ${range('Сумма покупок, сум', 'minTotal', 'maxTotal')}
    ${range('Средний чек, сум', 'minAvg', 'maxAvg')}
    <label class="cx-f"><span>День рождения</span>${sel('bmonth', [['', 'Любой месяц'], ...MONTHS.map((m, i) => [String(i + 1), m] as [string, string])])}</label>
    <label class="cx-f"><span>Зарегистрирован</span><span class="cx-range"><input type="date" name="regFrom" value="${v('regFrom')}"><input type="date" name="regTo" value="${v('regTo')}"></span></label>
    <label class="cx-f"><span>Telegram</span>${sel('linked', [['', 'Все'], ['tg', 'Вошли в Telegram'], ['pending', 'Из импорта, ещё не вошли']])}</label>
    <label class="cx-check"><input type="checkbox" name="gift" value="1" ${u.get('gift') === '1' ? 'checked' : ''}> Есть неиспользованный подарок</label>
    <div class="cx-f-actions"><button class="cx-btn acc" type="submit">Применить</button><button class="cx-btn" type="button" data-act="clientsReset">Сбросить</button></div>
  </form>`;
}

function th(key: ConsoleClientSort, label: string, num = false) {
  const u = q();
  const cur = (u.get('sort') ?? 'last') === key;
  const dir = u.get('dir') === 'asc' ? 'asc' : 'desc';
  const aria = cur ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th class="${num ? 'num' : ''}" aria-sort="${aria}"><button class="cx-sort" data-act="clientsSort" data-k="${key}">${label}${cur ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
}

export function clientsView(): string {
  const u = q();
  const sums = page
    ? `<div class="cx-sumbar"><b>${fmt(page.matched)}</b> клиентов найдено · покупок <b>${fmt(page.matchedPurchases)}</b>${page.matchedTotal !== null ? ` на <b>${fmt(page.matchedTotal)}</b> сум` : ''} ${u.get('cper') === '1' ? 'за период' : 'за всё время'}
       <span class="cx-grow"></span><button class="cx-btn" data-act="clientsExport" ${exporting || !page.matched ? 'disabled' : ''}>${exporting ? esc(exporting) : `Скачать CSV (${fmt(Math.min(page.matched, EXPORT_CAP))})`}</button></div>`
    : '';
  const body = error
    ? `<div class="cx-err">${esc(error)} <button class="cx-link" data-act="clientsReload">Повторить</button></div>`
    : !page
      ? '<div class="cx-loading">Загрузка…</div>'
      : !rows.length
        ? '<p class="cx-mut">Никто не подходит под фильтры.</p>'
        : `<div class="cx-table-wrap"><table class="cx-table"><thead><tr>
            ${th('name', 'Имя')}<th>Телефон</th>${th('level', 'Уровень')}${th('count', 'Покупок', true)}${th('total', 'Сумма', true)}${th('avg', 'Ср. чек', true)}
            ${th('last', 'Последняя')}${th('balance', 'Мёд', true)}<th>Подарок</th>${th('registered', 'Регистрация')}</tr></thead><tbody>
            ${rows.map((r) => `<tr>
              <td><b>${esc(r.name || '—')}</b>${r.linked ? '' : ' <span class="cx-tag" title="Из импорта базы, ещё не открыл бота">не в Telegram</span>'}<div class="cx-mut">${esc(r.code)}</div></td>
              <td class="nowrap">${esc(r.phone ?? '')}</td><td>${esc(r.levelName)}</td>
              <td class="num">${fmt(r.purchases)}</td><td class="num">${fmt(r.total)}</td><td class="num">${r.purchases ? fmt(r.avg) : '—'}</td>
              <td class="nowrap">${r.lastPurchaseAt ? fmtDay(tashkentDay(r.lastPurchaseAt), true) : '—'}</td>
              <td class="num">${fmt(r.balance)}</td><td>${r.hasGift ? '🎁' : ''}</td><td class="nowrap">${fmtDay(tashkentDay(r.registeredAt), true)}</td></tr>`).join('')}
            </tbody></table></div>
            ${page.nextCursor ? `<button class="cx-btn cx-more" data-act="clientsMore" ${loading ? 'disabled' : ''}>${loading ? 'Загрузка…' : `Показать ещё (показано ${fmt(rows.length)} из ${fmt(page.matched)})`}</button>` : ''}`;
  return `<div class="cx-split"><aside class="cx-side">${filtersForm()}</aside><div class="cx-content">${sums}${body}</div></div>`;
}

submits.clientsFilter = (form) => {
  const fd = new FormData(form);
  const patch: Record<string, string | null> = { cursor: null };
  for (const k of FILTERS) patch[k] = String(fd.get(k) ?? '').trim() || null;
  for (const k of ['minCount', 'maxCount', 'minTotal', 'maxTotal', 'minAvg', 'maxAvg']) patch[k] = intParam(patch[k]) || null;
  setQuery(patch, true);
  void loadClients();
};
acts.clientsReset = () => {
  setQuery(Object.fromEntries(FILTERS.map((k) => [k, null])), true);
  void loadClients();
};
acts.clientsReload = () => loadClients(true);
acts.clientsMore = () => more();
acts.clientsSort = (el) => {
  const k = el.dataset.k!;
  const u = q();
  const same = (u.get('sort') ?? 'last') === k;
  const dir = same ? (u.get('dir') === 'asc' ? 'desc' : 'asc') : k === 'name' ? 'asc' : 'desc';
  setQuery({ sort: k, dir }, true);
  void loadClients();
};

acts.clientsExport = async () => {
  if (!page || exporting) return;
  const key = loadedFor;
  const lines: string[] = [];
  let cursor: string | null = null;
  try {
    do {
      exporting = `Выгружаем… ${fmt(lines.length)}`;
      shell.renderView();
      const p: ConsoleClientsPageDTO = await capi.clients(`${key}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const r of p.rows) {
        if (lines.length >= EXPORT_CAP) break;
        lines.push(csvLine([
          r.name, r.phone ?? '', r.code, r.levelName, r.purchases, r.total, r.purchases ? r.avg : '', r.lastPurchaseAt ? tashkent(r.lastPurchaseAt) : '',
          r.balance, r.hasGift ? 'да' : '', r.birthday ?? '', tashkent(r.registeredAt), r.linked ? 'да' : 'нет (импорт)',
        ]));
      }
      cursor = lines.length >= EXPORT_CAP ? null : p.nextCursor;
    } while (cursor);
    downloadCsv(`клиенты_${new Date().toISOString().slice(0, 10)}.csv`, [
      'Имя', 'Телефон', 'Код карты', 'Уровень', 'Покупок', 'Сумма покупок, сум', 'Средний чек, сум', 'Последняя покупка (Ташкент)',
      'Мёд на счёте', 'Неиспользованный подарок', 'День рождения', 'Регистрация (Ташкент)', 'В Telegram',
    ], lines);
    toast(lines.length >= EXPORT_CAP ? `Выгружено первые ${fmt(EXPORT_CAP)} строк (предел)` : `Выгружено ${fmt(lines.length)} клиентов`, 'ok');
  } catch (e) {
    toast((e as ApiErr).message, 'error');
  } finally {
    exporting = null;
    shell.renderView();
  }
};
