/** Florist / manager screens: find client → amount, points, gift → charge → result; recent ops with reversal. */
import type { OperationDTO } from '@honey/contracts';
import { S, actions, changes, app, resetStaff } from '../state';
import { GIFT_LABELS, REVERSE_REASONS } from '../config/texts';
import { api, ApiErr, newIdempotencyKey } from '../api';
import { tg } from '../tg';
import { esc, fmt, toast, sheet, closeLayer, debounce } from '../ui/dom';
import { IC } from '../ui/icons';

const dt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const roleName = () => ({ florist: 'Флорист', manager: 'Менеджер', owner: 'Владелец', client: 'Клиент' }[S.me!.role]);

export function staffView(): string {
  const st = S.staff;
  const body = st.step === 'find' ? findView() : st.step === 'client' ? clientView() : doneView();
  return `<main class="scr" id="scr"><div class="staff-head"><span class="pill">${roleName()}</span></div>${body}</main>`;
}

function findView() {
  const st = S.staff;
  const matches = st.matches.length ? `<div class="list" style="margin-top:10px">${st.matches.map(m => `<button class="it btn-it" data-act="pickClient" data-id="${esc(m.id)}"><div class="ic">${esc(m.name.slice(0, 1))}</div><div><div class="t">${esc(m.name)}</div><div class="s">${esc(m.phoneMasked)}</div></div><span class="mut">›</span></button>`).join('')}</div>` : '';
  return `<h2 class="h disp">Начислить покупку</h2>
    ${tg.canScan() ? `<button class="b acc full big" data-act="scan">${IC.scan}Сканировать QR клиента</button>` : `<div class="note-box">Сканер QR работает внутри Telegram. В браузере найдите клиента по телефону или коду карты.</div>`}
    <div class="search"><input id="q" placeholder="Телефон или код карты (HF…)" value="${esc(st.query)}" inputmode="search" autocomplete="off" enterkeyhint="search"><button class="b" data-act="search" aria-label="Найти">${IC.search}</button></div>
    ${matches}
    ${recentBlock()}`;
}

function recentBlock() {
  const r = S.staff.recent;
  if (!r) return `<div class="sub">Последние операции</div><p class="mut">Загрузка…</p>`;
  if (!r.length) return `<div class="sub">Последние операции</div><p class="mut">Пока пусто. Первая покупка появится здесь.</p>`;
  return `<div class="sub">Последние операции</div><div class="ops">${r.slice(0, 12).map(opRow).join('')}</div>`;
}
export function opRow(o: OperationDTO) {
  const what = o.kind === 'purchase' ? `Покупка ${fmt(o.purchaseAmount ?? 0)} сум` : ({ welcome: 'Регистрация', expire: 'Сгорание', reversal: 'Отмена', manual: 'Корректировка', redeem: 'Оплата мёдом', gift_used: 'Подарок выдан' } as Record<string, string>)[o.kind] ?? o.kind;
  const canReverse = o.kind === 'purchase' && o.status === 'active' && o.purchaseId;
  return `<div class="op ${o.status === 'reversed' ? 'dim' : ''}"><div><b>${esc(o.clientName)}</b> · ${what}${o.status === 'reversed' ? ' · <span class="bad">отменена</span>' : ''}<div class="s">${dt(o.at)}${o.staffName ? ' · ' + esc(o.staffName) : ''}</div></div><div class="op-r"><span class="amt ${o.points >= 0 ? 'p' : 'm'}">${o.points >= 0 ? '+' : '−'}${fmt(Math.abs(o.points))}</span>${canReverse ? `<button class="link" data-act="askReverse" data-id="${esc(o.purchaseId!)}">Отменить</button>` : ''}</div></div>`;
}

