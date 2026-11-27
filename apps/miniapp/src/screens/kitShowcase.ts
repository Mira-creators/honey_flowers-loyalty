/**
 * Витрина компонентов дизайн-системы (B1). Открывается из тестовой панели → «Дизайн» → «Витрина компонентов».
 * Показывает всё, из чего собираются экраны: цвета темы, шрифты, отступы, кнопки, карточки, поля, плашки,
 * листы, тосты, состояния «загрузка / пусто / ошибка / нет сети», шмеля в трёх позах. Светлая и тёмная тема — переключателем.
 */
import { S, actions } from '../state';
import { THEMES, ACTIVE_THEME, COLOR_ROLES, applyTheme } from '../config/themes';
import { tg } from '../tg';
import { esc, toast, sheet, closeLayer } from '../ui/dom';
import { btn, field, card, note, tag, kv, sprig, pageHead, sheetHead, loadingState, skeleton, emptyState, errorState, busy, setFieldError } from '../ui/kit';
import { mascotSvg } from '../ui/mascot';
import { showNet } from '../ui/install';
import { IC } from '../ui/icons';

let dark: boolean | null = null; // null = как в Telegram

const SIZES = ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-6', '--sp-8'];
const TYPE: Array<[string, string, boolean]> = [['--fs-3xl', '125 400 мёда', true], ['--fs-2xl', 'Медовая карта', true], ['--fs-xl', 'Заголовок экрана', true],
  ['--fs-lg', 'Заголовок листа', false], ['--fs-md', 'Основной текст — 15 px', false], ['--fs-sm', 'Вторичный текст, строки списков', false], ['--fs-xs', 'МЕЛКАЯ ПОДПИСЬ', false]];

