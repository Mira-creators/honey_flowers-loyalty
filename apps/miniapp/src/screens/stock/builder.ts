/**
 * «Букет» — phone-first bouquet builder: tiles with +/−, live FIFO cost, suggested price, cost shares, «Собран».
 * A1: quick quantities (one tap for 15 roses), stable tile order, «не хватает / в минус» on the tile and in
 * the totals, undo of the last action, a template from the current composition or from a sold bouquet.
 */
import type { AssembleResultDTO, StockShortDetails } from '@honey/contracts';
import { popUndo, pushUndo, QTY_PRESETS, snapshotOf, tileOrder } from '@honey/stock';
import { actions, inputs } from '../../state';
import { tg } from '../../tg';
import { newIdempotencyKey } from '../../api';
import { closeLayer, esc, fmt, sheet, toast } from '../../ui/dom';
import { sapi, StockErr } from './sapi';
import { refreshSalePreview } from './sell'; // used at call time only (sell imports this module too)
import { builderCost, itemById, loadCatalog, money, pctTxt, qtyText, render, resetBuilder, resetSell, ST, tile } from './st';

export async function openBuilder() {
  ST.screen = 'bouquet';
  if (!ST.builder.idem) resetBuilder();
  render();
  try {
    await loadCatalog();
    ST.templates = await sapi.templates();
    ST.error = null;
  } catch (e) { ST.error = (e as Error).message; }
  render();
}

const LEVEL_CLASS = { good: 'st-good', warn: 'st-warn', bad: 'st-bad' } as const;
const LEVEL_ICON = { good: '🟢', warn: '🟡', bad: '🔴' } as const;

