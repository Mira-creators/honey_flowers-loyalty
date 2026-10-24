/** Owner screens: stats, clients, rules editor, team, operations log. (The cash desk tab reuses the staff screen.) */
import type { EditableRulesDTO, StaffDTO } from '@honey/contracts';
import { S, actions, changes, inputs, app } from '../state';
import { GIFT_LABELS } from '../config/texts';
import { api, ApiErr } from '../api';
import { esc, fmt, toast, sheet, closeLayer } from '../ui/dom';
import { tg } from '../tg';
import { opRow } from './staff';
import { clientsView, loadClients } from './clients';
import { myCardHead } from './myCard';

export function ownerView(): string {
  const o = S.owner;
  const body = o.tab === 'stats' ? statsView() : o.tab === 'clients' ? clientsView() : o.tab === 'rules' ? rulesView() : o.tab === 'staff' ? teamView() : opsView();
  return `<main class="scr" id="scr">${myCardHead()}${body}</main>`;
}

export async function loadOwnerTab() {
  const o = S.owner; o.error = null;
  try {
    if (o.tab === 'stats') o.stats = await api.stats();
    else if (o.tab === 'clients') { await loadClients(true); return; }
    else if (o.tab === 'rules') { o.rules = await api.rules(); o.draft = structuredClone(o.rules); }
    else if (o.tab === 'staff') o.staffList = await api.staff();
    else if (o.tab === 'ops') o.ops = await api.operations();
  } catch (e) { o.error = (e as ApiErr).message; }
  app.render();
}

const errBox = () => S.owner.error ? `<div class="note-box warn">${esc(S.owner.error)} <button class="link" data-act="ownerReload">Повторить</button></div>` : '';

function statsView() {
  const s = S.owner.stats;
  if (!s) return `<h2 class="h disp">Статистика</h2>${errBox() || '<p class="mut">Загрузка…</p>'}`;
  const max = Math.max(1, ...s.perWeek.map(w => w.purchases)), W = 300, H = 110, n = s.perWeek.length || 1, bw = Math.min(28, (W - (n - 1) * 8) / n), gap = n > 1 ? (W - bw * n) / (n - 1) : 0;
  const bars = s.perWeek.map((w, i) => {
    const h = w.purchases / max * (H - 30), x = i * (bw + gap), d = new Date(w.weekStart);
    return `<rect x="${x}" y="${H - 16 - h}" width="${bw}" height="${Math.max(h, 1)}" rx="5" fill="${i === n - 1 ? 'var(--c-accent)' : 'var(--c-line)'}"/><text x="${x + bw / 2}" y="${H - 20 - h}" text-anchor="middle" font-size="9.5" fill="var(--c-muted)">${w.purchases}</text><text x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" font-size="8.5" fill="var(--c-muted)">${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}</text>`;
  }).join('');
  return `<h2 class="h disp">Статистика</h2>${errBox()}${consoleCard()}
    <div class="kpis">
      <div class="kpi"><div class="v">${fmt(s.clients)}</div><div class="k">участников · +${s.clientsNew7d} за 7 дней</div></div>
      <div class="kpi"><div class="v">${Math.round(s.repeatRate90d * 100)}%</div><div class="k">вернулись за 90 дней</div></div>
      <div class="kpi"><div class="v">${fmt(s.purchases)}</div><div class="k">покупок · ${s.purchases7d} за 7 дней</div></div>
      <div class="kpi"><div class="v">${fmt(s.revenueWithCard)}</div><div class="k">выручка с картой, сум</div></div>
      <div class="kpi"><div class="v">${fmt(s.points.accrued)}</div><div class="k">мёда начислено</div></div>
      <div class="kpi"><div class="v">${fmt(s.points.redeemed)}</div><div class="k">мёда потрачено</div></div>
      <div class="kpi"><div class="v">${fmt(s.points.expired)}</div><div class="k">мёда сгорело</div></div>
      <div class="kpi"><div class="v">${fmt(s.points.outstanding)}</div><div class="k">мёда на счетах сейчас</div></div>
      <div class="kpi"><div class="v">${s.giftsUnlocked}</div><div class="k">подарков открыто</div></div>
      <div class="kpi"><div class="v">${s.giftsUsed}</div><div class="k">подарков выдано</div></div>
    </div>
    <div class="chart"><div class="mut" style="font-size:12px;margin-bottom:4px">Покупки с картой по неделям</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Покупки с картой по неделям">${bars}</svg></div>`;
}

