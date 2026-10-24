/**
 * Owner: give a client a gift or bonus мёд WITHOUT a purchase, with a reason
 * (POST /api/owner/clients/:id/grant). The client gets the usual Telegram message and,
 * in the app, the honeycomb surprise (gift flip) or the honey drop into the balance.
 *
 * Entry points: openGrantSheet(clientId, clientName) — from the staff desk client view
 * (owner only) and from the owner's client card. After success the updated client
 * summary is applied to the desk and broadcast as a `honey:client-updated` DOM event.
 */
import type { OwnerGrantRequest } from '@honey/contracts';
import { S, actions, inputs, app } from '../state';
import { GIFT_LABELS } from '../config/texts';
import { api, ApiErr, newIdempotencyKey } from '../api';
import { tg } from '../tg';
import { esc, fmt, toast, sheet, closeLayer } from '../ui/dom';

const REASONS = ['День рождения', 'Извинение за задержку', 'Постоянный клиент', 'Компенсация за ошибку', 'Праздник'];
const HONEY_PRESETS = [10_000, 20_000, 50_000, 100_000];

interface GrantState {
  clientId: string;
  clientName: string;
  kind: 'gift' | 'honey';
  giftId: string | null;
  points: number;
  reason: string;
  /** One key per intended grant: a retry after a network error cannot grant twice. */
  key: string;
  busy: boolean;
  gifts: string[] | null;
  error: string | null;
}

let G: GrantState | null = null;
let el: HTMLElement | null = null;

const giftName = (code: string) => GIFT_LABELS[code] ?? code;

function submitLabel(g: GrantState) {
  if (g.busy) return 'Начисляем…';
  return g.kind === 'gift' ? (g.giftId ? `Подарить: ${giftName(g.giftId)}` : 'Выберите подарок') : `Начислить ${fmt(g.points || 0)} мёда`;
}

function body(g: GrantState): string {
  const kindBtn = (k: GrantState['kind'], label: string) => `<button data-act="grantKind" data-kind="${k}" aria-pressed="${g.kind === k}">${label}</button>`;
  const gifts = g.gifts === null
    ? `<p class="mut">${g.error ? esc(g.error) : 'Загружаем подарки из правил…'}</p>`
    : g.gifts.length
      ? `<div class="chips">${g.gifts.map((code) => `<button class="chip" data-act="grantGift" data-gift="${esc(code)}" aria-pressed="${g.giftId === code}">${esc(giftName(code))}</button>`).join('')}</div>`
      : '<p class="mut">В правилах программы нет подарков. Добавьте их в разделе «Правила».</p>';
  const honey = `<div class="chips">${HONEY_PRESETS.map((n) => `<button class="chip" data-act="grantPreset" data-points="${n}" aria-pressed="${g.points === n}">${fmt(n)}</button>`).join('')}</div>
    <label class="fl" for="grantPts">Сколько мёда (1 мёд = 1 сум)</label>
    <input id="grantPts" type="number" inputmode="numeric" min="1" step="1000" data-input="grantPoints" value="${g.points || ''}">`;
  return `<h4>Подарок без покупки</h4>
    <p>Для <b>${esc(g.clientName || 'клиента')}</b>. Клиент получит сообщение от бота и увидит сюрприз в своей медовой карте.</p>
    <div class="seg2" role="group" aria-label="Что подарить">${kindBtn('gift', '🎁 Подарок')}${kindBtn('honey', '🍯 Мёд')}</div>
    <div class="sub">${g.kind === 'gift' ? 'Подарок' : 'Бонусный мёд'}</div>
    ${g.kind === 'gift' ? gifts : honey}
    <div class="sub">Повод</div>
    <div class="chips">${REASONS.map((r) => `<button class="chip" data-act="grantReason" data-reason="${esc(r)}" aria-pressed="${g.reason === r}">${esc(r)}</button>`).join('')}</div>
    <input id="grantReasonIn" data-input="grantReason" placeholder="Или свой повод" autocomplete="off" maxlength="200" value="${esc(g.reason)}">
    <button class="b acc full big" id="grantGo" data-act="grantSubmit" ${g.busy ? 'disabled' : ''}>${esc(submitLabel(g))}</button>
    <button class="link" data-act="grantClose" style="display:block;margin:6px auto 0">Отмена</button>`;
}