export function builderView(): string {
  const c = ST.catalog;
  if (!c) return `<h2 class="h disp">Новый букет</h2>${ST.error ? `<div class="note-box warn">${esc(ST.error)}</div>` : '<p class="mut">Загрузка каталога…</p>'}`;
  const b = ST.builder;
  const items = c.items.filter((i) => i.active && i.kind !== 'service');
  if (!items.length) return `<h2 class="h disp">Новый букет</h2><div class="empty"><p class="mut">Каталог пуст. Владелец может заполнить его примером во вкладке «Склад».</p></div>`;
  const groups = [...new Set(items.map((i) => i.group))];
  const q = b.q.trim().toLowerCase();
  // most used first (30 days), then catalog order; never reordered by the composition (tiles stay under the finger)
  const shown = tileOrder(items.filter((i) => (!b.group || i.group === b.group) && (!q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q))));
  const cost = builderCost()!;
  const n = Object.values(b.qty).reduce((a, x) => a + (x > 0 ? 1 : 0), 0);
  const pricing = c.config.pricing;
  const missing = new Map(cost.shortage.lines.map((l) => [l.itemId, l]));
  const tiles = shown.map((it) => {
    const qn = b.qty[it.id] ?? 0;
    const old = it.ladder[0] && (it.ladder[0].freshness === 'overdue' || it.ladder[0].freshness === 'today');
    const m = missing.get(it.id);
    const avail = it.available ?? Math.max(0, it.qty);
    const meta = !it.trackStock ? 'без учёта'
      : m ? `<span class="st-bad">не хватает ${esc(qtyText(it, m.missing))}</span>`
      : avail <= 0 ? '<span class="st-bad">нет на складе</span>'
      : `ост ${esc(qtyText(it, avail))}`;
    return `<div class="st-tile ${qn ? 'on' : ''} ${m ? 'short' : ''}" data-item="${esc(it.id)}">
      <button class="st-tile-main" data-act="stAdd" data-id="${esc(it.id)}" aria-label="Добавить ${esc(it.name)}">${tile(it)}<span class="st-tile-n">${esc(it.name)}</span></button>
      <div class="st-tile-meta">${meta}${old ? ' · <span class="st-warn">старые — первыми</span>' : ''}</div>
      <div class="st-step"><button data-act="stDec" data-id="${esc(it.id)}" aria-label="Меньше" ${qn ? '' : 'disabled'}>−</button><button class="st-q" data-act="stQty" data-id="${esc(it.id)}" aria-label="Сколько ${esc(it.name)}">${qn ? fmt(qn) : '0'}</button><button data-act="stAdd" data-id="${esc(it.id)}" aria-label="Больше">+</button></div>
    </div>`;
  }).join('');
  const bar = (label: string, share: number, target: number, level: 'good' | 'warn' | 'bad') =>
    `<div class="st-bar"><span>${label}</span><div class="st-track"><i class="${LEVEL_CLASS[level]}" style="width:${Math.min(100, share * 100 / Math.max(target * 2, 1) * 100).toFixed(1)}%"></i><b style="left:50%"></b></div><span class="${LEVEL_CLASS[level]}">${pctTxt(share)} / ${target}% ${LEVEL_ICON[level]}</span></div>`;
  const comp = Object.entries(b.qty).filter(([, x]) => x > 0).map(([id, x]) => {
    const it = itemById(id);
    return `<button class="st-comp-i ${missing.has(id) ? 'short' : ''}" data-act="stQty" data-id="${esc(id)}">${esc(it?.name ?? '?')} × ${fmt(x)}</button>`;
  }).join('');
  const sh = cost.shortage;
  const shortNote = sh.mode === 'ok' ? ''
    : `<div class="note-box ${sh.mode === 'blocked' ? 'bad' : 'warn'} st-short" data-short="${sh.mode}"><b>${sh.mode === 'blocked' ? 'Не хватает — собрать нельзя' : 'Не хватает — соберётся в минус'}</b>
      ${sh.lines.map((l) => { const it = itemById(l.itemId); const u = (x: number) => (it ? qtyText(it, x) : fmt(x)); return `<div>${esc(l.name)}: нужно ${esc(u(l.need))}, есть ${esc(u(l.have))} → <b>−${esc(u(l.missing))}</b></div>`; }).join('')}
      <small>${sh.mode === 'blocked' ? 'Уберите лишнее или внесите приход.' : c.config.negativePolicy === 'warn' ? 'Понадобится комментарий; недостачу закроет следующий приход.' : 'Недостачу закроет следующий приход.'}</small></div>`;
  const lastUndo = b.undo[b.undo.length - 1];
  return `<div class="hdr-row"><h2 class="h disp">Новый букет</h2>${n ? '<button class="link" data-act="stClear">Очистить</button>' : ''}</div>
    ${ST.templates.length ? `<div class="chips scroll">${ST.templates.map((t) => `<button class="chip" data-act="stTpl" data-id="${esc(t.id)}" aria-pressed="${b.templateId === t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}
    <div class="search one"><input id="stQ" data-input="stQ" placeholder="Поиск сорта…" value="${esc(b.q)}" autocomplete="off" inputmode="search">${b.q ? '<button class="b" data-act="stQClear" aria-label="Сбросить поиск">✕</button>' : ''}</div>
    <div class="chips scroll"><button class="chip" data-act="stGroup" data-g="" aria-pressed="${!b.group}">Все</button>${groups.map((g) => `<button class="chip" data-act="stGroup" data-g="${esc(g)}" aria-pressed="${b.group === g}">${esc(g)}</button>`).join('')}</div>
    <div class="st-tiles">${tiles || '<p class="mut">Ничего не найдено</p>'}</div>
    <div class="st-sum" id="stSum">
      ${n ? `<div class="st-comp">${comp}</div>` : '<p class="mut" style="margin:0">Нажмите на цветок, чтобы добавить</p>'}
      ${lastUndo ? `<button class="link st-undo" data-act="stUndo">↶ Отменить: ${esc(lastUndo.label)}</button>` : ''}
      <div class="st-row"><span>Себестоимость</span><b id="stCost">${money(cost.cost.costUzs)}</b></div>
      <div class="st-row"><span>Рекомендуем</span><b>${money(cost.suggested)}</b></div>
      <div class="st-row"><label for="stPrice">Цена</label><span class="st-price"><input id="stPrice" data-input="stPrice" inputmode="numeric" maxlength="9" value="${esc(b.priceEdited ? b.price : '')}" placeholder="${esc(cost.suggested ? fmt(cost.suggested) : '')}" aria-label="Цена букета, по умолчанию рекомендованная" ${pricing.priceMode === 'fixed' ? 'disabled' : ''}><small>маржа ${fmt(cost.price - cost.cost.costUzs)}</small></span></div>
      ${bar('Себест.', cost.costShare, pricing.targets.costShare, cost.costLevel)}
      ${bar('Цветы', cost.flowersShare, pricing.targets.flowersShare, cost.flowersLevel)}
      ${shortNote}
      <div class="seg2" role="group" aria-label="Вид букета" style="margin-top:10px"><button data-act="stKind" data-v="order" aria-pressed="${b.kind === 'order'}">Под заказ</button><button data-act="stKind" data-v="showcase" aria-pressed="${b.kind === 'showcase'}">На витрину</button></div>
      <button class="b acc full big" data-act="stAssemble" ${!n || ST.busy || sh.mode === 'blocked' ? 'disabled' : ''}>${ST.busy ? 'Сохраняем…' : b.kind === 'order' ? 'Собран → продать' : 'Собран → на витрину'}</button>
      ${n ? '<button class="link" data-act="stSaveTpl">Сохранить состав как шаблон</button>' : ''}
    </div>`;
}

/** Remember the state before an action, so «Отменить» can bring it back. */
function remember(label: string) {
  const b = ST.builder;
  b.undo = pushUndo(b.undo, snapshotOf(b), label);
  freshKey();
}

/**
 * A changed composition / price / kind is a different operation: it must not reuse the key of an assembly whose
 * response may have been lost (the server would answer 409 «ключ уже использован» to every later bouquet —
 * audit CODE-3). Pressing «Собран» again WITHOUT changes keeps the key, so a lost response is replayed safely.
 */
function freshKey() { ST.builder.idem = newIdempotencyKey(); }

function setQty(id: string, q: number) {
  const b = ST.builder;
  const v = Math.max(0, Math.min(10_000, Math.floor(q)));
  if (v) b.qty[id] = v; else delete b.qty[id];
  b.short = null;
  render();
}

const nameOf = (id: string) => itemById(id)?.name ?? '';
actions.stAdd = (el) => { tg.haptic('light'); const id = el.dataset.id!; remember(`+1 ${nameOf(id)}`); setQty(id, (ST.builder.qty[id] ?? 0) + 1); };
actions.stDec = (el) => { tg.haptic('light'); const id = el.dataset.id!; remember(`−1 ${nameOf(id)}`); setQty(id, (ST.builder.qty[id] ?? 0) - 1); };
actions.stClear = () => {
  const b = ST.builder;
  const undo = pushUndo(b.undo, snapshotOf(b), 'очистка');
  Object.assign(b, { qty: {}, planned: null, templateId: null, price: '', priceEdited: false, short: null, undo });
  freshKey();
  render();
};
actions.stUndo = () => {
  const b = ST.builder;
  const { entry, stack } = popUndo(b.undo);
  if (!entry) return;
  tg.haptic('light');
  // a price typed by hand after this step is kept: undo is about the composition, not the florist's price
  const keepPrice = b.priceEdited && b.price !== entry.snap.price ? { price: b.price, priceEdited: true } : {};
  Object.assign(b, snapshotOf(entry.snap), keepPrice, { undo: stack, short: null });
  freshKey();
  toast(`Отменено: ${entry.label}`, 'info');
  render();
};
actions.stQClear = () => { ST.builder.q = ''; render(); };
actions.stGroup = (el) => { ST.builder.group = el.dataset.g ?? ''; render(); };
actions.stKind = (el) => { const v = el.dataset.v as 'order' | 'showcase'; if (ST.builder.kind !== v) freshKey(); ST.builder.kind = v; render(); };
actions.stQty = (el) => {
  const it = itemById(el.dataset.id!);
  if (!it) return;
  const cur = ST.builder.qty[it.id] ?? 0;
  const unitWord = it.unit.base === 'cm' ? 'сантиметров' : 'штук';
  const sh = sheet(`<h4>${esc(it.name)}</h4><p>Сколько ${esc(unitWord)} в букете? На складе ${esc(qtyText(it, it.qty))}.</p>
    ${it.unit.base === 'cm' ? '' : `<div class="st-presets">${QTY_PRESETS.map((x) => `<button class="chip" data-preset="${x}" aria-pressed="${cur === x}">${x}</button>`).join('')}</div>`}
    <input id="stQtyIn" inputmode="numeric" value="${cur || ''}" autocomplete="off" placeholder="Другое число"><button class="b acc full" id="stQtyOk">Готово</button>
    ${cur ? '<button class="link" id="stQtyDel">Убрать из букета</button>' : ''}`);
  const inp = sh.querySelector('#stQtyIn') as HTMLInputElement;
  const apply = (v: number) => { closeLayer(); if (v === cur) return; remember(`${it.name}: ${fmt(cur)} → ${fmt(v)}`); setQty(it.id, v); };
  sh.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((bt) => { bt.onclick = () => { tg.haptic('light'); apply(Number(bt.dataset.preset)); }; });
  (sh.querySelector('#stQtyOk') as HTMLButtonElement).onclick = () => apply(Number(inp.value.replace(/\D/g, '')) || 0);
  inp.onkeydown = (e) => { if (e.key === 'Enter') apply(Number(inp.value.replace(/\D/g, '')) || 0); };
  const del = sh.querySelector('#stQtyDel') as HTMLButtonElement | null;
  if (del) del.onclick = () => apply(0);
  // no auto-focus when presets are shown: the keyboard would cover them
  if (it.unit.base === 'cm') inp.focus();
};
inputs.stQ = (el) => { ST.builder.q = el.value; render(); };
inputs.stPrice = (el) => {
  const v = el.value.replace(/\D/g, '');
  if (v !== ST.builder.price) freshKey();
  ST.builder.price = v;
  ST.builder.priceEdited = ST.builder.price !== '';
  // update only the margin text: re-rendering would steal the focus on every key
  const c = builderCost();
  const small = el.parentElement?.querySelector('small');
  if (c && small) small.textContent = `маржа ${fmt(c.price - c.cost.costUzs)}`;
};
actions.stTpl = (el) => {
  const t = ST.templates.find((x) => x.id === el.dataset.id);
  if (!t) return;
  const b = ST.builder;
  remember(`шаблон «${t.name}»`);
  b.qty = Object.fromEntries(t.lines.map((l) => [l.itemId, l.qty]));
  b.planned = { ...b.qty };
  b.templateId = t.id;
  // a template without a price must not keep the previous price; with fixed pricing the field is not used (CODE-5/16)
  if (t.price && ST.catalog?.config.pricing.priceMode !== 'fixed') { b.price = String(t.price); b.priceEdited = true; }
  else { b.price = ''; b.priceEdited = false; }
  tg.haptic('select');
  render();
};
/** «Сохранить как шаблон»: from the builder or from a just-sold bouquet (sell screen). */
export function saveTemplateSheet(lines: Array<{ itemId: string; qty: number }>, price: number | null, suggest = '', priceByHand = true) {
  const sh = sheet(`<h4>Шаблон букета</h4><p>Состав${price ? ' и цена' : ''} сохранятся, букет можно будет собрать одним касанием.</p><input id="stTplName" placeholder="Например, 15 роз с эвкалиптом" maxlength="60" value="${esc(suggest)}">
    ${price ? `<label class="tog-line"><input type="checkbox" id="stTplPrice" ${priceByHand ? 'checked' : ''}> с ценой ${esc(money(price))}</label>` : ''}<button class="b acc full" id="stTplOk">Сохранить</button>`);
  (sh.querySelector('#stTplOk') as HTMLButtonElement).onclick = async () => {
    const name = (sh.querySelector('#stTplName') as HTMLInputElement).value.trim();
    if (name.length < 2) { toast('Введите название', 'error'); return; }
    const withPrice = !!(sh.querySelector('#stTplPrice') as HTMLInputElement | null)?.checked;
    try {
      const t = await sapi.saveTemplate({ name, lines: lines.filter((l) => l.qty > 0), price: withPrice ? price : null });
      ST.templates.push(t); closeLayer(); toast('Шаблон сохранён', 'ok'); render();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
}

/** Name suggestion from the composition: «15 Роза Red Naomi + Эвкалипт». */
export function templateName(lines: Array<{ itemId: string; qty: number; name?: string }>): string {
  const xs = [...lines].sort((a, z) => z.qty - a.qty);
  const head = xs[0];
  if (!head) return '';
  const nm = (l: { itemId: string; name?: string }) => l.name ?? itemById(l.itemId)?.name ?? '';
  return [`${head.qty} ${nm(head)}`, ...xs.slice(1, 3).map(nm)].join(' + ').slice(0, 60);
}

actions.stSaveTpl = () => {
  const b = ST.builder;
  const lines = Object.entries(b.qty).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
  const c = builderCost();
  // the price is frozen into the template only when typed by hand; the suggested one follows purchase prices (CODE-21)
  saveTemplateSheet(lines, b.priceEdited && +b.price > 0 ? +b.price : c?.price ?? null, templateName(lines), b.priceEdited && +b.price > 0);
};

async function doAssemble(allowShort = false, comment = '') {
  const b = ST.builder;
  const cost = builderCost();
  if (!cost) return;
  ST.busy = true; render();
  try {
    const res: AssembleResultDTO = await sapi.assemble({
      idempotencyKey: b.idem,
      kind: b.kind,
      templateId: b.templateId,
      lines: Object.entries(b.qty).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty, plannedQty: b.planned?.[itemId] ?? null })),
      price: b.priceEdited && +b.price > 0 ? +b.price : null,
      allowShort,
      shortComment: allowShort ? comment : null,
      expectedCost: cost.cost.costUzs,
    });
    tg.haptic('success');
    for (const w of res.warnings) toast(w, 'info');
    closeLayer();
    resetBuilder();
    void loadCatalog(true).catch(() => {});
    if (res.bouquet.kind === 'order') {
      resetSell([res.bouquet]);
      ST.screen = 'sell';
      refreshSalePreview(); // without a client nothing else asks for the totals: «Считаем…» forever (audit UI-2)
      if (ST.ftab !== 'desk') ST.ftab = 'showcase';
      toast(`Букет №${res.bouquet.number} собран · себестоимость ${fmt(res.bouquet.cost)}`, 'ok');
    } else toast(`Букет №${res.bouquet.number} на витрине`, 'ok');
  } catch (e) {
    tg.haptic('error');
    const err = e as StockErr;
    if (err.code === 'stock_short') { b.short = err.details as StockShortDetails; openShortSheet(); }
    else if (err.code === 'network') {
      // the bouquet may have been created and only the answer lost: «Собран» again without changes is safe (same key)
      toast('Нет связи. Возможно, букет уже собран — проверьте витрину или нажмите «Собран» ещё раз без изменений.', 'error');
    } else if (err.code === 'conflict' && err.status === 409 && /ключ/i.test(err.message)) {
      freshKey(); toast('Состав изменился после сбоя связи — проверьте витрину и нажмите «Собран» ещё раз.', 'error');
    } else toast(err.message, 'error');
  } finally { ST.busy = false; render(); }
}

