/** TEST_MODE panel: lets the client's team play every role, move time, run the nightly job, replay onboarding. */
import type { Role } from '@honey/contracts';
import { S, actions, app, resetStaff } from '../state';
import { THEMES, applyTheme } from '../config/themes';
import { api, ApiErr, clearTestUser } from '../api';
import { tg } from '../tg';
import { esc, toast, sheet, closeLayer, fmt } from '../ui/dom';

export const testButton = () => S.me?.testMode ? `<button class="test-fab" data-act="openTest" aria-label="Панель тестирования">🧪 Тест</button>` : '';

const ROLES: Array<[Role, string]> = [['client', 'Клиент'], ['florist', 'Флорист'], ['manager', 'Менеджер'], ['owner', 'Владелец']];

function panelHtml() {
  const me = S.me!;
  const now = new Date(me.now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<h4>Панель тестирования</h4>
    <p>Её видят только тестировщики. В рабочей версии её не будет.</p>
    <div class="sub" style="margin-top:4px">Чьими глазами</div>
    <div class="chips">${ROLES.map(([r, l]) => `<button class="chip" data-act="testRole" data-role="${r}" aria-pressed="${me.role === r}">${l}</button>`).join('')}</div>
    <div class="sub">Тестовые часы</div>
    <p style="margin:0 0 8px">Сегодня по часам программы: <b>${esc(now)}</b>${me.clockOffsetDays ? ` (сдвиг +${me.clockOffsetDays} дн.)` : ''}</p>
    <div class="chips">${[1, 7, 30, 76, 90].map(d => `<button class="chip" data-act="testClock" data-days="${d}">+${d} дн.</button>`).join('')}<button class="chip" data-act="testClock" data-days="reset">Сбросить</button></div>
    <button class="b full" data-act="testExpiry" style="margin-top:8px;justify-content:center">Запустить ночную задачу: сгорание и напоминания</button>
    <div class="sub">Дизайн</div>
    <div class="chips">${Object.entries(THEMES).map(([id, t]) => `<button class="chip" data-act="testTheme" data-th="${id}" aria-pressed="${S.themeId === id}">${esc(t.name)}</button>`).join('')}</div>
    <div class="sub">Сначала</div>
    <button class="b full danger-outline" data-act="testResetMe" style="justify-content:center">Удалить мои данные клиента и пройти регистрацию заново</button>
    ${!tg.inTelegram ? `<button class="link" data-act="testLogout" style="margin-top:10px">Выйти из тестового входа</button>` : ''}
    <p class="mut" style="font-size:12px;margin-top:12px">Мёд на счёте: ${me.client ? fmt(me.client.balance) : '—'} · Telegram ID: ${me.telegramId}</p>`;
}

export function openTestPanel() { const sh = sheet(panelHtml()); sh.classList.add('tall'); }

actions.openTest = () => openTestPanel();
actions.testRole = async el => {
  const role = el.dataset.role as Role;
  try {
    await api.test.role(role); closeLayer();
    resetStaff(false);
    S.owner.tab = role === 'owner' ? 'stats' : 'desk'; S.screen = 'home';
    await app.refresh(); toast(`Теперь вы: ${ROLES.find(r => r[0] === role)![1]}`, 'ok');
  } catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.testClock = async el => {
  const v = el.dataset.days!;
  try {
    await api.test.clock(v === 'reset' ? null : +v);
    await app.refresh(); openTestPanel();
    toast(v === 'reset' ? 'Часы сброшены' : `Время сдвинуто на +${v} дн. Нажмите «Запустить ночную задачу», чтобы мёд сгорел или пришло напоминание.`, 'ok');
  } catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.testExpiry = async () => {
  try {
    const r = await api.test.runExpiry(); closeLayer(); await app.refresh();
    toast(`Готово: сгорело у ${r.expired} клиентов, напоминаний отправлено: ${r.warned}`, 'ok');
  } catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.testTheme = el => {
  S.themeId = el.dataset.th!; applyTheme(S.themeId, tg.colorScheme() === 'dark');
  try { localStorage.setItem('honey.theme', S.themeId); } catch { /* ignore */ }
  app.render(); openTestPanel();
};
actions.testResetMe = async () => {
  try { await api.test.resetMe(); closeLayer(); S.screen = 'home'; await app.refresh(); toast('Данные удалены, можно регистрироваться заново', 'ok'); }
  catch (e) { toast((e as ApiErr).message, 'error'); }
};
actions.testLogout = () => { clearTestUser(); location.href = location.pathname; };
