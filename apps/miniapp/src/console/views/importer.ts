import type { ImportBatchDTO, ImportField, ImportOptions, ImportPreviewRow, ImportRowResult, ImportRowStatus } from '@honey/contracts';
import { buildImportRows, detectHeaderRow, detectImportColumns, IMPORT_FIELDS } from '@honey/contracts';
import { ApiErr, capi } from '../api';
import { acts, changes, esc, fmt, plural, shell, tashkent, toast } from '../core';
import { readTable } from '../files';

/**
 * Import of the shop's old client base: parse in the browser → map columns → validate →
 * check against the base (dryRun) → import in chunks of 100 (idempotent: a chunk can be resent).
 */
const CHUNK = 100;
type Phase = 'idle' | 'parsed' | 'checking' | 'checked' | 'importing' | 'done';

const st = {
  phase: 'idle' as Phase,
  fileName: '',
  table: null as unknown[][] | null,
  headerRow: 0,
  map: null as Record<ImportField, number | null> | null,
  rows: [] as ImportPreviewRow[],
  options: { creditBalance: true, levelFromTotal: true, cellsFromCount: false } as ImportOptions,
  batchId: '',
  results: new Map<number, ImportRowResult>(),
  sent: 0,
  /** First row index not yet confirmed by the server in a real import (resume point after an error). */
  resumeAt: 0,
  error: null as string | null,
  batches: null as ImportBatchDTO[] | null,
  show: 'problems' as 'problems' | 'all',
};

const newBatchId = () => (crypto.randomUUID ? crypto.randomUUID() : `b${Date.now()}${Math.random().toString(16).slice(2, 10)}`);

export async function loadImport() {
  try {
    st.batches = await capi.batches();
  } catch (e) {
    st.error = (e as ApiErr).message;
  }
  shell.renderView();
}

function rebuild() {
  if (!st.table || !st.map) return;
  st.rows = buildImportRows(st.table, st.headerRow, st.map);
  st.results.clear();
  st.sent = 0;
  st.resumeAt = 0;
  if (st.phase !== 'parsed') st.phase = 'parsed';
  if (st.map.balance === null) st.options.creditBalance = false;
  if (st.map.total === null && st.map.count === null) st.options.levelFromTotal = false;
  if (st.map.count === null) st.options.cellsFromCount = false;
}

const valid = () => st.rows.filter((r) => !r.errors.length);

// ------------------------------------------------------------------ rendering

const STATUS: Record<ImportRowStatus, string> = { create: 'Новый', update: 'Уже в базе', replay: 'Уже загружен', invalid: 'Ошибка', duplicate: 'Повтор' };

function uploadCard(): string {
  return `<div class="cx-card"><h3 class="cx-h3">1. Файл с базой</h3>
    <p class="cx-mut">Excel (.xlsx) или CSV. Первая строка — заголовки: телефон, имя, день рождения, баланс/бонусы, сумма покупок, количество покупок, последняя покупка. Лишние колонки не мешают.
    Файл читается прямо в браузере, на сервер уходят только нужные поля.</p>
    <label class="cx-file"><input type="file" accept=".xlsx,.csv,.txt" data-change="impFile"><span class="cx-btn acc">Выбрать файл</span> <span class="cx-mut">${esc(st.fileName || 'файл не выбран')}</span></label>
    ${st.error ? `<div class="cx-err">${esc(st.error)}</div>` : ''}</div>`;
}

