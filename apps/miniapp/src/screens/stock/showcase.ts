/** «Витрина» — bouquets not sold yet: sell, put on the showcase, disassemble back into stems, cancel. */
import type { BouquetDTO } from '@honey/contracts';
import { newIdempotencyKey } from '../../api';
import { actions } from '../../state';
import { tg } from '../../tg';
import { closeLayer, esc, fmt, sheet, toast } from '../../ui/dom';
import { sapi } from './sapi';
import { refreshSalePreview } from './sell';
import { loadCatalog, money, render, resetSell, ST } from './st';

export async function openShowcase() {
  ST.screen = 'showcase';
  render();
  try { ST.showcase = await sapi.openBouquets(); ST.error = null; } catch (e) { ST.error = (e as Error).message; }
  render();
}

const ageTxt = (d: number) => (d === 0 ? 'сегодня' : d === 1 ? '1 день' : `${d} дн.`);

export function showcaseView(): string {
  const list = ST.showcase;
  if (!list) return `<h2 class="h disp">Витрина</h2>${ST.error ? `<div class="note-box warn">${esc(ST.error)}</div>` : '<p class="mut">Загрузка…</p>'}`;
  if (!list.length) return `<h2 class="h disp">Витрина</h2><div class="empty"><p class="mut">Непроданных букетов нет. Соберите букет во вкладке «Букет».</p></div>`;
  return `<h2 class="h disp">Витрина</h2><div class="list">${list.map(card).join('')}</div>`;
}

function card(b: BouquetDTO): string {
  const stale = b.ageDays >= 2;
  return `<div class="st-card" data-bouquet="${esc(b.id)}">
    <div class="st-row"><b>Букет №${b.number} ${b.status === 'assembled' ? '<span class="badge">под заказ</span>' : '<span class="badge">на витрине</span>'}</b><b>${money(b.priceCurrent)}</b></div>
    <div class="s mut">${esc(b.lines.map((l) => `${l.name} × ${fmt(l.qty)}`).join(', '))}</div>
    <div class="s mut">себестоимость ${fmt(b.cost)} · ${esc(b.florist)} · <span class="${stale ? 'st-warn' : ''}">${ageTxt(b.ageDays)}</span>${b.usedDeficit ? ' · <span class="st-warn">в минус</span>' : ''}</div>
    <div class="st-actions"><button class="b sm acc" data-act="stSellB" data-id="${esc(b.id)}">Продать</button>${b.status === 'assembled' ? `<button class="b sm" data-act="stToShow" data-id="${esc(b.id)}">На витрину</button>` : ''}<button class="b sm" data-act="stDisasm" data-id="${esc(b.id)}">Разобрать</button><button class="link bad" data-act="stCancelB" data-id="${esc(b.id)}">Отменить</button></div>
  </div>`;
}

const byId = (id: string) => ST.showcase?.find((b) => b.id === id);

actions.stSellB = async (el) => {
  const b = byId(el.dataset.id!);
  if (!b) return;
  await loadCatalog().catch(() => {});
  resetSell([b]);
  ST.screen = 'sell';
  render();
  refreshSalePreview();
};
actions.stToShow = async (el) => {
  try { await sapi.toShowcase(el.dataset.id!); toast('Букет на витрине', 'ok'); await openShowcase(); } catch (e) { toast((e as Error).message, 'error'); }
};
actions.stCancelB = (el) => {
  const b = byId(el.dataset.id!);
  if (!b) return;
  const sh = sheet(`<h4>Отменить сборку №${b.number}?</h4><p>Стебли вернутся в те же партии. Флорист может отменить свою сборку в течение ${ST.catalog?.config.assemblyCancelHours ?? 2} ч, владелец — всегда.</p><div class="row2"><button class="b" id="stCbNo" style="justify-content:center">Не отменять</button><button class="b danger" id="stCbYes">Отменить сборку</button></div>`);
  (sh.querySelector('#stCbNo') as HTMLButtonElement).onclick = closeLayer;
  (sh.querySelector('#stCbYes') as HTMLButtonElement).onclick = async () => {
    try { await sapi.cancelBouquet(b.id); closeLayer(); toast('Сборка отменена, стебли на складе', 'ok'); void loadCatalog(true).catch(() => {}); await openShowcase(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
};
actions.stDisasm = (el) => {
  const b = byId(el.dataset.id!);
  if (!b) return;
  const key = newIdempotencyKey();
  const sh = sheet(`<h4>Разобрать букет №${b.number}</h4><p>Сколько стеблей годны? Они вернутся в исходные партии (с исходной датой прихода). Остальное уйдёт в отходы.</p>
    <div class="fields">${b.lines.filter((l) => l.lots.length || l.kind !== 'supply').map((l) => `<div class="f"><label for="dg-${esc(l.itemId)}">${esc(l.name)}<small>в букете ${fmt(l.qty)}</small></label><input id="dg-${esc(l.itemId)}" data-good="${esc(l.itemId)}" inputmode="numeric" value="${l.qty}"></div>`).join('')}</div>
    <button class="b acc full" id="stDisOk">Разобрать</button>`);
  (sh.querySelector('#stDisOk') as HTMLButtonElement).onclick = async () => {
    const good = [...sh.querySelectorAll<HTMLInputElement>('[data-good]')].map((i) => ({ itemId: i.dataset.good!, qty: Math.max(0, Math.floor(Number(i.value.replace(/\D/g, '')) || 0)) }));
    try {
      const r = await sapi.disassemble(b.id, { idempotencyKey: key, good });
      closeLayer(); tg.haptic('success');
      toast(`Разобран: вернули ${fmt(r.returned)}, в отходы ${fmt(r.wasted)}${r.wasteUzs ? ` (${money(r.wasteUzs)})` : ''}`, 'ok');
      void loadCatalog(true).catch(() => {});
      await openShowcase();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
};
