/**
 * «Продать» — the desk flow for a bouquet: find the client by phone / code / QR (same lookup as the
 * cash desk) or sell «без клиента»; price prefilled from the bouquet; мёд, gift, delivery as a
 * service (no honey), payment method → «Оплачено». The sale posts the stock part first and then the
 * loyalty purchase `sale:<id>` (see apps/worker/src/stock/sales.ts).
 */
import { api, newIdempotencyKey } from '../../api';
import { GIFT_LABELS } from '../../config/texts';
import { actions, changes, inputs, S } from '../../state';
import { tg } from '../../tg';
import { debounce, esc, fmt, toast } from '../../ui/dom';
import { sapi, StockErr } from './sapi';
import { openShowcase } from './showcase';
import { openBuilder, saveTemplateSheet, templateName } from './builder';
import { money, render, saveFloristTab, ST } from './st';

const PAY: Array<[typeof ST.sell.payment, string]> = [['cash', 'Наличные'], ['card', 'Карта'], ['transfer', 'Перевод']];

function deliveryItemId(): string | null {
  return ST.catalog?.items.find((i) => i.kind === 'service' && i.sku === 'DLV')?.id ?? ST.catalog?.items.find((i) => i.kind === 'service')?.id ?? null;
}

function saleBody() {
  const s = ST.sell;
  const price = Math.max(0, Math.floor(+s.price || 0));
  const per = s.bouquets.length === 1 ? [{ id: s.bouquets[0]!.id, price }] : s.bouquets.map((b) => ({ id: b.id }));
  const dlv = deliveryItemId();
  const services = s.channel === 'delivery' && dlv && +s.delivery > 0 ? [{ itemId: dlv, price: Math.floor(+s.delivery) }] : [];
  return { clientId: s.client?.id ?? null, bouquets: per, services, channel: s.channel, redeem: s.redeem, giftId: s.giftId, paymentMethod: s.payment };
}

export const refreshSalePreview = debounce(async () => {
  const s = ST.sell;
  if (ST.screen !== 'sell' || !s.bouquets.length || s.result) return;
  const snapshot = JSON.stringify(saleBody());
  try {
    const p = await sapi.salePreview(saleBody());
    if (JSON.stringify(saleBody()) === snapshot) { s.preview = p; s.previewError = null; }
  } catch (e) { s.preview = null; s.previewError = (e as Error).message; }
  render();
}, 250);

function changed() { ST.sell.preview = null; ST.sell.idem = newIdempotencyKey(); render(); refreshSalePreview(); }

