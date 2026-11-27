/**
 * «Приход» — one currency per receipt (сум / доллар + rate prefilled from the last receipt); prices per
 * line (per unit / pack / line) or «одной суммой за поставку» (split by reference price, any line can
 * be fixed by hand ✎); extra costs; «Проверить» (preview) → «Провести».
 */
import type { ReceiptRequest } from '@honey/contracts';
import { newIdempotencyKey } from '../../api';
import { actions, changes, inputs, S } from '../../state';
import { tg } from '../../tg';
import { esc, fmt, toast } from '../../ui/dom';
import { openFresh } from './fresh';
import { openStockHome } from './owner';
import { sapi, StockErr } from './sapi';
import { loadCatalog, money, render, ST, type ReceiptLineDraft } from './st';

const blank = (): ReceiptLineDraft => ({ itemId: '', qty: '', unit: 'base', price: '', per: 'unit' });

export async function openReceipt() {
  const r = ST.receipt;
  ST.screen = 'receipt';
  Object.assign(r, { preview: null, idem: newIdempotencyKey(), lines: [blank()], total: '', extra: '', supplierId: '', mode: 'lines', currency: 'UZS' });
  render();
  try {
    await loadCatalog();
    r.form = await sapi.receiptForm();
    r.fx = r.form.lastFxRate ? String(r.form.lastFxRate) : '';
    r.docDate = r.form.today;
    ST.error = null;
  } catch (e) { ST.error = (e as Error).message; }
  render();
}

const num = (s: string) => Number(String(s).replace(/\s/g, '').replace(',', '.'));

export function receiptBody(): ReceiptRequest {
  const r = ST.receipt;
  return {
    idempotencyKey: r.idem,
    docDate: r.docDate || null,
    supplierId: r.supplierId || null,
    currency: r.currency,
    fxRate: r.currency === 'USD' ? num(r.fx) : null,
    priceMode: r.mode,
    total: r.mode === 'total' ? num(r.total) : null,
    extraCost: Math.floor(num(r.extra) || 0),
    lines: r.lines.filter((l) => l.itemId && num(l.qty) > 0).map((l) => ({
      itemId: l.itemId, qty: Math.floor(num(l.qty)), unit: l.unit,
      ...(l.price.trim() !== '' ? { price: num(l.price), per: l.per } : {}),
    })),
  };
}