/** «Не хватает: …» — change the composition or assemble «в минус» with a mandatory comment. */
export function openShortSheet() {
  const s = ST.builder.short;
  if (!s) return;
  const sh = sheet(`<h4>Не хватает на складе</h4>
    <div class="list" style="margin-bottom:10px">${s.short.map((x) => `<div class="it"><div class="ic">!</div><div><div class="t">${esc(x.name)}</div><div class="s">нужно ${fmt(x.need)}, на складе ${fmt(x.have)}</div></div><span class="bad">−${fmt(x.need - x.have)}</span></div>`).join('')}</div>
    ${s.canForce ? `<p>Можно собрать в минус: недостачу закроет следующий приход. Нужен комментарий.</p><input id="stShortC" placeholder="Например: приход ещё не внесён" maxlength="200">` : '<p>Внесите приход или измените состав.</p>'}
    <div class="row2"><button class="b" data-act="stShortEdit" style="justify-content:center">Изменить состав</button>${s.canForce ? '<button class="b danger" data-act="stShortForce">Собрать в минус</button>' : ''}</div>`);
  sh.dataset.sheet = 'short';
}
actions.stShortEdit = () => { closeLayer(); ST.builder.short = null; render(); };
actions.stShortForce = () => {
  const c = (document.getElementById('stShortC') as HTMLInputElement | null)?.value.trim() ?? '';
  if (c.length < 3) { toast('Напишите комментарий (минимум 3 символа)', 'error'); return; }
  void doAssemble(true, c);
};
actions.stAssemble = () => doAssemble();
