/**
 * Console «Склад» (prototype): stock balances, receipts, bouquets with cost / price / margin, write-offs.
 * Period from the shell (?from&to), table from ?t=. CSV is built in the browser from the API pages
 * (files.ts: UTF-8 BOM, ';', formula-injection safe), like «Покупки».
 */
import type { ReceiptListItemDTO, StockBalanceRowDTO, StockBouquetRowDTO, StockPageDTO, StockWriteoffRowDTO } from '@honey/contracts';
import { ApiErr, capiGet } from '../api';
import { acts, esc, fmt, q, setQuery, shell, tashkent, toast, urlPeriod } from '../core';
import { csvLine, downloadCsv, EXPORT_CAP } from '../files';

type Tab = 'balances' | 'receipts' | 'bouquets' | 'writeoffs';
const TABS: Array<[Tab, string]> = [['balances', 'Остатки'], ['receipts', 'Приходы'], ['bouquets', 'Букеты'], ['writeoffs', 'Списания']];
const tab = (): Tab => (TABS.find(([k]) => k === q().get('t'))?.[0] ?? 'balances');

type AnyRow = StockBalanceRowDTO | ReceiptListItemDTO | StockBouquetRowDTO | StockWriteoffRowDTO;
let rows: AnyRow[] = [];
let cursor: string | null = null;
let loadedFor = '';
let error: string | null = null;
let loading = false;
let exporting: string | null = null;

const STATUS: Record<string, string> = { assembled: 'собран', on_showcase: 'на витрине', sold: 'продан', disassembled: 'разобран', written_off: 'списан', cancelled: 'отменён' };
const REASON: Record<string, string> = { wilt: 'увяли', damage: 'сломаны', supplier: 'брак поставщика', other: 'другое', disassembly_waste: 'отходы разборки' };
const APPROVAL: Record<string, string> = { none: '', pending: 'ждёт подтверждения', approved: 'подтверждено', rejected: 'отклонено' };

function path(t: Tab, c: string | null): string {
  const { from, to } = urlPeriod();
  const p = new URLSearchParams({ from, to });
  if (c) p.set('cursor', c);
  return `/api/owner/stock/${t}?${p}`;
}

export async function loadStock(force = false) {
  const t = tab();
  const { from, to } = urlPeriod();
  const key = `${t}|${from}|${to}`;
  if (!force && key === loadedFor && !error) { shell.renderView(); return; }
  loadedFor = key;
  rows = [];
  cursor = null;
  error = null;
  loading = true;
  shell.renderView();
  try {
    const p = await capiGet<StockPageDTO<AnyRow>>(path(t, null));
    if (loadedFor === key) { rows = p.items; cursor = p.cursor; }
  } catch (e) {
    error = (e as ApiErr).status === 404 ? 'Модуль «Склад» не включён на этом сервере.' : (e as ApiErr).message;
  }
  loading = false;
  shell.renderView();
}

const money = (n: number | null) => (n === null ? '' : fmt(n));