function mappingCard(): string {
  if (!st.table || !st.map) return '';
  const header = st.table[st.headerRow] ?? [];
  const width = Math.max(header.length, ...st.table.slice(st.headerRow, st.headerRow + 20).map((r) => r.length));
  const colName = (i: number) => `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}: ${String(header[i] ?? '').slice(0, 30) || '(без заголовка)'}`;
  const selects = IMPORT_FIELDS.map(({ field, label, required }) => `<label class="cx-f"><span>${label}${required ? ' *' : ''}</span>
    <select data-change="impMap" data-field="${field}"><option value="">— нет в файле —</option>${Array.from({ length: width }, (_, i) => `<option value="${i}" ${st.map![field] === i ? 'selected' : ''}>${esc(colName(i))}</option>`).join('')}</select></label>`).join('');
  const sample = st.rows.slice(0, 5);
  const errors = st.rows.filter((r) => r.errors.length).length;
  const warns = st.rows.filter((r) => !r.errors.length && r.warnings.length).length;
  return `<div class="cx-card"><h3 class="cx-h3">2. Колонки</h3>
    <div class="cx-grid-f">
      <label class="cx-f"><span>Строка заголовков</span><select data-change="impHeader">${st.table.slice(0, 15).map((r, i) => `<option value="${i}" ${i === st.headerRow ? 'selected' : ''}>${i + 1}: ${esc(r.filter((c) => c !== null && c !== undefined && c !== '').slice(0, 4).join(' | ').slice(0, 60))}</option>`).join('')}</select></label>
      ${selects}</div>
    ${st.map.phone === null ? '<div class="cx-err">Выберите колонку с телефоном — без неё импорт невозможен.</div>' : `
    <div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Строка</th><th>Телефон</th><th>Имя</th><th>Д. р.</th><th class="num">Баланс</th><th class="num">Сумма</th><th class="num">Покупок</th><th>Последняя</th></tr></thead><tbody>
      ${sample.map((r) => `<tr><td>${r.line}</td><td>${esc(r.phone || r.phoneRaw)}</td><td>${esc(r.name ?? '')}</td><td>${esc(r.birthday ?? '')}</td><td class="num">${r.balance ?? ''}</td><td class="num">${r.total ?? ''}</td><td class="num">${r.count ?? ''}</td><td>${esc(r.lastPurchase ?? '')}</td></tr>`).join('')}
    </tbody></table></div>
    <p>Строк с данными: <b>${fmt(st.rows.length)}</b> · к загрузке: <b>${fmt(valid().length)}</b> · с ошибками (пропустим): <b class="${errors ? 'cx-bad' : ''}">${fmt(errors)}</b> · с замечаниями: <b>${fmt(warns)}</b></p>`}
  </div>`;
}

function optionsCard(): string {
  if (!st.map || st.map.phone === null) return '';
  const o = st.options, m = st.map;
  const busy = st.phase === 'checking' || st.phase === 'importing';
  const box = (k: keyof ImportOptions, label: string, hint: string, disabled: boolean) =>
    `<label class="cx-check ${disabled ? 'cx-dim' : ''}"><input type="checkbox" data-change="impOpt" data-k="${k}" ${o[k] ? 'checked' : ''} ${disabled || busy ? 'disabled' : ''}> <span><b>${label}</b><br><span class="cx-mut">${hint}</span></span></label>`;
  return `<div class="cx-card"><h3 class="cx-h3">3. Что перенести</h3>
    ${box('creditBalance', 'Начислить стартовый мёд из колонки баланса', 'Обычная запись начисления; мёд сгорит по общим правилам, если не будет покупок 90 дней после импорта.', m.balance === null)}
    ${box('levelFromTotal', 'Учитывать прошлую сумму покупок для уровня', 'Клиент сразу получает уровень, которого достиг по сумме (или числу) прошлых покупок.', m.total === null && m.count === null)}
    ${box('cellsFromCount', 'Засчитать прошлые покупки в соты', 'Пчёлка встаёт на соту по числу прошлых покупок (не дальше предпоследней), подарки за пройденные соты не выдаются.', m.count === null)}
    <p class="cx-mut">Повторный импорт того же номера только обновит имя и день рождения — мёд второй раз не начисляется. Клиенты из импорта получат карту, когда сами поделятся этим номером в боте.</p>
  </div>`;
}

