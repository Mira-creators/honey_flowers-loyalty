/** Owner «Клиенты»: searchable client base, client card, manual мёд adjustment, CSV export links. Russian only. */
import type { ClientRowDTO, ClientSort, ClientStatus, OwnerClientDTO } from '@honey/contracts';
import { S, actions, changes, inputs, app } from '../state';
import { T, GIFT_LABELS, ADJUST_REASONS } from '../config/texts';
import { THEMES } from '../config/themes';
import { api, ApiErr, newIdempotencyKey } from '../api';
import { tg } from '../tg';
import { esc, fmt, toast, sheet, closeLayer, debounce } from '../ui/dom';
import { IC } from '../ui/icons';
import { combSVG, giftSvg } from '../ui/comb';
import { histRow } from './client';
import { openClient } from './staff';
import { openGrantSheet } from './grantSheet';

const PAGE = 30;
const STATUS_CHIPS: Array<[ClientStatus | '', string]> = [
  ['', 'Все'], ['active', 'Активные'], ['sleeping', 'Засыпают'], ['lost', 'Потерянные'], ['expiring', 'Сгорает мёд'], ['birthday', 'ДР на неделе'],
];
const SORTS: Array<[ClientSort, string]> = [
  ['last_purchase_desc', 'Недавние покупки'], ['spent_desc', 'Больше всех потратили'], ['balance_desc', 'Больше мёда'], ['name', 'По имени'], ['created_desc', 'Новые участники'],
];

const cl = () => S.owner.cl;
const ruPlural = (n: number, a: string, b: string, c: string) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
/** Server "now" (test clock included) as the reference for "3 дня назад". */
const nowMs = () => (S.me ? Date.parse(S.me.now) : Date.now());
/** Calendar day in Tashkent (UTC+5, no DST) as a day number. */
const tashDay = (ms: number) => Math.floor((ms + 5 * 3_600_000) / 86_400_000);

export function relDays(iso: string | null): string {
  if (!iso) return 'покупок не было';
  const n = tashDay(nowMs()) - tashDay(Date.parse(iso));
  if (n <= 0) return 'сегодня';
  if (n === 1) return 'вчера';
  if (n < 30) return `${n} ${ruPlural(n, 'день', 'дня', 'дней')} назад`;
  const m = Math.floor(n / 30);
  if (m < 12) return `${m} ${ruPlural(m, 'месяц', 'месяца', 'месяцев')} назад`;
  return 'больше года назад';
}
const dayRu = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return `${d} ${T('ru').months[(m || 1) - 1]} ${y}`; };
const dateRu = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/* ---------------- views ---------------- */
export function clientsView(): string {
  return cl().cardId ? cardView() : listView();
}

