/** «Склад» for the florist: freshness (overdue / today / soon), «в букет первыми», write-offs with a reason. */
import type { FreshLotDTO, StockFreshness } from '@honey/contracts';
import { newIdempotencyKey } from '../../api';
import { actions } from '../../state';
import { tg } from '../../tg';
import { closeLayer, esc, fmt, sheet, toast } from '../../ui/dom';
import { openReceipt } from './receipt';
import { sapi } from './sapi';
import { dayTxt, loadCatalog, money, render, ST } from './st';

export async function openFresh() {
  ST.screen = 'fresh';
  render();
  try { ST.fresh = await sapi.freshness(); ST.error = null; } catch (e) { ST.error = (e as Error).message; }
  render();
}

const TITLES: Record<StockFreshness, string> = { overdue: '🔴 Просрочено', today: '🟠 Продать сегодня', soon: '🟡 Скоро', fresh: '🟢 Свежее' };
const REASONS: Array<['wilt' | 'damage' | 'supplier' | 'other', string]> = [['wilt', 'Увяли'], ['damage', 'Сломаны'], ['supplier', 'Брак поставщика'], ['other', 'Другое']];

export function freshView(): string {
  const f = ST.fresh;
  const head = `<div class="hdr-row"><h2 class="h disp">Свежесть</h2>${ST.status?.canReceive ? '<button class="b sm" data-act="stOpenReceipt">+ Приход</button>' : ''}</div>`;
  if (!f) return head + (ST.error ? `<div class="note-box warn">${esc(ST.error)}</div>` : '<p class="mut">Загрузка…</p>');
  const lot = (l: FreshLotDTO) => `<div class="st-lot"><div><b>${esc(l.emoji ?? '')} ${esc(l.name)}</b><div class="s mut">${fmt(l.qty)} шт · от ${dayTxt(l.receivedOn)}${l.sellBy ? ` · продать до ${dayTxt(l.sellBy)}` : ''} · ${money(l.valueUzs)}</div></div>
    <div class="st-lot-a"><button class="b sm" data-act="stWo" data-lot="${esc(l.lotId)}">Списать</button><button class="chip" data-act="stPrio" data-lot="${esc(l.lotId)}" aria-pressed="${l.priority}">В букет первыми</button></div></div>`;
  const group = (k: StockFreshness) => {
    const g = f.groups[k];
    if (!g.count) return '';
    return `<div class="sub">${TITLES[k]} (${g.count}) · ${money(g.valueUzs)}</div>${g.lots.map(lot).join('')}${g.count > g.lots.length ? `<p class="mut">и ещё ${g.count - g.lots.length}</p>` : ''}`;
  };
  const any = f.groups.overdue.count + f.groups.today.count + f.groups.soon.count + f.groups.fresh.count;
  return `${head}<div class="kpis"><div class="kpi"><div class="v">${money(f.atRiskUzs)}</div><div class="k">под риском (просрочено, сегодня, скоро)</div></div><div class="kpi"><div class="v">${f.groups.overdue.count}</div><div class="k">просроченных партий</div></div></div>
    ${any ? (['overdue', 'today', 'soon', 'fresh'] as StockFreshness[]).map(group).join('') : '<div class="empty"><p class="mut">Склад пуст. Внесите приход.</p></div>'}`;
}

const lotById = (id: string) => (['overdue', 'today', 'soon', 'fresh'] as StockFreshness[]).flatMap((k) => ST.fresh?.groups[k].lots ?? []).find((l) => l.lotId === id);

actions.stOpenReceipt = () => openReceipt();
actions.stPrio = async (el) => {
  const l = lotById(el.dataset.lot!);
  if (!l) return;
  try { await sapi.priority(l.lotId, !l.priority); l.priority = !l.priority; tg.haptic('select'); void loadCatalog(true).catch(() => {}); render(); } catch (e) { toast((e as Error).message, 'error'); }
};
actions.stWo = (el) => {
  const l = lotById(el.dataset.lot!);
  if (!l) return;
  const key = newIdempotencyKey();
  let reason: (typeof REASONS)[number][0] = l.freshness === 'overdue' ? 'wilt' : 'damage';
  const threshold = ST.catalog?.config.writeoffApprovalUzs ?? 200_000;
  const sh = sheet(`<h4>Списать: ${esc(l.name)}</h4><p>В партии от ${dayTxt(l.receivedOn)}: ${fmt(l.qty)} шт. Списание от ${fmt(threshold)} сум ждёт подтверждения владельца.</p>
    <label class="fl" for="woQty">Сколько списать</label><input id="woQty" inputmode="numeric" value="${l.qty}">
    <div class="chips">${REASONS.map(([v, t]) => `<button class="chip" data-r="${v}" aria-pressed="${v === reason}">${t}</button>`).join('')}</div>
    <input id="woNote" placeholder="Комментарий (для «Другое» обязателен)" maxlength="200">
    <button class="b danger full" id="woOk" style="justify-content:center">Списать</button>`);
  sh.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((b) => (b.onclick = () => { reason = b.dataset.r as typeof reason; sh.querySelectorAll('[data-r]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
  (sh.querySelector('#woOk') as HTMLButtonElement).onclick = async () => {
    const qty = Math.floor(Number((sh.querySelector('#woQty') as HTMLInputElement).value.replace(/\D/g, '')) || 0);
    const note = (sh.querySelector('#woNote') as HTMLInputElement).value.trim();
    if (qty < 1) { toast('Укажите количество', 'error'); return; }
    try {
      const r = await sapi.writeoff({ idempotencyKey: key, lines: [{ itemId: l.itemId, qty, reason, lotId: l.lotId }], note: note || null });
      closeLayer(); tg.haptic('warning');
      toast(r.approval === 'pending' ? `Списано на ${money(r.valueUzs)} — ждёт подтверждения владельца` : `Списано на ${money(r.valueUzs)}`, 'ok');
      void loadCatalog(true).catch(() => {});
      await openFresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
};