export function sellView(): string {
  const s = ST.sell;
  if (s.result) return doneView();
  if (!s.bouquets.length) return `<h2 class="h disp">Продажа</h2><p class="mut">Выберите букет на витрине.</p>`;
  const b = s.bouquets[0]!;
  const p = s.preview;
  const own = s.client && S.me?.client?.id === s.client.id && !(S.me?.role === 'owner' && S.me?.testMode);
  const gifts = s.client?.gifts.filter((g) => g.status === 'available') ?? [];
  const matches = s.matches.length ? `<div class="list" style="margin-top:8px">${s.matches.map((m) => `<button class="it btn-it" data-act="stPickClient" data-id="${esc(m.id)}"><div class="ic">${esc(m.name.slice(0, 1))}</div><div><div class="t">${esc(m.name)}</div><div class="s">${esc(m.phoneMasked)}</div></div><span class="mut">›</span></button>`).join('')}</div>` : '';
  return `<button class="back" data-act="stSellBack">‹ Назад</button>
    <h2 class="h disp">Продать букет №${b.number}</h2>
    <div class="calc"><span>${esc(b.lines.map((l) => `${l.name} × ${fmt(l.qty)}`).join(', '))}</span><span>Себестоимость ${money(b.cost)} · рекомендуем ${money(b.suggestedPrice)}</span></div>
    <label class="fl" for="stSellPrice">Цена, сум</label><input id="stSellPrice" data-input="stSellPrice" inputmode="numeric" value="${esc(s.price)}">
    <div class="sub">Клиент</div>
    ${s.client ? `<div class="cl"><div class="ava">${esc(s.client.name.slice(0, 1))}</div><div><b>${esc(s.client.name)}</b> <span class="mut">${esc(s.client.code)}</span><div class="mut">${esc(s.client.level.name)} · ${fmt(s.client.balance)} мёда</div></div></div>
      <button class="link" data-act="stNoClient">Без клиента</button>
      ${own ? '<div class="note-box warn">Это ваша карта. Нельзя проводить покупку на свою карту — попросите коллегу.</div>' : ''}
      <button class="tog" data-act="stRedeem" aria-pressed="${s.redeem}" ${s.client.balance <= 0 ? 'disabled' : ''}><span>Оплатить мёдом${p?.loyalty ? ` · до ${fmt(p.loyalty.maxRedeem)}` : ''}</span><span class="sw"></span></button>
      ${gifts.length ? `<label class="fl" for="stGift">Подарок клиента</label><select id="stGift" data-change="stGift"><option value="">Не применять</option>${gifts.map((g) => `<option value="${esc(g.id)}" ${s.giftId === g.id ? 'selected' : ''}>${esc(GIFT_LABELS[g.type] ?? g.type)}</option>`).join('')}</select>` : ''}`
    : `${tg.canScan() ? '<button class="b full" data-act="stScan" style="margin-bottom:8px">Сканировать QR клиента</button>' : ''}
      <div class="search"><input id="stSellQ" data-input="stSellQ" placeholder="Телефон или код карты (HF…)" value="${esc(s.query)}" inputmode="search" autocomplete="off" enterkeyhint="search"><button class="b" data-act="stFindClient" aria-label="Найти">🔍</button></div>${matches}
      <p class="mut" style="margin:6px 0 0">Без клиента мёд не начисляется.</p>`}
    <div class="sub">Получение и оплата</div>
    <div class="seg2" role="group" aria-label="Канал"><button data-act="stChannel" data-v="store" aria-pressed="${s.channel === 'store'}">В магазине</button><button data-act="stChannel" data-v="delivery" aria-pressed="${s.channel === 'delivery'}">Доставка</button></div>
    ${s.channel === 'delivery' ? `<label class="fl" for="stDlv">Доставка, сум (мёд на неё не начисляется)</label><input id="stDlv" data-input="stDlv" inputmode="numeric" value="${esc(s.delivery)}">` : ''}
    <div class="chips" style="margin:8px 0 10px">${PAY.map(([v, l]) => `<button class="chip" data-act="stPay" data-v="${v}" aria-pressed="${s.payment === v}">${l}</button>`).join('')}</div>
    <div class="calc">${p ? `<span>Итого: <b>${money(p.total)}</b></span>${p.loyalty ? `<span>К оплате деньгами: <b>${money(p.loyalty.paid)}</b>${p.loyalty.redeemed ? ` · мёдом ${fmt(p.loyalty.redeemed)}` : ''}${p.loyalty.discount ? ` · скидка ${fmt(p.loyalty.discount)}` : ''}</span><span>Кешбэк ${p.loyalty.pct}%: <b>+${fmt(p.loyalty.cashback)} мёда</b>${p.loyalty.cell ? ` · ячейка ${p.loyalty.cell}` : ''}</span>` : '<span>Без клиента — без мёда</span>'}` : s.previewError ? `<span class="bad">${esc(s.previewError)}</span>` : '<span>Считаем…</span>'}</div>
    <button class="b acc full big" data-act="stPaid" ${!p || ST.busy || own ? 'disabled' : ''}>${ST.busy ? 'Проводим…' : 'Оплачено'}</button>`;
}

function doneView(): string {
  const r = ST.sell.result!;
  return `<div class="done-ic">✓</div><h2 class="h disp center" style="margin-bottom:6px">${r.replayed ? 'Уже продано' : 'Продано'}</h2>
    <p class="mut center">Продажа №${r.number} · ${money(r.total)}${r.honeyRedeemed ? ` · мёдом ${fmt(r.honeyRedeemed)}` : ''}</p>
    <div class="calc center-calc">${r.loyaltyStatus === 'done' ? `<span>+${fmt(r.cashback)} мёда клиенту${r.clientBalance !== null ? ` · баланс ${fmt(r.clientBalance)}` : ''}</span>` : r.loyaltyStatus === 'none' ? '<span>Без клиента</span>' : `<span class="bad">Мёд не начислен: ${esc(r.loyaltyError ?? '')}</span>`}</div>
    ${r.loyaltyStatus === 'failed' || r.loyaltyStatus === 'pending' ? `<div class="grid2"><button class="b full" data-act="stRetryLoyalty">Начислить мёд ещё раз</button><button class="b full" data-act="stRetryNoRedeem">Без оплаты мёдом</button></div>` : ''}
    <div class="grid2" style="margin-top:12px"><button class="b acc full" data-act="stSellNew">Новый букет</button><button class="b full" data-act="stSellNext">Готово</button></div>
    ${r.loyaltyStatus !== 'failed' && ST.sell.bouquets.length === 1 ? '<button class="link" data-act="stSellTpl" style="margin-top:6px">Сохранить этот букет как шаблон</button>' : ''}`;
}