function table(t: Tab): string {
  if (t === 'balances') {
    const r = rows as StockBalanceRowDTO[];
    const total = r.reduce((a, x) => a + x.valueUzs, 0);
    return `<table class="cx-table"><thead><tr><th>Позиция</th><th>Группа</th><th class="num">Остаток</th><th class="num">Стоимость, сум</th><th class="num">Партий</th><th>Старейшая</th><th class="num">Последняя цена ед.</th></tr></thead><tbody>
      ${r.map((x) => `<tr class="${x.qty < 0 ? 'cx-bad' : ''}"><td>${esc(x.name)} <span class="cx-mut">${esc(x.sku)}</span></td><td>${esc(x.group)}</td><td class="num">${fmt(x.qty)} ${esc(x.unit)}</td><td class="num">${fmt(x.valueUzs)}</td><td class="num">${x.lots}</td><td>${esc(x.oldestOn ?? '')}</td><td class="num">${money(x.lastCostUzs)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="3">Итого</td><td class="num">${fmt(total)}</td><td colspan="3"></td></tr></tfoot></table>`;
  }
  if (t === 'receipts') {
    const r = rows as ReceiptListItemDTO[];
    return `<table class="cx-table"><thead><tr><th>№</th><th>Дата</th><th>Поставщик</th><th>Валюта</th><th>Цены</th><th class="num">Строк</th><th class="num">Накладные, сум</th><th class="num">Сумма, сум</th><th>Кто</th><th>Статус</th></tr></thead><tbody>
      ${r.map((x) => `<tr class="${x.status === 'cancelled' ? 'cx-struck' : ''}"><td>${x.number}</td><td class="nowrap">${esc(x.docDate)}</td><td>${esc(x.supplier ?? '—')}</td><td>${x.currency === 'USD' ? `USD по ${fmt(x.fxRate ?? 0)}` : 'сум'}</td><td>${x.priceMode === 'total' ? 'одной суммой' : 'по строкам'}</td><td class="num">${x.lines}</td><td class="num">${fmt(x.extraUzs)}</td><td class="num">${fmt(x.totalUzs)}</td><td>${esc(x.actor)}</td><td>${x.status === 'cancelled' ? 'отменён' : 'проведён'}</td></tr>`).join('')}
      </tbody></table>`;
  }
  if (t === 'bouquets') {
    const r = rows as StockBouquetRowDTO[];
    return `<table class="cx-table"><thead><tr><th>№</th><th>Когда (Ташкент)</th><th>Вид</th><th>Статус</th><th>Флорист</th><th>Состав</th><th class="num">Себестоимость</th><th class="num">Рекомендовано</th><th class="num">Цена</th><th class="num">Продан за</th><th class="num">Маржа</th></tr></thead><tbody>
      ${r.map((x) => `<tr><td>${x.number}${x.usedDeficit ? ' <span class="cx-tag">в минус</span>' : ''}</td><td class="nowrap">${esc(tashkent(x.createdAt))}</td><td>${x.kind === 'order' ? 'под заказ' : 'витрина'}</td><td>${STATUS[x.status] ?? x.status}</td><td>${esc(x.florist)}</td><td>${esc(x.composition)}</td><td class="num">${fmt(x.cost)}</td><td class="num">${fmt(x.suggestedPrice)}</td><td class="num">${fmt(x.price)}</td><td class="num">${money(x.soldFor)}</td><td class="num">${x.marginPct === null ? '' : `${String(x.marginPct).replace('.', ',')}%`}</td></tr>`).join('')}
      </tbody></table>`;
  }
  const r = rows as StockWriteoffRowDTO[];
  return `<table class="cx-table"><thead><tr><th>№</th><th>Дата</th><th>Позиция</th><th class="num">Кол-во</th><th>Причина</th><th class="num">Сумма, сум</th><th>Кто</th><th>Подтверждение</th></tr></thead><tbody>
    ${r.map((x) => `<tr class="${x.status === 'cancelled' ? 'cx-struck' : ''}"><td>${x.number}</td><td class="nowrap">${esc(x.docDate)}</td><td>${esc(x.item)}</td><td class="num">${fmt(x.qty)}</td><td>${REASON[x.reason] ?? x.reason}</td><td class="num">${fmt(x.valueUzs)}</td><td>${esc(x.actor)}</td><td>${APPROVAL[x.approval] ?? ''}${x.status === 'cancelled' ? ' (сторно)' : ''}</td></tr>`).join('')}
    </tbody></table>`;
}

export function stockView(): string {
  const t = tab();
  const head = `<div class="cx-actions"><div class="cx-seg" role="group" aria-label="Таблица">${TABS.map(([k, l]) => `<button type="button" data-act="stockTab" data-t="${k}" aria-pressed="${k === t}">${l}</button>`).join('')}</div>
    <span class="cx-grow"></span><button class="cx-btn" data-act="stockExport" ${exporting || !rows.length ? 'disabled' : ''}>${exporting ? esc(exporting) : 'Скачать CSV'}</button></div>
    ${t === 'balances' ? '<p class="cx-mut">Остатки на сейчас (период к ним не применяется).</p>' : ''}`;
  const body = error
    ? `<div class="cx-err">${esc(error)} <button class="cx-link" data-act="stockReload">Повторить</button></div>`
    : loading && !rows.length
      ? '<div class="cx-loading">Загрузка…</div>'
      : !rows.length
        ? '<p class="cx-mut">За период записей нет.</p>'
        : `<div class="cx-table-wrap">${table(t)}</div>${cursor ? `<button class="cx-btn cx-more" data-act="stockMore" ${loading ? 'disabled' : ''}>${loading ? 'Загрузка…' : `Показать ещё (показано ${fmt(rows.length)})`}</button>` : ''}`;
  return head + body;
}

acts.stockTab = (el) => { setQuery({ t: el.dataset.t === 'balances' ? null : el.dataset.t }, true); void loadStock(); };
acts.stockReload = () => loadStock(true);
acts.stockMore = async () => {
  if (!cursor || loading) return;
  loading = true;
  shell.renderView();
  try {
    const p = await capiGet<StockPageDTO<AnyRow>>(path(tab(), cursor));
    rows = rows.concat(p.items);
    cursor = p.cursor;
  } catch (e) { toast((e as ApiErr).message, 'error'); }
  loading = false;
  shell.renderView();
};

function csvRow(t: Tab, x: AnyRow): unknown[] {
  if (t === 'balances') { const r = x as StockBalanceRowDTO; return [r.sku, r.name, r.group, r.qty, r.unit, r.valueUzs, r.lots, r.oldestOn ?? '', r.lastCostUzs ?? '']; }
  if (t === 'receipts') { const r = x as ReceiptListItemDTO; return [r.number, r.docDate, r.supplier ?? '', r.currency, r.fxRate ?? '', r.priceMode === 'total' ? 'одной суммой' : 'по строкам', r.lines, r.extraUzs, r.totalUzs, r.actor, r.status === 'cancelled' ? 'отменён' : 'проведён']; }
  if (t === 'bouquets') { const r = x as StockBouquetRowDTO; return [r.number, tashkent(r.createdAt), r.kind === 'order' ? 'под заказ' : 'витрина', STATUS[r.status] ?? r.status, r.florist, r.composition, r.cost, r.suggestedPrice, r.price, r.soldFor ?? '', r.marginPct ?? '', r.usedDeficit ? 'да' : '']; }
  const r = x as StockWriteoffRowDTO;
  return [r.number, r.docDate, r.item, r.qty, REASON[r.reason] ?? r.reason, r.valueUzs, r.actor, APPROVAL[r.approval] ?? '', r.status === 'cancelled' ? 'сторно' : ''];
}
const HEADERS: Record<Tab, string[]> = {
  balances: ['Код', 'Позиция', 'Группа', 'Остаток', 'Ед.', 'Стоимость, сум', 'Партий', 'Старейшая партия', 'Последняя цена ед., сум'],
  receipts: ['№', 'Дата', 'Поставщик', 'Валюта', 'Курс', 'Цены', 'Строк', 'Накладные, сум', 'Сумма, сум', 'Кто', 'Статус'],
  bouquets: ['№', 'Когда (Ташкент)', 'Вид', 'Статус', 'Флорист', 'Состав', 'Себестоимость, сум', 'Рекомендовано, сум', 'Цена, сум', 'Продан за, сум', 'Маржа, %', 'В минус'],
  writeoffs: ['№', 'Дата', 'Позиция', 'Кол-во', 'Причина', 'Сумма, сум', 'Кто', 'Подтверждение', 'Сторно'],
};

acts.stockExport = async () => {
  if (exporting) return;
  const t = tab();
  const lines: string[] = [];
  let c: string | null = null;
  try {
    do {
      exporting = `Выгружаем… ${fmt(lines.length)}`;
      shell.renderView();
      const p: StockPageDTO<AnyRow> = await capiGet<StockPageDTO<AnyRow>>(path(t, c));
      for (const x of p.items) if (lines.length < EXPORT_CAP) lines.push(csvLine(csvRow(t, x)));
      c = lines.length >= EXPORT_CAP ? null : p.cursor;
    } while (c);
    const { from, to } = urlPeriod();
    const name = { balances: 'остатки', receipts: 'приходы', bouquets: 'букеты', writeoffs: 'списания' }[t];
    downloadCsv(t === 'balances' ? `склад_${name}.csv` : `склад_${name}_${from}_${to}.csv`, HEADERS[t], lines);
    toast(`Выгружено ${fmt(lines.length)} строк`, 'ok');
  } catch (e) {
    toast((e as ApiErr).message, 'error');
  } finally {
    exporting = null;
    shell.renderView();
  }
};