function clientView() {
  const st = S.staff, c = st.client!, p = st.preview;
  const amt = +st.amount || 0;
  const gifts = c.gifts.filter(g => g.status === 'available');
  return `<button class="back" data-act="backToFind">‹ Другой клиент</button>
    <div class="cl"><div class="ava">${esc(c.name.slice(0, 1))}</div><div><b>${esc(c.name)}</b> <span class="mut">${esc(c.code)}</span><div class="mut">${esc(c.phoneMasked)}</div><div class="mut">${esc(c.level.name)} · ${c.level.pct}% · ${fmt(c.balance)} мёда · соты ${c.card.filled}/${c.card.cells}</div></div></div>
    <div class="amount-disp" aria-live="polite">${amt ? fmt(amt) : '0'}<small>сум</small></div>
    <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'].map(k => `<button data-act="key" data-k="${k}" aria-label="${k === '⌫' ? 'Стереть' : k}">${k}</button>`).join('')}</div>
    <div class="seg2" role="group" aria-label="Канал"><button data-act="channel" data-v="store" aria-pressed="${st.channel === 'store'}">В магазине</button><button data-act="channel" data-v="delivery" aria-pressed="${st.channel === 'delivery'}">Доставка</button></div>
    <button class="tog" data-act="redeem" aria-pressed="${st.redeem}" ${c.balance <= 0 ? 'disabled' : ''}><span>Оплатить мёдом${p ? ` · до ${fmt(p.maxRedeem)}` : ''}</span><span class="sw"></span></button>
    ${gifts.length ? `<label class="fl" for="giftSel">Подарок клиента</label><select id="giftSel" data-change="gift"><option value="">Не применять</option>${gifts.map(g => `<option value="${esc(g.id)}" ${st.giftId === g.id ? 'selected' : ''}>${esc(GIFT_LABELS[g.type] ?? g.type)} (ячейка ${g.cell})</option>`).join('')}</select>` : ''}
    <div class="calc">${amt ? (p ? `
      <span>К оплате деньгами: <b>${fmt(p.paid)} сум</b>${p.redeemed ? ` · мёдом ${fmt(p.redeemed)}` : ''}${p.discount ? ` · скидка ${fmt(p.discount)}` : ''}</span>
      <span>Кешбэк ${p.pct}%: <b>+${fmt(p.cashback)} мёда</b></span>
      <span>${p.cell ? `Соты: <b>ячейка ${p.cell}</b>${p.unlocksGift ? ` · откроется подарок: ${esc(GIFT_LABELS[p.giftType ?? ''] ?? 'сюрприз')} 🎁` : ''}` : p.cellBlockedReason === 'daily_limit' ? 'Ячейка не засчитается: сегодня уже была покупка' : `Ячейка не засчитается: покупка меньше ${fmt(S.me!.rules.minPurchaseForCell)} сум`}</span>`
      : st.previewError ? `<span class="bad">${esc(st.previewError)}</span>` : '<span>Считаем…</span>') : '<span>Введите сумму покупки</span>'}</div>
    <button class="b acc full big" data-act="charge" ${!amt || !p || st.busy ? 'disabled' : ''}>${st.busy ? 'Начисляем…' : 'Начислить'}</button>`;
}