export function receiptView(): string {
  const r = ST.receipt;
  const c = ST.catalog;
  if (!c || !r.form) return `<button class="back" data-act="stRecBack">‹ Назад</button><h2 class="h disp">Приход</h2>${ST.error ? `<div class="note-box warn">${esc(ST.error)}</div>` : '<p class="mut">Загрузка…</p>'}`;
  const items = c.items.filter((i) => i.active && i.trackStock);
  const cur = r.currency === 'USD' ? '$' : 'сум';
  const pv = r.preview;
  const line = (l: ReceiptLineDraft, k: number) => {
    const it = items.find((i) => i.id === l.itemId);
    const p = pv?.lines.find((x) => x.itemId === l.itemId);
    return `<div class="st-rline" data-line="${k}">
      <select data-change="stRecItem" data-k="${k}" aria-label="Позиция строки ${k + 1}"><option value="">— позиция —</option>${items.map((i) => `<option value="${esc(i.id)}" ${i.id === l.itemId ? 'selected' : ''}>${esc(i.emoji ?? '')} ${esc(i.name)}</option>`).join('')}</select>
      <div class="st-rgrid">
        <input data-input="stRecQty" data-k="${k}" inputmode="numeric" placeholder="кол-во" value="${esc(l.qty)}" aria-label="Количество">
        <select data-change="stRecUnit" data-k="${k}" aria-label="Единица">${it?.unit.pack ? `<option value="pack" ${l.unit === 'pack' ? 'selected' : ''}>${esc(it.unit.pack.name)} (${it.unit.pack.size})</option>` : ''}<option value="base" ${l.unit === 'base' ? 'selected' : ''}>${esc(it?.unit.base === 'cm' ? 'см' : it?.unit.display ?? 'шт')}</option></select>
        <input data-input="stRecPrice" data-k="${k}" inputmode="decimal" placeholder="${r.mode === 'total' ? '✎ авто' : 'цена, ' + cur}" value="${esc(l.price)}" aria-label="Цена">
        <select data-change="stRecPer" data-k="${k}" aria-label="Цена за">${(['unit', 'pack', 'line'] as const).filter((x) => x !== 'pack' || it?.unit.pack).map((x) => `<option value="${x}" ${l.per === x ? 'selected' : ''}>${{ unit: 'за ед.', pack: 'за пачку', line: 'за строку' }[x]}</option>`).join('')}</select>
      </div>
      ${p ? `<div class="s mut">→ ${p.qtyBase} шт · ${r.currency === 'USD' ? `${p.unitCostCur.toFixed(2).replace('.', ',')} $ ≈ ` : ''}${fmt(p.unitCostUzs)} сум за ед.${p.manual ? ' ✎' : ''}${p.lastCostUzs ? ` (было ${fmt(p.lastCostUzs)})` : ''}</div>` : ''}
      ${r.lines.length > 1 ? `<button class="link bad" data-act="stRecDel" data-k="${k}">Убрать строку</button>` : ''}
    </div>`;
  };
  return `<button class="back" data-act="stRecBack">‹ Назад</button><h2 class="h disp">Приход №${r.form.nextNumber}</h2>
    ${r.form.canBackdate ? `<label class="fl" for="stRecDate">Дата (задним числом до ${r.form.backdateDays} дн.)</label><input id="stRecDate" type="date" data-input="stRecDate" value="${esc(r.docDate)}" max="${esc(r.form.today)}">` : ''}
    ${r.form.suppliers.length ? `<label class="fl" for="stRecSup">Поставщик</label><select id="stRecSup" data-change="stRecSup"><option value="">— не указан —</option>${r.form.suppliers.map((s) => `<option value="${esc(s.id)}" ${s.id === r.supplierId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
    <div class="fl">Валюта прихода</div>
    <div class="seg2" role="group" aria-label="Валюта"><button data-act="stRecCur" data-v="UZS" aria-pressed="${r.currency === 'UZS'}">сум</button><button data-act="stRecCur" data-v="USD" aria-pressed="${r.currency === 'USD'}">доллар</button></div>
    ${r.currency === 'USD' ? `<label class="fl" for="stRecFx">Курс, сум за 1 $${r.form.lastFxRate ? ' (из прошлого прихода)' : ''}</label><input id="stRecFx" data-input="stRecFx" inputmode="decimal" value="${esc(r.fx)}">` : ''}
    <div class="fl">Цены</div>
    <div class="seg2" role="group" aria-label="Цены"><button data-act="stRecMode" data-v="lines" aria-pressed="${r.mode === 'lines'}">по строкам</button><button data-act="stRecMode" data-v="total" aria-pressed="${r.mode === 'total'}">одной суммой</button></div>
    ${r.mode === 'total' ? '<p class="mut" style="margin:0 0 8px">Сумма разложится по строкам по прошлым ценам сортов. ✎ — задать цену строки вручную, остаток перераспределится.</p>' : ''}
    <div class="st-rlines">${r.lines.map(line).join('')}</div>
    <button class="b full" data-act="stRecAdd" style="margin:6px 0 10px">+ строка</button>
    ${r.mode === 'total' ? `<label class="fl" for="stRecTotal">Сумма поставки, ${cur}</label><input id="stRecTotal" data-input="stRecTotal" inputmode="decimal" value="${esc(r.total)}">` : ''}
    <label class="fl" for="stRecExtra">Доставка / таможня, сум</label><input id="stRecExtra" data-input="stRecExtra" inputmode="numeric" placeholder="0" value="${esc(r.extra)}">
    ${pv ? `<div class="calc" style="margin-top:10px"><span>Товар: <b>${r.currency === 'USD' ? `${pv.goodsCur.toLocaleString('ru-RU')} $ ≈ ` : ''}${money(pv.goodsUzs)}</b></span>${pv.extraUzs ? `<span>Накладные: ${money(pv.extraUzs)}</span>` : ''}<span>Итого: <b>${money(pv.totalUzs)}</b></span></div>
      ${pv.warnings.length ? `<div class="note-box warn">${pv.warnings.map((w) => esc(w.message)).join('<br>')}</div>` : ''}` : ''}
    <div class="grid2"><button class="b full" data-act="stRecCheck" style="justify-content:center">Проверить</button><button class="b acc full" data-act="stRecPost" ${!pv || ST.busy ? 'disabled' : ''}>${ST.busy ? 'Проводим…' : 'Провести'}</button></div>`;
}

const k = (el: HTMLElement) => Number(el.dataset.k);
function edited(rerender = false) { ST.receipt.preview = null; ST.receipt.idem = newIdempotencyKey(); if (rerender) render(); else { const b = document.querySelector<HTMLButtonElement>('[data-act="stRecPost"]'); if (b) b.disabled = true; } }
changes.stRecItem = (el) => {
  const l = ST.receipt.lines[k(el)];
  if (!l) return;
  l.itemId = el.value;
  const it = ST.catalog?.items.find((i) => i.id === el.value);
  if (it?.unit.pack) { l.unit = 'pack'; l.per = 'pack'; } else { l.unit = 'base'; l.per = 'unit'; }
  edited(true);
};
changes.stRecUnit = (el) => { const l = ST.receipt.lines[k(el)]; if (l) { l.unit = el.value as 'base' | 'pack'; edited(true); } };
changes.stRecPer = (el) => { const l = ST.receipt.lines[k(el)]; if (l) { l.per = el.value as 'unit' | 'pack' | 'line'; edited(true); } };
changes.stRecSup = (el) => { ST.receipt.supplierId = el.value; edited(); };
inputs.stRecQty = (el) => { const l = ST.receipt.lines[k(el)]; if (l) { l.qty = el.value; edited(); } };
inputs.stRecPrice = (el) => { const l = ST.receipt.lines[k(el)]; if (l) { l.price = el.value; edited(); } };
inputs.stRecFx = (el) => { ST.receipt.fx = el.value; edited(); };
inputs.stRecTotal = (el) => { ST.receipt.total = el.value; edited(); };
inputs.stRecExtra = (el) => { ST.receipt.extra = el.value; edited(); };
inputs.stRecDate = (el) => { ST.receipt.docDate = el.value; edited(); };
actions.stRecCur = (el) => { ST.receipt.currency = el.dataset.v as 'UZS' | 'USD'; edited(true); };
actions.stRecMode = (el) => { ST.receipt.mode = el.dataset.v as 'lines' | 'total'; edited(true); };
actions.stRecAdd = () => { ST.receipt.lines.push(blank()); edited(true); };
actions.stRecDel = (el) => { ST.receipt.lines.splice(k(el), 1); edited(true); };
actions.stRecBack = () => {
  ST.screen = S.me?.role === 'owner' ? 'home' : 'fresh';
  if (S.me?.role === 'owner') void openStockHome();
  else void openFresh();
};
actions.stRecCheck = async () => {
  const body = receiptBody();
  if (!body.lines.length) { toast('Добавьте хотя бы одну строку', 'error'); return; }
  try { ST.receipt.preview = await sapi.receiptPreview(body); render(); } catch (e) { toast((e as StockErr).message, 'error'); }
};
actions.stRecPost = async () => {
  if (ST.busy || !ST.receipt.preview) return;
  ST.busy = true; render();
  try {
    const res = await sapi.receipt({ ...receiptBody(), confirm: true });
    tg.haptic('success');
    toast(`Приход №${res.number} проведён: ${money(res.preview.totalUzs)}${res.settledDeficit ? ` · закрыт минус ${fmt(res.settledDeficit)} шт` : ''}`, 'ok');
    await loadCatalog(true);
    ST.busy = false;
    actions.stRecBack!(document.body, new Event('click'));
  } catch (e) { toast((e as StockErr).message, 'error'); }
  finally { ST.busy = false; render(); }
};
