/** Owner «Склад» tab: the essentials (stock value, freshness, today's bouquets, waste %), approvals, receipts, catalog. */
import type { StockItemDTO, StockItemInput } from '@honey/contracts';
import { actions } from '../../state';
import { tg } from '../../tg';
import { closeLayer, esc, fmt, sheet, toast } from '../../ui/dom';
import { openBuilder } from './builder';
import { openFresh } from './fresh';
import { openReceipt } from './receipt';
import { sapi } from './sapi';
import { openShowcase } from './showcase';
import { dayTxt, loadCatalog, money, qtyText, render, ST, tile } from './st';

export async function openStockHome() {
  ST.screen = 'home';
  render();
  try { ST.overview = await sapi.overview(); ST.error = null; } catch (e) { ST.error = (e as Error).message; }
  render();
}

export function stockHomeView(): string {
  const o = ST.overview;
  if (!o) return `<h2 class="h disp">Склад</h2>${ST.error ? `<div class="note-box warn">${esc(ST.error)} <button class="link" data-act="stHome">Повторить</button></div>` : '<p class="mut">Загрузка…</p>'}`;
  const w = o.wasteWeek;
  const wasteCls = w.pct === null ? '' : w.pct > w.alarmPct ? 'st-bad' : w.pct > w.normPct ? 'st-warn' : 'st-good';
  const empty = o.items === 0 && !o.lastReceipts.length;
  return `<h2 class="h disp">Склад</h2>
    ${empty ? `<div class="note-box">Каталог и остатки пусты. <button class="link" data-act="stSeed">Заполнить каталог примером</button> (≈30 позиций магазина в Ташкенте) или добавьте позиции в «Каталоге».</div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="v">${money(o.stockValueUzs)}</div><div class="k">стоимость остатка</div></div>
      <div class="kpi"><div class="v">${money(o.expiring.atRiskUzs)}</div><div class="k">под риском · просрочено ${o.expiring.overdue}, сегодня ${o.expiring.today}, скоро ${o.expiring.soon}</div></div>
      <div class="kpi"><div class="v">${o.todayBouquets.count} / ${o.todayBouquets.sold}</div><div class="k">букетов сегодня собрано / продано · ${money(o.todayBouquets.revenueUzs)}</div></div>
      <div class="kpi"><div class="v">${o.todayBouquets.avgMarginPct === null ? '—' : `${String(o.todayBouquets.avgMarginPct).replace('.', ',')}%`}</div><div class="k">средняя маржа сегодня</div></div>
      <div class="kpi"><div class="v ${wasteCls}">${w.pct === null ? '—' : `${String(w.pct).replace('.', ',')}%`}</div><div class="k">потери за 7 дней · ${money(w.wasteUzs)} (норма ${w.normPct}%)</div></div>
      <div class="kpi"><div class="v">${o.showcase.count}</div><div class="k">на витрине · ${money(o.showcase.valueUzs)}</div></div>
    </div>
    <div class="grid2" style="margin-top:0"><button class="b" data-act="stGo" data-s="bouquet">💐 Собрать букет</button><button class="b" data-act="stGo" data-s="receipt">📦 Приход</button><button class="b" data-act="stGo" data-s="fresh">🌡️ Свежесть, списание</button><button class="b" data-act="stGo" data-s="showcase">🪟 Витрина</button><button class="b full" data-act="stGo" data-s="catalog">📋 Каталог</button></div>
    ${o.pendingApprovals.length ? `<div class="sub">На подтверждение (${o.pendingApprovals.length})</div><div class="list">${o.pendingApprovals.map((p) => `<div class="st-card"><div class="st-row"><b>Списание №${p.number}</b><b>${money(p.valueUzs)}</b></div>
        <div class="s mut">${esc(p.lines.map((l) => `${l.name} × ${fmt(l.qty)} (${l.reason})`).join(', '))}</div><div class="s mut">${esc(p.actor)} · ${new Date(p.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${p.note ? ` · ${esc(p.note)}` : ''}</div>
        <div class="st-actions"><button class="b sm acc" data-act="stApprove" data-id="${esc(p.docId)}">Подтвердить</button><button class="b sm danger-outline" data-act="stReject" data-id="${esc(p.docId)}">Отклонить</button></div></div>`).join('')}</div>` : ''}
    ${o.loyaltyPending ? `<div class="note-box warn">Продаж без начисленного мёда: ${o.loyaltyPending}. Откройте продажу и нажмите «Начислить мёд ещё раз».</div>` : ''}
    ${o.deficits.length ? `<div class="sub">Продано в минус (закроет приход)</div><div class="list">${o.deficits.map((d) => `<div class="it"><div class="ic">−</div><div><div class="t">${esc(d.name)}</div></div><span class="bad">${fmt(d.qty)}</span></div>`).join('')}</div>` : ''}
    ${o.lowItems.length ? `<div class="sub">Заканчивается</div><div class="chips">${o.lowItems.map((l) => `<span class="chip">${esc(l.name)}: ${fmt(l.qty)}</span>`).join('')}</div>` : ''}
    ${o.lastReceipts.length ? `<div class="sub">Последние приходы</div><div class="ops">${o.lastReceipts.map((r) => `<div class="op ${r.status === 'cancelled' ? 'dim' : ''}"><div><b>№${r.number}</b> · ${dayTxt(r.docDate)} · ${r.lines} строк${r.currency === 'USD' ? ` · $ по ${fmt(r.fxRate ?? 0)}` : ''}${r.priceMode === 'total' ? ' · одной суммой' : ''}${r.status === 'cancelled' ? ' · <span class="bad">отменён</span>' : ''}<div class="s">${esc(r.actor)}${r.supplier ? ` · ${esc(r.supplier)}` : ''}</div></div><div class="op-r"><span class="amt">${fmt(r.totalUzs)}</span>${r.cancellable ? `<button class="link bad" data-act="stCancelRec" data-id="${esc(r.id)}">Отменить</button>` : ''}</div></div>`).join('')}</div>` : ''}`;
}

actions.stHome = () => openStockHome();
actions.stGo = (el) => {
  const s = el.dataset.s;
  if (s === 'bouquet') void openBuilder();
  else if (s === 'receipt') void openReceipt();
  else if (s === 'fresh') void openFresh();
  else if (s === 'showcase') void openShowcase();
  else if (s === 'catalog') void openCatalog();
};
actions.stSeed = async () => {
  try { const r = await sapi.seedCatalog(); toast(`Добавлено позиций: ${r.items}`, 'ok'); await loadCatalog(true); await openStockHome(); } catch (e) { toast((e as Error).message, 'error'); }
};
actions.stApprove = async (el) => {
  try { await sapi.decide(el.dataset.id!, 'approve'); tg.haptic('success'); toast('Списание подтверждено', 'ok'); await openStockHome(); } catch (e) { toast((e as Error).message, 'error'); }
};
actions.stReject = (el) => {
  const id = el.dataset.id!;
  const sh = sheet(`<h4>Отклонить списание?</h4><p>Стебли вернутся на склад (сторно), флорист увидит отказ в отчёте.</p><input id="stRejR" placeholder="Причина" maxlength="200"><button class="b danger full" id="stRejOk" style="justify-content:center">Отклонить</button>`);
  (sh.querySelector('#stRejOk') as HTMLButtonElement).onclick = async () => {
    const reason = (sh.querySelector('#stRejR') as HTMLInputElement).value.trim();
    if (reason.length < 3) { toast('Укажите причину', 'error'); return; }
    try { await sapi.decide(id, 'reject', reason); closeLayer(); toast('Списание отклонено, остаток возвращён', 'ok'); await openStockHome(); } catch (e) { toast((e as Error).message, 'error'); }
  };
};
actions.stCancelRec = async (el) => {
  try { await sapi.cancelReceipt(el.dataset.id!); toast('Приход отменён', 'ok'); await loadCatalog(true); await openStockHome(); } catch (e) { toast((e as Error).message, 'error'); }
};

// ------------------------------------------------------------------ catalog (owner edits, florists read in the builder)

export async function openCatalog() {
  ST.screen = 'catalog';
  render();
  try { await loadCatalog(true); ST.error = null; } catch (e) { ST.error = (e as Error).message; }
  render();
}

export function catalogView(): string {
  const c = ST.catalog;
  const head = `<button class="back" data-act="stHome">‹ Склад</button><div class="hdr-row"><h2 class="h disp">Каталог</h2><button class="b sm" data-act="stItemNew">+ Позиция</button></div>`;
  if (!c) return head + (ST.error ? `<div class="note-box warn">${esc(ST.error)}</div>` : '<p class="mut">Загрузка…</p>');
  const groups = [...new Set(c.items.map((i) => i.group))];
  return head + groups.map((g) => `<div class="sub">${esc(g || 'Без группы')}</div><div class="list">${c.items.filter((i) => i.group === g).map((i) => `<button class="it btn-it ${i.active ? '' : 'dim'}" data-act="stItemEdit" data-id="${esc(i.id)}">${tile(i)}<div><div class="t">${esc(i.name)}</div><div class="s">${esc(i.sku)}${i.unit.pack ? ` · ${esc(i.unit.pack.name)} ${i.unit.pack.size}` : ''}${i.vaseLifeDays ? ` · ${i.vaseLifeDays} дн. в вазе` : ''}${i.trackStock ? '' : ' · без учёта'}</div></div><span class="mut">${i.trackStock ? esc(qtyText(i, i.qty)) : ''}</span></button>`).join('')}</div>`).join('');
}

function itemSheet(it: StockItemDTO | null) {
  const v = (x: unknown) => esc(x ?? '');
  const sh = sheet(`<h4>${it ? 'Позиция' : 'Новая позиция'}</h4>
    <div class="fields">
      <div class="f"><label for="ciName">Название</label><input id="ciName" value="${v(it?.name)}" maxlength="80"></div>
      <div class="f"><label for="ciSku">Код</label><input id="ciSku" value="${v(it?.sku)}" maxlength="16"></div>
      <div class="f"><label for="ciKind">Вид</label><select id="ciKind">${[['flower', 'Цветок'], ['greenery', 'Зелень'], ['supply', 'Фурнитура'], ['service', 'Услуга']].map(([k, l]) => `<option value="${k}" ${it?.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="f"><label for="ciGroup">Группа</label><input id="ciGroup" value="${v(it?.group)}" maxlength="40"></div>
      <div class="f"><label for="ciPack">В пачке, шт<small>пусто — без пачки</small></label><input id="ciPack" inputmode="numeric" value="${v(it?.unit.pack?.size)}"></div>
      <div class="f"><label for="ciStd">Цена за ед., сум<small>до первого прихода</small></label><input id="ciStd" inputmode="decimal" value="${it?.stdCostMu ? it.stdCostMu / 1000 : ''}"></div>
      <div class="f"><label for="ciVase">Дней в вазе</label><input id="ciVase" inputmode="numeric" value="${v(it?.vaseLifeDays)}"></div>
      <div class="f"><label for="ciSell">Продать за, дней</label><input id="ciSell" inputmode="numeric" value="${v(it?.sellDays)}"></div>
      <div class="f"><label for="ciEmoji">Плитка (эмодзи)</label><input id="ciEmoji" value="${v(it?.emoji)}" maxlength="8"></div>
    </div>
    <button class="tog" id="ciActive" aria-pressed="${it ? it.active : true}"><span>Показывать в конструкторе</span><span class="sw"></span></button>
    <button class="b acc full" id="ciSave">Сохранить</button>`);
  const act = sh.querySelector('#ciActive') as HTMLButtonElement;
  act.onclick = () => act.setAttribute('aria-pressed', String(act.getAttribute('aria-pressed') !== 'true'));
  (sh.querySelector('#ciSave') as HTMLButtonElement).onclick = async () => {
    const val = (id: string) => (sh.querySelector('#' + id) as HTMLInputElement).value.trim();
    const n = (id: string) => (val(id) === '' ? null : Number(val(id).replace(',', '.')));
    const kind = val('ciKind') as StockItemInput['kind'];
    const body: StockItemInput = {
      sku: val('ciSku'), name: val('ciName'), kind, group: val('ciGroup'),
      baseUnit: it?.unit.base ?? (kind === 'flower' || kind === 'greenery' ? 'stem' : 'pcs'), displayUnit: it?.unit.display ?? 'шт', displayFactor: it?.unit.factor ?? 1,
      packName: it?.unit.pack?.name ?? 'пачка', packSize: n('ciPack'), stdCost: n('ciStd'), vaseLifeDays: n('ciVase'), sellDays: n('ciSell'),
      emoji: val('ciEmoji') || null, color: it?.color ?? null, trackStock: kind === 'service' ? false : it ? it.trackStock : true,
      active: act.getAttribute('aria-pressed') === 'true', ...(it ? { version: it.version } : {}),
    };
    try {
      if (it) await sapi.updateItem(it.id, body); else await sapi.createItem(body);
      closeLayer(); toast('Сохранено', 'ok'); await openCatalog();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
}
actions.stItemNew = () => itemSheet(null);
actions.stItemEdit = (el) => itemSheet(ST.catalog?.items.find((i) => i.id === el.dataset.id) ?? null);