function doneView() {
  const r = S.staff.result!, p = r.preview;
  return `<div class="done-ic">${IC.check}</div><h2 class="h disp center" style="margin-bottom:6px">${r.replayed ? 'Уже начислено' : 'Начислено'}</h2>
    <p class="mut center" style="margin:0 0 6px">${esc(r.client.name)} · ${fmt(p.amount)} сум</p>
    <div class="calc center-calc"><span>+${fmt(p.cashback)} мёда${p.redeemed ? ` · списано ${fmt(p.redeemed)}` : ''}${p.discount ? ` · скидка ${fmt(p.discount)}` : ''}</span>
      <span>${p.cell ? `ячейка ${p.cell}` : 'без ячейки'}${r.giftsUnlocked.length ? ` · открыт подарок: ${r.giftsUnlocked.map(g => esc(GIFT_LABELS[g.type] ?? g.type)).join(', ')}` : ''}${r.levelUp ? ` · новый уровень «${esc(r.levelUp.name)}»` : ''}${r.newCard ? ' · карта заполнена, начата новая' : ''}</span>
      <span>Баланс клиента: <b>${fmt(r.client.balance)} мёда</b></span></div>
    ${r.warnings.length ? `<div class="note-box warn">${r.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="grid2"><button class="b acc full" data-act="nextBuy">Следующая покупка</button><button class="b full" data-act="askReverse" data-id="${esc(r.purchaseId)}" style="justify-content:center">${IC.undo}Отменить эту покупку</button></div>`;
}

/* ---------------- data ---------------- */
export async function loadRecent() {
  try { S.staff.recent = await api.recent(); } catch { S.staff.recent = []; }
  if (S.staff.step === 'find') app.render();
}

async function openClient(q: string) {
  try {
    const r = await api.lookup(q);
    if (r.client) {
      Object.assign(S.staff, { step: 'client', client: r.client, matches: [], amount: '', redeem: false, giftId: null, channel: 'store', preview: null, previewError: null, idem: newIdempotencyKey(), result: null });
      tg.haptic('success'); app.render();
    } else if (r.matches.length) { S.staff.matches = r.matches; app.render(); }
    else { S.staff.matches = []; app.render(); toast('Клиент не найден. Проверьте номер или попросите клиента открыть карту в боте.', 'error'); }
  } catch (e) { toast((e as ApiErr).message, 'error'); }
}

const refreshPreview = debounce(async () => {
  const st = S.staff, amt = +st.amount || 0;
  if (st.step !== 'client' || !st.client) return;
  if (!amt) { st.preview = null; st.previewError = null; app.render(); return; }
  const reqAmount = amt, reqRedeem = st.redeem, reqGift = st.giftId;
  try {
    const p = await api.preview({ clientId: st.client.id, amount: amt, redeem: st.redeem, giftId: st.giftId, channel: st.channel });
    if (+st.amount === reqAmount && st.redeem === reqRedeem && st.giftId === reqGift) { st.preview = p; st.previewError = null; }
  } catch (e) { st.preview = null; st.previewError = (e as ApiErr).message; }
  app.render();
}, 250);

function inputChanged() { S.staff.preview = null; S.staff.idem = newIdempotencyKey(); app.render(); refreshPreview(); }

/* ---------------- actions ---------------- */
actions.scan = async () => {
  const data = await tg.scanQr('Наведите камеру на QR-код в медовой карте клиента');
  if (data) await openClient(data.trim());
};
actions.search = () => { const q = (document.getElementById('q') as HTMLInputElement)?.value.trim() ?? ''; S.staff.query = q; if (q.length < 3) { toast('Введите хотя бы 3 символа', 'error'); return; } openClient(q); };
actions.pickClient = el => openClient(el.dataset.id!);
actions.backToFind = () => { resetStaff(); app.render(); loadRecent(); };
actions.key = el => {
  const k = el.dataset.k!, st = S.staff;
  st.amount = k === '⌫' ? st.amount.slice(0, -1) : (st.amount === '0' ? '' : st.amount) + k;
  if (st.amount.length > 10) st.amount = st.amount.slice(0, 10);
  tg.haptic('light'); inputChanged();
};
actions.channel = el => { S.staff.channel = el.dataset.v as 'store' | 'delivery'; inputChanged(); };
actions.redeem = () => { S.staff.redeem = !S.staff.redeem; inputChanged(); };
changes.gift = el => { S.staff.giftId = el.value || null; inputChanged(); };
actions.charge = async () => {
  const st = S.staff; if (st.busy || !st.client || !st.preview) return;
  st.busy = true; app.render();
  try {
    const r = await api.purchase({ clientId: st.client.id, amount: +st.amount, redeem: st.redeem, giftId: st.giftId, channel: st.channel, idempotencyKey: st.idem });
    st.result = r; st.step = 'done'; st.client = r.client; tg.haptic('success');
  } catch (e) {
    tg.haptic('error');
    // Same idempotency key is kept, so pressing again after a network error cannot double-charge.
    toast((e as ApiErr).message, 'error');
  } finally { st.busy = false; app.render(); }
};
actions.nextBuy = () => { resetStaff(); app.render(); loadRecent(); };
actions.askReverse = el => {
  const id = el.dataset.id!;
  const sh = sheet(`<h4>Отменить покупку?</h4><p>Мёд, ячейка и подарок этой покупки откатятся. Клиент получит уведомление.</p>
    <div class="chips">${REVERSE_REASONS.map(r => `<button class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <input id="revReason" placeholder="Или своя причина" autocomplete="off">
    <div class="row2"><button class="b" id="revNo" style="justify-content:center">Не отменять</button><button class="b danger" id="revYes">Отменить покупку</button></div>`);
  sh.querySelectorAll<HTMLButtonElement>('[data-reason]').forEach(b => b.onclick = () => { (sh.querySelector('#revReason') as HTMLInputElement).value = b.dataset.reason!; sh.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
  (sh.querySelector('#revNo') as HTMLButtonElement).onclick = closeLayer;
  (sh.querySelector('#revYes') as HTMLButtonElement).onclick = async () => {
    const reason = (sh.querySelector('#revReason') as HTMLInputElement).value.trim();
    if (reason.length < 3) { toast('Укажите причину отмены', 'error'); return; }
    try {
      const r = await api.reverse(id, reason); closeLayer();
      toast('Покупка отменена', 'ok'); tg.haptic('warning');
      if (r.warnings.length) toast(r.warnings.join(' '), 'error');
      if (S.staff.step === 'done') { resetStaff(); }
      await loadRecent(); app.render();
      if (S.me?.role === 'owner' && S.owner.tab === 'ops') { S.owner.ops = await api.operations(); app.render(); }
    } catch (e) { toast((e as ApiErr).message, 'error'); }
  };
};
