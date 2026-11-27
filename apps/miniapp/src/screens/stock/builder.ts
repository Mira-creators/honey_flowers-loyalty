/** «Букет» — phone-first bouquet builder: tiles with +/−, live FIFO cost, suggested price, cost shares, «Собран». */
import type { AssembleResultDTO, StockShortDetails } from '@honey/contracts';
import { actions, inputs } from '../../state';
import { tg } from '../../tg';
import { closeLayer, esc, fmt, sheet, toast } from '../../ui/dom';
import { sapi, StockErr } from './sapi';
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
  // most used first (30 days), then catalog order
  const shown = items
    .filter((i) => (!b.group || i.group === b.group) && (!q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)))
    .sort((a, z) => (b.qty[z.id] ? 1 : 0) - (b.qty[a.id] ? 1 : 0) || z.uses30d - a.uses30d);
  const cost = builderCost()!;
  const n = Object.values(b.qty).reduce((a, x) => a + (x > 0 ? 1 : 0), 0);
  const pricing = c.config.pricing;
  const tiles = shown.map((it) => {
    const qn = b.qty[it.id] ?? 0;
    const old = it.ladder[0] && (it.ladder[0].freshness === 'overdue' || it.ladder[0].freshness === 'today');
    const over = it.trackStock && qn > it.qty;
    return `<div class="st-tile ${qn ? 'on' : ''}" data-item="${esc(it.id)}">
      <button class="st-tile-main" data-act="stAdd" data-id="${esc(it.id)}" aria-label="Добавить ${esc(it.name)}">${tile(it)}<span class="st-tile-n">${esc(it.name)}</span></button>
      <div class="st-tile-meta">${it.trackStock ? `ост ${fmt(it.unit.factor > 1 ? it.qty / it.unit.factor : it.qty)}${over ? ' ⚠' : ''}` : 'без учёта'}${old ? ' · <span class="st-warn">старые — первыми</span>' : ''}</div>
      <div class="st-step"><button data-act="stDec" data-id="${esc(it.id)}" aria-label="Меньше" ${qn ? '' : 'disabled'}>−</button><button class="st-q" data-act="stQty" data-id="${esc(it.id)}" aria-label="Ввести количество">${qn ? fmt(qn) : '0'}</button><button data-act="stAdd" data-id="${esc(it.id)}" aria-label="Больше">+</button></div>
    </div>`;
  }).join('');
  const bar = (label: string, share: number, target: number, level: 'good' | 'warn' | 'bad') =>
    `<div class="st-bar"><span>${label}</span><div class="st-track"><i class="${LEVEL_CLASS[level]}" style="width:${Math.min(100, share * 100 / Math.max(target * 2, 1) * 100).toFixed(1)}%"></i><b style="left:50%"></b></div><span class="${LEVEL_CLASS[level]}">${pctTxt(share)} / ${target}% ${LEVEL_ICON[level]}</span></div>`;
  return `<div class="hdr-row"><h2 class="h disp">Новый букет</h2>${n ? '<button class="link" data-act="stClear">Очистить</button>' : ''}</div>
    ${ST.templates.length ? `<div class="chips scroll">${ST.templates.map((t) => `<button class="chip" data-act="stTpl" data-id="${esc(t.id)}" aria-pressed="${b.templateId === t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}
    <div class="search one"><input id="stQ" data-input="stQ" placeholder="Поиск сорта…" value="${esc(b.q)}" autocomplete="off" inputmode="search"></div>
    <div class="chips scroll"><button class="chip" data-act="stGroup" data-g="" aria-pressed="${!b.group}">Все</button>${groups.map((g) => `<button class="chip" data-act="stGroup" data-g="${esc(g)}" aria-pressed="${b.group === g}">${esc(g)}</button>`).join('')}</div>
    <div class="st-tiles">${tiles || '<p class="mut">Ничего не найдено</p>'}</div>
    <div class="st-sum" id="stSum">
      <div class="st-row"><span>Себестоимость</span><b id="stCost">${money(cost.cost.costUzs)}</b></div>
      <div class="st-row"><span>Рекомендуем</span><b>${money(cost.suggested)}</b></div>
      <div class="st-row"><label for="stPrice">Цена</label><span class="st-price"><input id="stPrice" data-input="stPrice" inputmode="numeric" value="${esc(b.priceEdited ? b.price : String(cost.suggested || ''))}" ${pricing.priceMode === 'fixed' ? 'disabled' : ''}><small>маржа ${fmt(cost.price - cost.cost.costUzs)}</small></span></div>
      ${bar('Себест.', cost.costShare, pricing.targets.costShare, cost.costLevel)}
      ${bar('Цветы', cost.flowersShare, pricing.targets.flowersShare, cost.flowersLevel)}
      ${cost.anyShort ? '<div class="note-box warn" style="margin:6px 0 0">⚠ Чего-то не хватает на складе — сервер предложит собрать в минус</div>' : ''}
      <div class="seg2" role="group" aria-label="Вид букета" style="margin-top:10px"><button data-act="stKind" data-v="order" aria-pressed="${b.kind === 'order'}">Под заказ</button><button data-act="stKind" data-v="showcase" aria-pressed="${b.kind === 'showcase'}">На витрину</button></div>
      <button class="b acc full big" data-act="stAssemble" ${!n || ST.busy ? 'disabled' : ''}>${ST.busy ? 'Сохраняем…' : b.kind === 'order' ? 'Собран → продать' : 'Собран → на витрину'}</button>
      ${n ? '<button class="link" data-act="stSaveTpl">Сохранить состав как шаблон</button>' : ''}
    </div>`;
}

function setQty(id: string, q: number) {
  const b = ST.builder;
  const v = Math.max(0, Math.min(10_000, Math.floor(q)));
  if (v) b.qty[id] = v; else delete b.qty[id];
  b.short = null;
  render();
}

actions.stAdd = (el) => { tg.haptic('light'); setQty(el.dataset.id!, (ST.builder.qty[el.dataset.id!] ?? 0) + 1); };
actions.stDec = (el) => { tg.haptic('light'); setQty(el.dataset.id!, (ST.builder.qty[el.dataset.id!] ?? 0) - 1); };
actions.stClear = () => { resetBuilder(); render(); };
actions.stGroup = (el) => { ST.builder.group = el.dataset.g ?? ''; render(); };
actions.stKind = (el) => { ST.builder.kind = el.dataset.v as 'order' | 'showcase'; render(); };
actions.stQty = (el) => {
  const it = itemById(el.dataset.id!);
  if (!it) return;
  const sh = sheet(`<h4>${esc(it.name)}</h4><p>Сколько ${esc(it.unit.base === 'cm' ? 'сантиметров' : 'штук')} в букете? На складе ${esc(qtyText(it, it.qty))}.</p>
    <input id="stQtyIn" inputmode="numeric" value="${ST.builder.qty[it.id] ?? ''}" autocomplete="off"><button class="b acc full" id="stQtyOk">Готово</button>`);
  const inp = sh.querySelector('#stQtyIn') as HTMLInputElement;
  inp.focus();
  (sh.querySelector('#stQtyOk') as HTMLButtonElement).onclick = () => { closeLayer(); setQty(it.id, Number(inp.value.replace(/\D/g, '')) || 0); };
};
inputs.stQ = (el) => { ST.builder.q = el.value; render(); };
inputs.stPrice = (el) => {
  ST.builder.price = el.value.replace(/\D/g, '');
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
  b.qty = Object.fromEntries(t.lines.map((l) => [l.itemId, l.qty]));
  b.planned = { ...b.qty };
  b.templateId = t.id;
  if (t.price) { b.price = String(t.price); b.priceEdited = true; }
  tg.haptic('select');
  render();
};
actions.stSaveTpl = () => {
  const sh = sheet(`<h4>Шаблон букета</h4><p>Состав сохранится, его можно будет выбрать одним касанием.</p><input id="stTplName" placeholder="Например, 15 роз с эвкалиптом" maxlength="60"><button class="b acc full" id="stTplOk">Сохранить</button>`);
  (sh.querySelector('#stTplOk') as HTMLButtonElement).onclick = async () => {
    const name = (sh.querySelector('#stTplName') as HTMLInputElement).value.trim();
    if (name.length < 2) { toast('Введите название', 'error'); return; }
    try {
      const t = await sapi.saveTemplate({ name, lines: Object.entries(ST.builder.qty).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty })) });
      ST.templates.push(t); closeLayer(); toast('Шаблон сохранён', 'ok'); render();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
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
      if (ST.ftab !== 'desk') ST.ftab = 'showcase';
      toast(`Букет №${res.bouquet.number} собран · себестоимость ${fmt(res.bouquet.cost)}`, 'ok');
    } else toast(`Букет №${res.bouquet.number} на витрине`, 'ok');
  } catch (e) {
    tg.haptic('error');
    const err = e as StockErr;
    if (err.code === 'stock_short') { b.short = err.details as StockShortDetails; openShortSheet(); }
    else toast(err.message, 'error');
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