function resultsCard(): string {
  if (!st.map || st.map.phone === null || !st.rows.length) return '';
  const total = valid().length;
  const counts = { create: 0, update: 0, replay: 0, invalid: 0, duplicate: 0 } as Record<ImportRowStatus, number>;
  let honey = 0;
  for (const r of st.results.values()) { counts[r.status]++; honey += r.honey; }
  const localErrors = st.rows.filter((r) => r.errors.length);
  const busy = st.phase === 'checking' || st.phase === 'importing';
  const progress = busy ? `<div class="cx-progress"><i style="width:${total ? Math.round((st.sent / total) * 100) : 0}%"></i></div><p class="cx-mut">${st.phase === 'checking' ? 'Проверяем' : 'Загружаем'}: ${fmt(st.sent)} из ${fmt(total)}</p>` : '';
  const checked = st.phase === 'checked' || st.phase === 'done';
  const summary = st.results.size
    ? `<div class="cx-kpis small">
        <div class="cx-kpi"><div class="cx-kpi-l">${st.phase === 'done' ? 'Создано' : 'Будет создано'}</div><div class="cx-kpi-v">${fmt(counts.create)}</div></div>
        <div class="cx-kpi"><div class="cx-kpi-l">Уже в базе — мёд не начисляется</div><div class="cx-kpi-v">${fmt(counts.update + counts.replay)}</div></div>
        <div class="cx-kpi"><div class="cx-kpi-l">Пропущено</div><div class="cx-kpi-v">${fmt(counts.invalid + counts.duplicate + localErrors.length)}</div></div>
        <div class="cx-kpi"><div class="cx-kpi-l">${st.phase === 'done' ? 'Начислено мёда' : 'Мёда начислим'}</div><div class="cx-kpi-v">${fmt(honey)}</div></div></div>`
    : '';
  const list = [
    ...localErrors.map((r) => ({ line: r.line, phone: r.phone || r.phoneRaw, status: 'invalid' as ImportRowStatus, message: r.errors.join('; ') })),
    ...st.rows.filter((r) => !r.errors.length && r.warnings.length).map((r) => ({ line: r.line, phone: r.phone, status: null, message: r.warnings.join('; ') })),
    ...[...st.results.values()].filter((r) => st.show === 'all' || r.status !== 'create').map((r) => ({ line: r.line, phone: r.phone ?? '', status: r.status, message: r.message ?? '' })),
  ].sort((a, b) => a.line - b.line);
  const shown = list.slice(0, 300);
  return `<div class="cx-card"><h3 class="cx-h3">4. Проверка и загрузка</h3>
    ${summary}${progress}
    <div class="cx-actions">
      <button class="cx-btn" data-act="impCheck" ${busy || !total ? 'disabled' : ''}>Проверить по базе</button>
      <button class="cx-btn acc" data-act="impRun" ${busy || !checked || st.phase === 'done' || !total ? 'disabled' : ''} title="${checked ? '' : 'Сначала проверьте по базе'}">${st.resumeAt ? 'Продолжить загрузку' : `Импортировать ${fmt(total)} ${plural(total, 'строку', 'строки', 'строк')}`}</button>
      ${st.results.size ? `<label class="cx-check"><input type="checkbox" data-change="impShowAll" ${st.show === 'all' ? 'checked' : ''}> показывать и новых</label>` : ''}
    </div>
    ${shown.length ? `<div class="cx-table-wrap cx-tall"><table class="cx-table"><thead><tr><th>Строка</th><th>Телефон</th><th>Статус</th><th>Подробности</th></tr></thead><tbody>
      ${shown.map((r) => `<tr><td>${r.line}</td><td class="nowrap">${esc(r.phone)}</td><td>${r.status ? `<span class="cx-tag st-${r.status}">${STATUS[r.status]}</span>` : '<span class="cx-tag">Замечание</span>'}</td><td>${esc(r.message)}</td></tr>`).join('')}
    </tbody></table></div>${list.length > shown.length ? `<p class="cx-mut">Показаны первые ${shown.length} из ${fmt(list.length)}.</p>` : ''}` : ''}
  </div>`;
}

function batchesCard(): string {
  const b = st.batches;
  return `<div class="cx-card"><h3 class="cx-h3">Прошлые импорты</h3>
    ${!b ? '<p class="cx-mut">Загрузка…</p>' : !b.length ? '<p class="cx-mut">Импортов ещё не было.</p>' : `<div class="cx-table-wrap"><table class="cx-table"><thead><tr><th>Когда</th><th>Файл</th><th>Кто</th><th class="num">Создано</th><th class="num">Обновлено</th><th class="num">Пропущено</th><th class="num">Мёд</th><th class="num">Вошли в Telegram</th><th></th></tr></thead><tbody>
      ${b.map((x) => `<tr class="${x.status === 'undone' ? 'cx-struck' : ''}"><td class="nowrap">${esc(tashkent(x.createdAt))}</td><td>${esc(x.fileName ?? '')}</td><td>${esc(x.createdBy ?? '')}</td>
        <td class="num">${fmt(x.created)}</td><td class="num">${fmt(x.updated)}</td><td class="num">${fmt(x.skipped)}</td><td class="num">${fmt(x.honey)}</td><td class="num">${fmt(x.claimed)}</td>
        <td>${x.status === 'undone' ? `отменён ${esc(tashkent(x.undoneAt))}` : `<button class="cx-link bad" data-act="impUndo" data-id="${esc(x.id)}">Отменить</button>`}</td></tr>`).join('')}
      </tbody></table></div><p class="cx-mut">Отмена удаляет созданных импортом клиентов, пока с ними ничего не происходило (не вошли в Telegram, не покупали).</p>`}
  </div>`;
}