function page(): string {
  const sec = (title: string, body: string) => `<section class="kit-sec"><h3>${esc(title)}</h3>${body}</section>`;
  return `<div class="kit-page" id="kitPage" role="dialog" aria-modal="true" aria-label="Витрина компонентов">
  <div class="kit-bar"><h2>Витрина компонентов</h2>
    <div class="chips">${[['auto', 'Как в Telegram'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([k, l]) => `<button class="chip" data-act="kitDark" data-v="${k}" aria-pressed="${(k === 'auto' && dark === null) || (k === 'dark' && dark === true) || (k === 'light' && dark === false)}">${l}</button>`).join('')}</div>
    ${btn('', { act: 'kitClose', variant: 'soft', iconHtml: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>', label: 'Закрыть витрину' })}
  </div>
  <main class="scr">
    ${note('Экраны берут цвета только из темы (<b>config/themes.ts</b>), размеры — из токенов (<b>ui/tokens.css</b>), разметку — из <b>ui/kit.ts</b>. Описание — <b>ui/README.md</b>.', 'info')}

    ${sec('Цвета темы «' + esc(THEMES[S.themeId ?? ACTIVE_THEME]?.name ?? '') + '»', `<div class="kit-sw">${COLOR_ROLES.map(r => `<div><i style="background:var(--c-${r})"></i><span>${r}</span></div>`).join('')}</div>`)}

    ${sec('Шрифты', `<div class="kit-type">${TYPE.map(([v, t, d]) => `<p style="font-size:var(${v});line-height:var(--lh-tight)" class="${d ? 'disp' : ''}">${esc(t)} <span class="mut">${v}</span></p>`).join('')}</div>`)}

    ${sec('Отступы (шаг 4 px)', `<div class="kit-row">${SIZES.map(v => `<div style="display:grid;justify-items:center;gap:var(--sp-1)"><i style="display:block;width:var(${v});height:var(${v});background:var(--c-accent);border-radius:var(--r-xs)"></i><span class="mut">${v}</span></div>`).join('')}</div>`)}

    ${sec('Кнопки', `<div class="btn-col">
      ${btn('Начислить мёд', { variant: 'primary', size: 'lg', full: true })}
      <div class="grid2" style="margin:0">${btn('Вторичная', {})}${btn('Тёмная', { variant: 'dark' })}${btn('Зелёная', { variant: 'leaf' })}${btn('Мягкая', { variant: 'soft' })}${btn('Ссылка-кнопка', { variant: 'ghost' })}${btn('Удалить', { variant: 'danger-outline' })}</div>
      <div class="kit-row">${btn('Маленькая', { size: 'sm' })}${btn('', { iconHtml: IC.scan, label: 'Сканировать QR' })}${btn('Нельзя', { disabled: true })}${btn('Отправка', { variant: 'primary', busy: true })}</div>
      ${btn('Нажмите дважды быстро — сработает один раз', { act: 'kitBusy', variant: 'primary', full: true, id: 'kitBusyBtn' })}
      <p class="mut" id="kitBusyCount">Срабатываний: 0</p>
    </div>`)}

    ${sec('Карточки', `${card(kv('Мёд', '+4 400', 'honey') + kv('Сота', '6 из 10') + kv('Подарок', 'бесплатная доставка', 'gift'), { titleHtml: 'Предпросмотр начисления', asideHtml: tag('Королева улья', 'honey') })}
      ${card('<p style="margin:0">Мягкая карточка — для вторичных блоков.</p>', { tone: 'soft', over: 'Надзаголовок' })}
      ${card('<p style="margin:0">Медовая — для мёда и подарков.</p>', { tone: 'honey' })}
      ${card('<p style="margin:0">Приподнятая — поверх фона с узором.</p>', { tone: 'raised' })}`)}

    ${sec('Заголовок экрана и разделитель', `${pageHead('История', { sub: 'Покупки и мёд за всё время', asideHtml: tag('3 новых', 'gift') })}${sprig()}`)}

    ${sec('Бейджи', `<div class="kit-row">${tag('Пчёлка')}${tag('Золотой мёд', 'honey')}${tag('Начислено', 'good')}${tag('Отменено', 'bad')}${tag('Сгорит через 7 дн.', 'warn')}${tag('Подарок', 'gift')}</div>`)}

    ${sec('Плашки', `${note('Клиента нет в боте — мёд и соты сохранятся на номер <b>+998 90 123 45 67</b>.', 'info')}${note('Покупка проведена.', 'good')}${note('Мёд сгорит <b>12 декабря</b>, если не будет покупок.', 'warn')}${note('Не удалось начислить. Попробуйте ещё раз.', 'bad')}${note('Скидка −10 % ко дню рождения ждёт вас до <b>5 января</b>.', 'gift')}`)}

    ${sec('Поля', `${field({ id: 'kitPhone', label: 'Телефон клиента', type: 'tel', inputmode: 'tel', placeholder: '+998 90 123 45 67', hint: 'Можно без +998' })}
      ${field({ id: 'kitSum', label: 'Сумма покупки', inputmode: 'numeric', suffix: 'сум', value: '440 000' })}
      ${field({ id: 'kitErr', label: 'Код клиента', value: '12', error: 'Код — 6 цифр с карты клиента' })}
      ${field({ id: 'kitSel', label: 'Повод', controlHtml: '<select id="kitSel"><option>Извинение</option><option>Праздник</option></select>' })}
      <div class="kit-row">${btn('Показать ошибку', { act: 'kitFieldErr', size: 'sm' })}${btn('Убрать ошибку', { act: 'kitFieldOk', size: 'sm' })}</div>`)}

    ${sec('Списки, чипы, переключатель', `<div class="list"><div class="it"><div class="ic">А</div><div><div class="t">Анна</div><div class="s">+998 90 ••• 45 67 · Королева улья</div></div><span class="amt p">+4 400</span></div>
      <div class="it"><div class="ic">${IC.gifts}</div><div><div class="t">Открытка</div><div class="s">Сота 3</div></div>${tag('Ждёт', 'gift')}</div></div>
      <div class="chips" style="margin-top:var(--sp-3)"><button class="chip" aria-pressed="true">Все</button><button class="chip" aria-pressed="false">Активные</button><button class="chip" aria-pressed="false">Засыпают</button></div>
      <button class="tog" aria-pressed="true" style="margin-top:var(--sp-3)">Напоминать о сгорании<span class="sw"></span></button>`)}

    ${sec('Лист и тосты', `<div class="kit-row">${btn('Открыть лист', { act: 'kitSheet' })}${btn('Тост: готово', { act: 'kitToast', data: { k: 'ok' } })}${btn('Тост: ошибка', { act: 'kitToast', data: { k: 'error' } })}${btn('Тост: инфо', { act: 'kitToast', data: { k: 'info' } })}</div>`)}

    ${sec('Нет сети', `<div class="kit-row">${btn('Связь пропала', { act: 'kitNet', data: { v: 'off' } })}${btn('Связь вернулась', { act: 'kitNet', data: { v: 'on' } })}</div>`)}

    ${sec('Загрузка', `<div class="kit-box">${loadingState('Загружаем карту…')}</div><div class="kit-box" style="padding:var(--sp-4);margin-top:var(--sp-2)">${skeleton()}</div>`)}
    ${sec('Пусто', `<div class="kit-box">${emptyState({ title: 'Подарков пока нет', text: 'Каждая покупка заполняет соту. На 3-й, 6-й и 10-й — подарки.', action: { text: 'Как это работает', act: 'kitToast', data: { k: 'info' } } })}</div>`)}
    ${sec('Ошибка', `<div class="kit-box">${errorState({ title: 'Не получилось загрузить', text: 'Проверьте интернет и попробуйте ещё раз.', action: { text: 'Повторить', act: 'kitToast', data: { k: 'ok' } }, code: 'код: net_timeout' })}</div>`)}

    ${sec('Шмель — три позы (места для рисунков Мираславы)', `<div class="kit-row" style="justify-content:space-around">${(['flying', 'sitting', 'celebrating'] as const).map(p => `<div style="display:grid;justify-items:center;gap:var(--sp-1)">${mascotSvg(p, 1.4, p === 'flying' ? 'bee-idle' : '')}<span class="mut">${p}</span></div>`).join('')}</div>`)}
    <div style="height:var(--sp-10)"></div>
  </main></div>`;
}