function listView() {
  const c = cl();
  const filtered = !!(c.q.trim() || c.status);
  const rows = c.items;
  let body: string;
  if (c.error && !rows?.length) body = `<div class="note-box warn">${esc(c.error)} <button class="link" data-act="clientsRetry">Повторить</button></div>`;
  else if (!rows) body = '<p class="mut">Загрузка…</p>';
  else if (!rows.length) body = filtered
    ? '<div class="empty"><b>Никого не нашли</b><p class="mut">Проверьте написание или сбросьте фильтр.</p><button class="link" data-act="clientsClear">Показать всех</button></div>'
    : '<div class="empty"><b>Пока нет клиентов</b><p class="mut">Клиенты появятся здесь, когда откроют медовую карту в боте и поделятся номером.</p></div>';
  else body = `<div class="list">${rows.map(rowHtml).join('')}</div>
      ${c.error ? `<div class="note-box warn" style="margin-top:10px">${esc(c.error)} <button class="link" data-act="clientsMore">Повторить</button></div>` : ''}
      ${c.cursor && !c.error ? `<button class="b full" data-act="clientsMore" style="margin-top:10px" ${c.loading ? 'disabled' : ''}>${c.loading ? 'Загружаем…' : 'Показать ещё'}</button>` : ''}`;
  return `<div class="hdr-row"><h2 class="h disp">Клиенты</h2><button class="b sm" data-act="openExport">Экспорт</button></div>
    <div class="search one"><input id="cq" data-input="clientSearch" placeholder="Имя, телефон или код HF…" value="${esc(c.q)}" inputmode="search" autocomplete="off" enterkeyhint="search" aria-label="Поиск клиента"></div>
    <div class="chips scroll" role="group" aria-label="Фильтр">${STATUS_CHIPS.map(([v, l]) => `<button class="chip" data-act="clientStatus" data-status="${v}" aria-pressed="${c.status === v}">${l}</button>`).join('')}</div>
    <label class="fl" for="csort">Сортировка</label><select id="csort" data-change="clientSort">${SORTS.map(([v, l]) => `<option value="${v}" ${c.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${body}`;
}

function rowHtml(r: ClientRowDTO) {
  return `<button class="it btn-it" data-act="openClient" data-id="${esc(r.id)}">
    <div class="ic">${esc((r.name || '?').slice(0, 1).toUpperCase())}</div>
    <div><div class="t">${esc(r.name || 'Без имени')} <span class="badge">${esc(r.levelName)}</span></div>
      <div class="s">${esc(r.code)} · ${fmt(r.balance)} мёда · ${relDays(r.lastPurchaseAt)}</div></div>
    <span class="gift-n" title="Подарков доступно">${r.giftsAvailable ? `🎁 ${r.giftsAvailable}` : ''}</span></button>`;
}

function cardView() {
  const c = cl(), k = c.card;
  const back = '<button class="back" data-act="closeClient">‹ Все клиенты</button>';
  if (!k) return back + (c.cardError ? `<div class="note-box warn">${esc(c.cardError)} <button class="link" data-act="clientReload">Повторить</button></div>` : '<p class="mut">Загрузка…</p>');
  const gifts = k.gifts.length
    ? k.gifts.map(g => `<div class="it ${g.status !== 'available' ? 'dim' : ''}"><div class="ic">${giftSvg}</div><div><div class="t">${esc(GIFT_LABELS[g.type] ?? g.type)}</div><div class="s">${g.source === 'grant' ? `подарок владельца${g.reason ? ': ' + esc(g.reason) : ''}` : `карта ${g.cycle}, ячейка ${g.cell}`} · ${g.status === 'available' ? 'ждёт клиента' : g.status === 'used' ? 'выдан' : 'отменён'}</div></div><span></span></div>`).join('')
    : '<p class="mut">Подарков пока нет.</p>';
  return `${back}
    <div class="cl"><div class="ava">${esc((k.name || '?').slice(0, 1).toUpperCase())}</div><div>
      <b>${esc(k.name || 'Без имени')}</b> <span class="mut">${esc(k.code)}</span>
      <div class="mut">${esc(k.phone ?? k.phoneMasked)}</div>
      <div class="mut">${esc(k.level.name)} · ${k.level.pct}% · в программе с ${esc(dateRu(k.registeredAt))}</div></div></div>
    <div class="bal small"><span class="l">Мёд на счёте</span><span class="n" id="cardBal">${fmt(k.balance)}<small>мёда</small></span><span class="e">${k.expiresOn && k.balance > 0 ? `действует до<br><b>${esc(dayRu(k.expiresOn))}</b>` : ''}</span></div>
    <div class="grid2"><button class="b acc" data-act="openAdjust">Скорректировать мёд</button><button class="b pri" data-act="chargeClient">${IC.card}Начислить покупку</button>
      <button class="b full" data-act="grantFromCard">🎁 Подарок или мёд без покупки</button></div>
    <div class="comb-card"><div class="comb-meta"><span>Карта ${k.card.cycle} · <b>${k.card.filled} из ${k.card.cells}</b></span><span>потрачено ${fmt(k.spent)} сум</span></div>${combSVG(THEMES[S.themeId], k.card, k.card.filled)}</div>
    <div class="sub">Заметка</div>
    <textarea id="cnote" data-input="noteDraft" maxlength="500" rows="3" placeholder="Например: любит пионы, звонить после 18:00">${esc(c.noteDraft ?? k.note ?? '')}</textarea>
    <button class="b full" data-act="saveNote" style="margin-top:6px">Сохранить заметку</button>
    <div class="sub">Подарки</div><div class="list">${gifts}</div>
    <div class="sub">История · ${k.history.length}${k.historyNext ? '+' : ''}</div><div class="list">${k.history.length ? k.history.map(h => histRow(h, T('ru'))).join('') : '<p class="mut">Операций пока нет.</p>'}</div>
    ${k.historyNext ? `<button class="b full" data-act="historyMore" style="margin-top:8px" ${c.historyLoading ? 'disabled' : ''}>${c.historyLoading ? 'Загружаем…' : 'Показать ещё'}</button>` : ''}`;
}

/* ---------------- data ---------------- */
let listSeq = 0;
/** Load the first page (reset) or the next page of the client list. Stale responses are dropped. */
export async function loadClients(reset = true) {
  const c = cl(), my = ++listSeq;
  if (reset) { c.cursor = null; } else if (!c.cursor) return;
  c.loading = true; c.error = null;
  if (!reset) app.render();
  try {
    const page = await api.clients({ q: c.q.trim(), status: c.status, sort: c.sort, cursor: reset ? null : c.cursor, limit: PAGE });
    if (my !== listSeq) return;
    c.items = reset ? page.items : [...(c.items ?? []), ...page.items];
    c.cursor = page.nextCursor;
  } catch (e) {
    if (my !== listSeq) return;
    c.error = (e as ApiErr).message;
    if (reset) c.items = c.items ?? [];
  } finally {
    if (my === listSeq) { c.loading = false; app.render(); }
  }
}

async function loadCard(id: string) {
  const c = cl();
  try { const k = await api.client(id); if (c.cardId === id) { c.card = k; c.cardError = null; } }
  catch (e) { if (c.cardId === id) c.cardError = (e as ApiErr).message; }
  app.render();
}

/** Close the card and go back to the list at the same scroll position. */
export function closeClientCard() {
  const c = cl(); c.cardId = null; c.card = null; c.cardError = null; c.noteDraft = null;
  app.render();
  const scr = document.getElementById('scr'); if (scr) scr.scrollTop = c.listScroll;
}

/** Keep the list row in sync with the card after a change made on the card. */
function patchRow(k: OwnerClientDTO) {
  const r = cl().items?.find(x => x.id === k.id); if (!r) return;
  r.balance = k.balance; r.expiresOn = k.expiresOn; r.levelId = k.level.id; r.levelName = k.level.name;
  r.giftsAvailable = k.gifts.filter(g => g.status === 'available').length;
}

/* ---------------- actions ---------------- */
const searchLater = debounce(() => loadClients(true), 300);
inputs.clientSearch = el => { cl().q = el.value; searchLater(); };
inputs.noteDraft = el => { cl().noteDraft = el.value; };
actions.clientStatus = el => { cl().status = (el.dataset.status ?? '') as ClientStatus | ''; tg.haptic('select'); cl().items = null; app.render(); loadClients(true); };
changes.clientSort = el => { cl().sort = el.value as ClientSort; cl().items = null; app.render(); loadClients(true); };
actions.clientsMore = () => loadClients(false);
actions.clientsRetry = () => loadClients(true);
actions.clientsClear = () => { const c = cl(); c.q = ''; c.status = ''; c.items = null; app.render(); loadClients(true); };
actions.openClient = el => {
  const c = cl(), id = el.dataset.id!;
  c.listScroll = document.getElementById('scr')?.scrollTop ?? 0;
  c.cardId = id; c.card = null; c.cardError = null; c.noteDraft = null; tg.haptic('select');
  app.render();
  const scr = document.getElementById('scr'); if (scr) scr.scrollTop = 0;
  loadCard(id);
};
actions.closeClient = () => closeClientCard();
/** Owner grant (screens/grantSheet.ts); the sheet broadcasts `honey:client-updated`, the card reloads below. */
actions.grantFromCard = () => { const k = cl().card; if (k) openGrantSheet(k.id, k.name); };
document.addEventListener('honey:client-updated', e => {
  const id = (e as CustomEvent<{ id: string }>).detail?.id;
  if (id && cl().cardId === id) void loadCard(id).then(() => { const k = cl().card; if (k) patchRow(k); });
});
/** Older history of the open card, 50 items per page (GET /api/owner/clients/:id/history). */
actions.historyMore = async () => {
  const c = cl(), k = c.card;
  if (!k?.historyNext || c.historyLoading) return;
  c.historyLoading = true; app.render();
  try {
    const page = await api.clientHistory(k.id, k.historyNext);
    if (c.card?.id === k.id) { c.card.history = [...c.card.history, ...page.items]; c.card.historyNext = page.next; }
  } catch (e) { toast((e as ApiErr).message, 'error'); }
  finally { c.historyLoading = false; app.render(); }
};
actions.clientReload = () => { const id = cl().cardId; if (id) loadCard(id); };
actions.saveNote = async () => {
  const k = cl().card; if (!k) return;
  const v = (document.getElementById('cnote') as HTMLTextAreaElement | null)?.value ?? '';
  try { const r = await api.note(k.id, v); k.note = r.note; cl().noteDraft = null; toast(r.note ? 'Заметка сохранена' : 'Заметка удалена', 'ok'); }
  catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.chargeClient = async () => {
  const k = cl().card; if (!k) return;
  S.owner.tab = 'desk';
  await openClient(k.id); // opens the cash desk with this client preselected (renders)
};

actions.openAdjust = () => {
  const k = cl().card; if (!k) return;
  let sign: 1 | -1 = 1, amount = '';
  const sh = sheet(`<h4>Скорректировать мёд</h4><p>${esc(k.name || k.code)} · сейчас ${fmt(k.balance)} мёда. Клиент получит сообщение в боте.</p>
    <div class="seg2" role="group" aria-label="Начислить или списать"><button id="adjPlus" aria-pressed="true">+ Начислить</button><button id="adjMinus" aria-pressed="false">− Списать</button></div>
    <div class="amount-disp" id="adjAmt" aria-live="polite">0<small>мёда</small></div>
    <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'].map(x => `<button data-k="${x}" aria-label="${x === '⌫' ? 'Стереть' : x}">${x}</button>`).join('')}</div>
    <div class="chips">${ADJUST_REASONS.map(r => `<button class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <input id="adjReason" placeholder="Причина (обязательно)" maxlength="200" autocomplete="off">
    <div class="row2"><button class="b" id="adjNo" style="justify-content:center">Отмена</button><button class="b acc" id="adjYes">Подтвердить</button></div>`);
  sh.classList.add('tall');
  const $ = <T extends HTMLElement>(sel: string) => sh.querySelector(sel) as T;
  const key = newIdempotencyKey();
  const paint = () => {
    const n = +amount || 0;
    $('#adjAmt').innerHTML = `${n ? (sign > 0 ? '+' : '−') + fmt(n) : '0'}<small>мёда</small>`;
    $('#adjPlus').setAttribute('aria-pressed', String(sign > 0)); $('#adjMinus').setAttribute('aria-pressed', String(sign < 0));
  };
  $<HTMLButtonElement>('#adjPlus').onclick = () => { sign = 1; paint(); };
  $<HTMLButtonElement>('#adjMinus').onclick = () => { sign = -1; paint(); };
  sh.querySelectorAll<HTMLButtonElement>('.pad [data-k]').forEach(b => b.onclick = () => {
    const x = b.dataset.k!;
    amount = x === '⌫' ? amount.slice(0, -1) : (amount === '0' ? '' : amount) + x;
    if (amount.length > 9) amount = amount.slice(0, 9);
    tg.haptic('light'); paint();
  });
  sh.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach(b => b.onclick = () => {
    $<HTMLInputElement>('#adjReason').value = b.dataset.reason!;
    sh.querySelectorAll('[data-reason]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $<HTMLButtonElement>('#adjNo').onclick = closeLayer;
  const yes = $<HTMLButtonElement>('#adjYes');
  yes.onclick = async () => {
    const n = +amount || 0, reason = $<HTMLInputElement>('#adjReason').value.trim();
    if (!n) { toast('Введите количество мёда', 'error'); return; }
    if (reason.length < 3) { toast('Укажите причину корректировки', 'error'); return; }
    yes.disabled = true;
    try {
      const r = await api.adjust(k.id, { points: sign * n, reason, idempotencyKey: key });
      closeLayer();
      if (cl().cardId === k.id) cl().card = r.client;
      patchRow(r.client);
      tg.haptic('success'); app.render();
      toast(`Мёд скорректирован: ${sign > 0 ? '+' : '−'}${fmt(n)}. Баланс ${fmt(r.client.balance)}`, 'ok');
      if (r.warnings.length) toast(r.warnings.join(' '), 'error');
    } catch (e) { yes.disabled = false; tg.haptic('error'); toast((e as ApiErr).message, 'error'); }
  };
};

/* ---------------- export ---------------- */
const tashToday = () => { const d = new Date(nowMs() + 5 * 3_600_000); return d.toISOString().slice(0, 10); };
const minusDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') - n * 86_400_000).toISOString().slice(0, 10);

actions.openExport = () => {
  const to = tashToday(), from = minusDays(to, 29);
  const sh = sheet(`<h4>Экспорт в Excel</h4><p>Файл CSV открывается в Excel и Google Таблицах. Ссылка одноразовая и действует 10 минут.</p>
    <button class="b full" id="expClients" style="justify-content:center">База клиентов (Excel)</button>
    <div class="sub" style="margin-top:14px">Операции за период</div>
    <div class="row2"><label class="mini">С<input type="date" id="expFrom" value="${from}"></label><label class="mini">По<input type="date" id="expTo" value="${to}"></label></div>
    <button class="b full" id="expOps" style="justify-content:center;margin-top:8px">Операции за период</button>
    <div id="expOut"></div>`);
  const $ = <T extends HTMLElement>(sel: string) => sh.querySelector(sel) as T;
  const make = async (btn: HTMLButtonElement, req: Parameters<typeof api.exportLink>[0]) => {
    btn.disabled = true;
    try {
      const { url } = await api.exportLink(req);
      $('#expOut').innerHTML = `<div class="exp-url"><input id="expUrl" readonly value="${esc(url)}" aria-label="Ссылка на файл">
        <div class="row2"><button class="b" id="expCopy" style="justify-content:center">Копировать</button><button class="b acc" id="expOpen">Открыть</button></div>
        <p class="mut" style="font-size:12px;margin-top:6px">Файл откроется в браузере. Внутри Telegram скачать его нельзя — поэтому ссылка открывается снаружи.</p></div>`;
      $<HTMLButtonElement>('#expCopy').onclick = async () => {
        const inp = $<HTMLInputElement>('#expUrl');
        try { await navigator.clipboard.writeText(url); } catch { inp.select(); try { document.execCommand('copy'); } catch { /* ignore */ } }
        toast('Ссылка скопирована', 'ok');
      };
      $<HTMLButtonElement>('#expOpen').onclick = () => tg.openLink(url);
    } catch (e) { toast((e as ApiErr).message, 'error'); }
    finally { btn.disabled = false; }
  };
  const clientsBtn = $<HTMLButtonElement>('#expClients'), opsBtn = $<HTMLButtonElement>('#expOps');
  clientsBtn.onclick = () => make(clientsBtn, { kind: 'clients' });
  opsBtn.onclick = () => {
    const f = $<HTMLInputElement>('#expFrom').value, t = $<HTMLInputElement>('#expTo').value;
    if (!f || !t || f > t) { toast('Проверьте даты периода', 'error'); return; }
    make(opsBtn, { kind: 'operations', from: f, to: t });
  };
};