async function findClient(q: string) {
  try {
    const r = await api.lookup(q);
    if (r.client) { ST.sell.client = r.client; ST.sell.matches = []; tg.haptic('success'); changed(); }
    else if (r.matches.length) { ST.sell.matches = r.matches; render(); }
    else toast('Клиент не найден. Можно продать без клиента.', 'error');
  } catch (e) { toast((e as Error).message, 'error'); }
}

/** A1: no «🔍» tap needed — a full phone number or card code searches by itself. */
export function autoLookupReady(q: string): boolean {
  const t = q.trim();
  if (/^hf[0-9a-z]{4,}$/i.test(t)) return true;
  const digits = t.replace(/\D/g, '');
  return /^[+\d\s()-]+$/.test(t) && (digits.length === 9 || digits.length === 12);
}
const autoLookup = debounce((q: string) => { if (ST.sell.query === q && !ST.sell.client) void findClient(q); }, 350);
inputs.stSellQ = (el) => { ST.sell.query = el.value; if (autoLookupReady(el.value)) autoLookup(el.value.trim()); };

inputs.stSellPrice = (el) => { ST.sell.price = el.value.replace(/\D/g, ''); ST.sell.preview = null; ST.sell.idem = newIdempotencyKey(); refreshSalePreview(); };
inputs.stDlv = (el) => { ST.sell.delivery = el.value.replace(/\D/g, ''); ST.sell.preview = null; ST.sell.idem = newIdempotencyKey(); refreshSalePreview(); };
actions.stFindClient = () => {
  const q = (document.getElementById('stSellQ') as HTMLInputElement | null)?.value.trim() ?? '';
  ST.sell.query = q;
  if (q.length < 3) { toast('Введите хотя бы 3 символа', 'error'); return; }
  void findClient(q);
};
actions.stPickClient = (el) => findClient(el.dataset.id!);
actions.stScan = async () => { const d = await tg.scanQr('Наведите камеру на QR-код в медовой карте клиента'); if (d) await findClient(d.trim()); };
actions.stNoClient = () => { Object.assign(ST.sell, { client: null, redeem: false, giftId: null, matches: [] }); changed(); };
actions.stRedeem = () => { ST.sell.redeem = !ST.sell.redeem; changed(); };
changes.stGift = (el) => { ST.sell.giftId = el.value || null; changed(); };
actions.stChannel = (el) => { ST.sell.channel = el.dataset.v as 'store' | 'delivery'; changed(); };
actions.stPay = (el) => { ST.sell.payment = el.dataset.v as typeof ST.sell.payment; render(); };
actions.stPaid = async () => {
  const s = ST.sell;
  if (ST.busy || !s.preview) return;
  ST.busy = true; render();
  try {
    s.result = await sapi.sale({ idempotencyKey: s.idem, ...saleBody() });
    tg.haptic(s.result.loyaltyStatus === 'failed' ? 'warning' : 'success');
    for (const w of s.result.warnings) toast(w, 'error');
  } catch (e) {
    tg.haptic('error');
    toast((e as StockErr).message, 'error');
  } finally { ST.busy = false; render(); }
};
async function retry(withoutRedeem: boolean) {
  const r = ST.sell.result;
  if (!r) return;
  try { ST.sell.result = await sapi.retryLoyalty(r.saleId, withoutRedeem); if (ST.sell.result.loyaltyStatus === 'done') toast('Мёд начислен', 'ok'); }
  catch (e) { toast((e as Error).message, 'error'); }
  render();
}
actions.stRetryLoyalty = () => retry(false);
actions.stRetryNoRedeem = () => retry(true);
actions.stSellNext = () => { ST.sell.result = null; ST.sell.bouquets = []; backFromSell(); };
actions.stSellNew = () => {
  ST.sell.result = null; ST.sell.bouquets = [];
  if (S.me?.role !== 'owner') { ST.ftab = 'bouquet'; saveFloristTab('bouquet'); }
  void openBuilder();
};
actions.stSellTpl = () => {
  const b = ST.sell.bouquets[0];
  if (!b) return;
  const lines = b.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, name: l.name }));
  saveTemplateSheet(lines.map(({ itemId, qty }) => ({ itemId, qty })), +ST.sell.price || b.priceCurrent || null, templateName(lines));
};
actions.stSellBack = () => backFromSell();

export function backFromSell() {
  if (S.me?.role !== 'owner') ST.ftab = 'showcase';
  void openShowcase();
}