export function importView(): string {
  return `${uploadCard()}${mappingCard()}${optionsCard()}${resultsCard()}${batchesCard()}`;
}

// ------------------------------------------------------------------ actions

changes.impFile = async (el) => {
  const file = (el as HTMLInputElement).files?.[0];
  if (!file) return;
  st.error = null;
  st.fileName = file.name;
  try {
    const table = await readTable(file);
    if (!table.length) throw new Error('Файл пустой');
    st.table = table;
    st.headerRow = detectHeaderRow(table);
    st.map = detectImportColumns(table[st.headerRow] ?? []);
    st.batchId = newBatchId();
    st.options = { creditBalance: true, levelFromTotal: true, cellsFromCount: false };
    st.phase = 'parsed';
    rebuild();
  } catch (e) {
    st.table = null;
    st.map = null;
    st.rows = [];
    st.error = `Не удалось прочитать файл: ${(e as Error).message}`;
  }
  shell.renderView();
};
changes.impHeader = (el) => {
  if (!st.table) return;
  st.headerRow = Number(el.value);
  st.map = detectImportColumns(st.table[st.headerRow] ?? []);
  st.batchId = newBatchId();
  rebuild();
  shell.renderView();
};
changes.impMap = (el) => {
  if (!st.map) return;
  st.map[el.dataset.field as ImportField] = el.value === '' ? null : Number(el.value);
  st.batchId = newBatchId();
  rebuild();
  shell.renderView();
};
changes.impOpt = (el) => {
  st.options[el.dataset.k as keyof ImportOptions] = (el as HTMLInputElement).checked;
  // Options are part of the batch: a different choice is a different import.
  st.batchId = newBatchId();
  st.results.clear();
  st.sent = 0;
  st.resumeAt = 0;
  st.phase = 'parsed';
  shell.renderView();
};
changes.impShowAll = (el) => {
  st.show = (el as HTMLInputElement).checked ? 'all' : 'problems';
  shell.renderView();
};

async function sendAll(dryRun: boolean) {
  const rows = valid();
  const start = dryRun ? 0 : st.resumeAt;
  st.phase = dryRun ? 'checking' : 'importing';
  st.sent = start;
  shell.renderView();
  let i = start;
  try {
    for (; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        line: r.line, phone: r.phone, name: r.name, birthday: r.birthday, balance: r.balance, total: r.total, count: r.count, lastPurchase: r.lastPurchase,
      }));
      const skipped = !dryRun && i === 0 ? st.rows.length - rows.length : undefined; // locally rejected rows, recorded once
      const res = await capi.importChunk({ batchId: st.batchId, fileName: st.fileName, dryRun, options: st.options, rows: chunk, skipped });
      for (const r of res.results) st.results.set(r.line, r);
      st.sent = i + chunk.length;
      shell.renderView();
    }
    st.phase = dryRun ? 'checked' : 'done';
    st.resumeAt = 0;
    if (!dryRun) {
      toast('Импорт завершён', 'ok');
      st.batches = await capi.batches().catch(() => st.batches);
    }
  } catch (e) {
    // Every chunk is idempotent: "Продолжить" resends from the failed one, nothing is doubled.
    if (!dryRun) st.resumeAt = i;
    st.phase = dryRun ? 'parsed' : 'checked';
    toast(`${(e as ApiErr).message}${dryRun ? '' : '. Нажмите «Продолжить загрузку» — уже загруженное не задвоится.'}`, 'error');
  }
  shell.renderView();
}

acts.impCheck = () => {
  st.results.clear();
  st.resumeAt = 0;
  return sendAll(true);
};
acts.impRun = async () => {
  const n = valid().length;
  if (!st.resumeAt && !confirm(`Загрузить ${n} ${plural(n, 'строку', 'строки', 'строк')} в базу клиентов?`)) return;
  if (!st.resumeAt) st.results.clear(); // show what was actually done, not the preview
  await sendAll(false);
};
acts.impUndo = async (el) => {
  if (!confirm('Отменить этот импорт? Созданные им клиенты и их стартовый мёд будут удалены.')) return;
  try {
    await capi.undo(el.dataset.id!);
    toast('Импорт отменён', 'ok');
    st.batches = await capi.batches();
  } catch (e) {
    toast((e as ApiErr).message, 'error');
  }
  shell.renderView();
};