function rulesView() {
  const d = S.owner.draft;
  if (!d) return `<h2 class="h disp">Правила</h2>${errBox() || '<p class="mut">Загрузка…</p>'}`;
  const num = (id: string, label: string, v: number, step = 1, hint = '') => `<div class="f"><label for="${id}">${label}${hint ? `<small>${hint}</small>` : ''}</label><input type="number" inputmode="decimal" id="${id}" data-input="rule" data-key="${id}" step="${step}" min="0" value="${v}"></div>`;
  const levels = d.levels.map((l, i) => `<div class="lv-row"><input aria-label="Название уровня ${i + 1}" data-input="rule" data-key="lvname" data-i="${i}" value="${esc(l.name)}"><label class="mini">%<input type="number" min="0" max="50" data-input="rule" data-key="lvpct" data-i="${i}" value="${l.pct}"></label><label class="mini">от, сум<input type="number" min="0" step="100000" data-input="rule" data-key="lvfrom" data-i="${i}" value="${l.from}" ${i === 0 ? 'disabled' : ''}></label></div>`).join('');
  const cells = Array.from({ length: d.cells }, (_, i) => i + 1).map(c => `<label>${c}<select data-change="rule" data-key="gift" data-cell="${c}"><option value="">—</option>${Object.entries(GIFT_LABELS).map(([v, l]) => `<option value="${v}" ${d.gifts[String(c)] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  const dirty = JSON.stringify(d) !== JSON.stringify(S.owner.rules);
  return `<h2 class="h disp">Правила программы</h2>${errBox()}
    <p class="mut" style="margin-top:-6px">Версия ${d.version}. Новые правила действуют для следующих покупок, прошлые не пересчитываются.</p>
    <div class="sub">Уровни и кешбэк</div><div class="lv-list">${levels}</div>
    <div class="sub">Соты</div>
    <div class="fields">${num('minPurchaseForCell', 'Мин. сумма покупки для ячейки, сум', d.minPurchaseForCell, 10000)}${num('maxCellsPerDay', 'Ячеек в день на клиента', d.maxCellsPerDay, 1, 'защита от дробления чека')}</div>
    <div class="cells-ed">${cells}</div>
    <div class="sub">Мёд</div>
    <div class="fields">${num('maxRedeemPct', 'Оплата мёдом, до % заказа', d.maxRedeemPct)}${num('expiryDays', 'Сгорает без покупок через, дней', d.expiryDays)}<div class="f"><label for="warn">Напоминать за, дней<small>через запятую</small></label><input id="warn" data-input="rule" data-key="warn" value="${d.expiryWarnDays.join(', ')}"></div>${num('welcomeBonus', 'Приветственный бонус, мёда', d.welcomeBonus, 1000)}${num('reversalWindowHours', 'Флорист может отменить покупку в течение, часов', d.reversalWindowHours ?? 24, 1, 'от 1 до 720; и только пока мёд и подарок за неё не потрачены')}</div>
    <div class="sticky-save"><button class="b acc full big" data-act="saveRules" ${!dirty || S.owner.busy ? 'disabled' : ''}>${S.owner.busy ? 'Сохраняем…' : dirty ? 'Сохранить правила' : 'Изменений нет'}</button>${dirty ? '<button class="link" data-act="discardRules">Сбросить изменения</button>' : ''}</div>`;
}

function teamView() {
  const list = S.owner.staffList;
  const roles: Record<StaffDTO['role'], string> = { florist: 'Сотрудник', manager: 'Сотрудник', owner: 'Владелец' };
  return `<h2 class="h disp">Команда</h2>${errBox()}
    <p class="mut" style="margin-top:-6px">Сотрудник начисляет и отменяет покупки. Владелец ещё видит статистику, журнал и меняет правила и команду.</p>
    <div class="list">${list ? (list.length ? list.map(s => `<div class="it"><div class="ic">${esc(s.name.slice(0, 1))}</div><div><div class="t">${esc(s.name)}</div><div class="s">${roles[s.role]}${s.telegramId ? ' · id ' + s.telegramId : ' · ждёт входа в бота'}</div></div><button class="link bad" data-act="removeStaff" data-id="${esc(s.id)}">Убрать</button></div>`).join('') : '<p class="mut">Пока никого. Добавьте флориста ниже.</p>') : '<p class="mut">Загрузка…</p>'}</div>
    <div class="sub">Добавить сотрудника</div>
    <div class="form"><label class="fl" for="newStaff">Телефон (как в Telegram) или Telegram ID</label><input id="newStaff" inputmode="tel" placeholder="+998 90 123 45 67" autocomplete="off">
      <label class="fl" for="newRole">Роль</label><select id="newRole"><option value="florist">Сотрудник</option><option value="owner">Владелец</option></select>
      <button class="b acc full" data-act="addStaff" style="margin-top:8px">Добавить</button>
      <p class="mut" style="font-size:12px">Человек должен один раз открыть бота и поделиться номером — после этого роль включится сама.</p></div>`;
}

function opsView() {
  const ops = S.owner.ops;
  return `<h2 class="h disp">Журнал операций</h2>${errBox()}<p class="mut" style="margin-top:-6px">Все начисления, списания, отмены и сгорания с автором.</p>
    <div class="ops">${ops ? (ops.length ? ops.map(opRow).join('') : '<p class="mut">Операций пока нет.</p>') : '<p class="mut">Загрузка…</p>'}</div>`;
}

/* ---------------- actions ---------------- */
actions.ownerReload = () => loadOwnerTab();
inputs.rule = el => { const d = S.owner.draft; if (!d) return; applyRuleField(d, el); refreshSaveBar(); };
changes.rule = el => { const d = S.owner.draft; if (!d) return; applyRuleField(d, el); app.render(); };
function applyRuleField(d: EditableRulesDTO, el: HTMLInputElement | HTMLSelectElement) {
  const k = el.dataset.key!, v = el.value, n = Math.max(0, Math.round(+v || 0));
  if (k === 'lvname') d.levels[+el.dataset.i!].name = v.trim() || d.levels[+el.dataset.i!].name;
  else if (k === 'lvpct') d.levels[+el.dataset.i!].pct = Math.min(100, Math.max(0, Math.round((+v || 0) * 100) / 100));
  else if (k === 'lvfrom') d.levels[+el.dataset.i!].from = n;
  else if (k === 'gift') { const c = el.dataset.cell!; if (v) d.gifts[c] = v; else delete d.gifts[c]; }
  else if (k === 'warn') d.expiryWarnDays = v.split(/[,\s]+/).map(x => Math.round(+x)).filter(x => x > 0).sort((a, b) => b - a);
  else if (k === 'reversalWindowHours') d.reversalWindowHours = Math.min(720, Math.max(1, n));
  else (d as unknown as Record<string, number>)[k] = n;
}
/** Update only the save bar while the owner types, so the focused input is not rebuilt. */
function refreshSaveBar() {
  const d = S.owner.draft, btn = document.querySelector<HTMLButtonElement>('[data-act="saveRules"]'); if (!d || !btn) return;
  const dirty = JSON.stringify(d) !== JSON.stringify(S.owner.rules);
  btn.disabled = !dirty || S.owner.busy; btn.textContent = S.owner.busy ? 'Сохраняем…' : dirty ? 'Сохранить правила' : 'Изменений нет';
}
actions.discardRules = () => { S.owner.draft = structuredClone(S.owner.rules); app.render(); };
actions.saveRules = async () => {
  const o = S.owner; if (!o.draft) return;
  const ae = document.activeElement as HTMLInputElement | null;
  if (ae?.dataset?.input) { inputs[ae.dataset.input]?.(ae); ae.blur(); }
  o.busy = true; app.render();
  try {
    const saved: EditableRulesDTO = await api.saveRules(o.draft);
    o.rules = saved; o.draft = structuredClone(saved);
    toast(`Правила сохранены, версия ${saved.version}`, 'ok');
    await app.refresh();
  } catch (e) {
    const err = e as ApiErr;
    if (err.status === 409) {
      // Someone saved newer rules: keep the owner's edits, adopt the new version, let them retry.
      try { const fresh = await api.rules(); o.rules = fresh; if (o.draft) o.draft.version = fresh.version; toast('Правила изменил кто-то ещё. Ваши правки сохранены — нажмите «Сохранить» ещё раз.', 'error'); }
      catch { toast(err.message, 'error'); }
    } else toast(err.message, 'error');
  }
  finally { o.busy = false; app.render(); }
};
actions.addStaff = async () => {
  const v = (document.getElementById('newStaff') as HTMLInputElement).value.trim();
  const role = (document.getElementById('newRole') as HTMLSelectElement).value as StaffDTO['role'];
  if (v.replace(/\D/g, '').length < 5) { toast('Введите телефон или Telegram ID', 'error'); return; }
  try { await api.addStaff(v, role); toast('Сотрудник добавлен', 'ok'); S.owner.staffList = await api.staff(); app.render(); }
  catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.removeStaff = async el => {
  try { await api.removeStaff(el.dataset.id!); S.owner.staffList = await api.staff(); app.render(); toast('Сотрудник убран', 'ok'); }
  catch (e) { toast((e as ApiErr).message, 'error'); }
};

/* ---------------- owner web console ("Кабинет владельца" on a computer) ---------------- */
/** Deep analytics live on a separate page: a one-time link (10 min) logs the owner in there. */
function consoleCard() {
  return `<div class="note-box" style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px">
    <span style="flex:1;min-width:180px">Подробная аналитика, выгрузки и импорт базы — в кабинете на компьютере.</span>
    <button class="b acc" data-act="openConsole">Открыть кабинет на компьютере</button></div>`;
}
actions.openConsole = async () => {
  try {
    const link = await api.webLink();
    const until = new Date(link.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    sheet(`<h4>Кабинет владельца</h4>
      <p>${link.sentToChat ? 'Ссылка отправлена вам в чат с ботом: откройте её на компьютере в Telegram Desktop.' : 'Откройте эту ссылку на компьютере.'}
      Она действует до ${esc(until)} и открывается один раз. Никому её не пересылайте.</p>
      <input id="consoleUrl" readonly value="${esc(link.url)}" style="width:100%;font-size:12px" aria-label="Ссылка на кабинет">
      <div class="grid2"><button class="b" data-act="copyConsole">Скопировать</button><button class="b acc" data-act="goConsole">Открыть здесь</button></div>`);
  } catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.copyConsole = async () => {
  const el = document.getElementById('consoleUrl') as HTMLInputElement | null; if (!el) return;
  try { await navigator.clipboard.writeText(el.value); toast('Ссылка скопирована', 'ok'); }
  catch { el.select(); toast('Выделите ссылку и скопируйте её', 'info'); }
};
actions.goConsole = () => {
  const el = document.getElementById('consoleUrl') as HTMLInputElement | null;
  if (el) { tg.openLink(el.value); closeLayer(); }
};