function paint() {
  const d = dark ?? tg.colorScheme() === 'dark';
  const th = applyTheme(S.themeId ?? ACTIVE_THEME, d);
  tg.setColors((d ? th.dark : th.light).bg);
}

export function openKitShowcase() {
  const layer = document.getElementById('layer'); if (!layer) return;
  layer.innerHTML = page();
  tg.backButton(() => actions.kitClose?.(layer, new Event('click')));
}

let clicks = 0;
actions.openKit = () => openKitShowcase();
actions.kitClose = () => { dark = null; paint(); closeLayer(); tg.backButton(null); };
actions.kitDark = el => { const v = el.dataset.v; dark = v === 'auto' ? null : v === 'dark'; paint(); openKitShowcase(); };
actions.kitBusy = async el => {
  await busy('kitBusy', el, async () => { clicks++; await new Promise(r => setTimeout(r, 1200)); });
  const c = document.getElementById('kitBusyCount'); if (c) c.textContent = `Срабатываний: ${clicks}`;
};
actions.kitFieldErr = () => setFieldError('kitPhone', 'Номер должен начинаться с +998');
actions.kitFieldOk = () => setFieldError('kitPhone', null);
actions.kitToast = el => {
  const k = el.dataset.k as 'ok' | 'error' | 'info';
  toast(k === 'ok' ? 'Мёд начислен: +4 400' : k === 'error' ? 'Нет связи с сервером. Покупка не проведена' : 'Подсказка: QR-код клиента — в разделе «Карта»', k);
};
actions.kitNet = el => showNet(el.dataset.v === 'on');
actions.kitSheet = () => {
  // A sheet replaces the layer; reopen the showcase when it closes.
  sheet(`${sheetHead('Начислить на номер', { sub: 'Клиент ещё не в боте', closeAct: 'kitSheetClose' })}
    ${field({ id: 'kitShPhone', label: 'Телефон', type: 'tel', inputmode: 'tel', value: '+998 90 123 45 67' })}
    ${card(kv('Мёд', '+4 400', 'honey') + kv('Сота', '1 из 10'), { tone: 'soft' })}
    <div class="sheet-foot">${btn('Начислить', { act: 'kitSheetClose', variant: 'primary', size: 'lg', full: true })}</div>`, () => openKitShowcase());
};
actions.kitSheetClose = () => openKitShowcase();