function paint() {
  if (!G) return;
  if (!el || !el.isConnected) el = sheet(body(G), () => { G = null; el = null; });
  else el.innerHTML = body(G);
}

function refreshButton() {
  const b = document.getElementById('grantGo') as HTMLButtonElement | null;
  if (b && G) { b.textContent = submitLabel(G); b.disabled = G.busy; }
}

async function loadGifts(g: GrantState) {
  try {
    const rules = await api.rules();
    const codes = Object.entries(rules.gifts).sort((a, b) => +a[0] - +b[0]).map(([, code]) => code);
    g.gifts = [...new Set(codes)];
    g.giftId ??= g.gifts[0] ?? null;
  } catch (e) {
    g.error = (e as ApiErr).message;
  }
  if (G === g) paint();
}

export function openGrantSheet(clientId: string, clientName: string): void {
  el = null;
  G = { clientId, clientName, kind: 'gift', giftId: null, points: 20_000, reason: '', key: newIdempotencyKey(), busy: false, gifts: null, error: null };
  paint();
  void loadGifts(G);
}

/** A different grant needs a different key (the same key with other values is a 409). */
function changed() { if (G) G.key = newIdempotencyKey(); }

actions.grantKind = (b) => { if (!G) return; G.kind = b.dataset.kind as GrantState['kind']; changed(); tg.haptic('select'); paint(); };
actions.grantGift = (b) => { if (!G) return; G.giftId = b.dataset.gift!; changed(); tg.haptic('select'); paint(); };
actions.grantPreset = (b) => { if (!G) return; G.points = +b.dataset.points!; changed(); tg.haptic('select'); paint(); };
actions.grantReason = (b) => { if (!G) return; G.reason = b.dataset.reason!; tg.haptic('select'); paint(); };
actions.grantClose = () => { G = null; el = null; closeLayer(); };
inputs.grantPoints = (i) => { if (!G) return; G.points = Math.max(0, Math.round(+i.value || 0)); changed(); refreshButton(); };
inputs.grantReason = (i) => { if (!G) return; G.reason = i.value; };

actions.grantSubmit = async () => {
  const g = G; if (!g || g.busy) return;
  const reason = g.reason.trim();
  if (reason.length < 3) { toast('Укажите повод — его увидит клиент', 'error'); return; }
  let req: OwnerGrantRequest;
  if (g.kind === 'gift') {
    if (!g.giftId) { toast('Выберите подарок', 'error'); return; }
    req = { kind: 'gift', giftId: g.giftId, reason };
  } else {
    if (!(g.points >= 1)) { toast('Укажите, сколько мёда начислить', 'error'); return; }
    req = { kind: 'honey', points: g.points, reason };
  }
  g.busy = true; refreshButton();
  try {
    const r = await api.grant(g.clientId, req, g.key);
    tg.haptic('success');
    const who = g.clientName || 'клиента';
    toast(r.replayed ? 'Это уже было начислено' : g.kind === 'gift' ? `🎁 ${giftName(g.giftId!)} — подарок для ${who} отправлен` : `🍯 +${fmt(r.points)} мёда для ${who}`, 'ok');
    G = null; el = null; closeLayer();
    if (S.staff.client?.id === r.client.id) { S.staff.client = r.client; app.render(); }
    document.dispatchEvent(new CustomEvent('honey:client-updated', { detail: r.client }));
  } catch (e) {
    tg.haptic('error');
    toast((e as ApiErr).message, 'error');
    // Keep the key: pressing again after a network error replays instead of granting twice.
    if (G === g) { g.busy = false; refreshButton(); }
  }
};
