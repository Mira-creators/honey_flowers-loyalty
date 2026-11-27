import type { LegalDTO, LegalDocDTO } from '@honey/contracts';
import type { LoyaltyRules } from '@honey/core';
import { HttpError } from './errors.js';

/**
 * Д1: «Правила программы» and «Согласие на обработку персональных данных», shown before the client
 * shares the phone (bot /start and Mini App onboarding) and as in-app pages.
 *
 * TEMPLATES: the shop's details are placeholders in square brackets ([ФИО ИП], [ИНН], [адрес] …) and
 * the texts must be checked by a lawyer (ЗРУ-547 «О персональных данных» and the amendments of
 * 26.03.2026, docs/Спорные вопросы.md Д1–Д2). The numbers (percentages, days, bonuses) come from the
 * rules in force, so the texts never contradict the program.
 *
 * Versioning: CONSENT_VERSION is stored per client (clients.consent_version, migration 0011). Change it
 * whenever the texts change in substance: every client is asked again on the next open.
 */
export const CONSENT_VERSION = '2026-11-10-draft';
export const LEGAL_IS_DRAFT = true;

const fmt = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const days = (n: number) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;
const purchases = (n: number) => `${n} ${plural(n, ['покупка', 'покупки', 'покупок'])}`;

const GIFT_RU: Record<string, string> = { free_card: 'открытка', free_delivery: 'бесплатная доставка', custom: 'подарок' };
function cellGiftsRu(rules: LoyaltyRules): string {
  return rules.honeycomb.rewards
    .slice()
    .sort((a, b) => a.cell - b.cell)
    .map((r) => `${r.cell} — ${r.type === 'discount_pct' ? `скидка ${r.value ?? 0} %` : GIFT_RU[r.type] ?? r.title}`)
    .join(', ');
}

function levelRuleRu(rules: LoyaltyRules): string {
  const lv = rules.levels;
  const tiers = lv.tiers;
  const up = tiers
    .slice(1)
    .map((t) => `${t.title} ${t.cashbackPct} % — ${lv.criterion === 'count' ? `от ${purchases(t.threshold)}` : `от ${fmt(t.threshold)} сум`}`)
    .join(', ');
  const period = lv.windowDays ? ` за последние ${days(lv.windowDays)}` : lv.windowMonths ? ` за последние ${lv.windowMonths} мес.` : ' за всё время';
  const perDay = lv.criterion === 'count' && lv.oncePerDay ? ' (все заказы одного дня — одна покупка)' : '';
  const keep =
    lv.mode === 'sticky' && lv.resetAfterDays
      ? ` Пока вы покупаете хотя бы раз в ${days(lv.resetAfterDays)}, уровень сохраняется; после ${days(lv.resetAfterDays)} без покупок он сбрасывается до «${tiers[0]!.title}».`
      : '';
  return `${tiers[0]!.title} ${tiers[0]!.cashbackPct} % с первой покупки; ${up}${period}${perDay}.${keep}`;
}

/** 3–4 bullets «Как работает Медовая карта» from the rules in force. */
export function summaryBullets(rules: LoyaltyRules, lang: 'ru' | 'uz' = 'ru'): string[] {
  const tiers = rules.levels.tiers;
  const br = rules.birthdayReward;
  const bday = br.enabled && br.type === 'discount_pct' ? br.value : 0;
  if (lang === 'uz') {
    return [
      `🍯 Har bir xariddan asal (keshbek): ${tiers.map((t) => `${t.cashbackPct}%`).join(' → ')}, 1 asal = 1 so‘m.`,
      rules.levels.criterion === 'count'
        ? `👑 Daraja ${rules.levels.windowDays ?? 90} kun ichidagi xaridlar soniga bog‘liq (${tiers.slice(1).map((t) => `${t.threshold} — ${t.title}`).join(', ')}); kuniga bitta xarid hisoblanadi.`
        : `👑 Daraja xaridlar summasiga bog‘liq.`,
      `🐝 Kataklar: har bir xarid — bitta qadam; ${rules.honeycomb.rewards.map((r) => r.cell).join(', ')}-kataklarda sovg‘alar.`,
      `💳 Buyurtmaning ${rules.maxRedeemPct}% gacha qismini asal bilan to‘lash mumkin; asal ${rules.expiry.expiryDays} kun xarid bo‘lmasa kuyadi.` +
        (rules.welcomeBonus > 0 ? ` Ro‘yxatdan o‘tganingiz uchun ${fmt(rules.welcomeBonus)} asal` : '') +
        (bday ? `, tug‘ilgan kunga −${bday}%.` : '.'),
    ];
  }
  const lv = rules.levels;
  const levelBullet =
    lv.criterion === 'count'
      ? `👑 Уровень растёт от числа покупок за ${lv.windowDays ? days(lv.windowDays) : 'период'}: ${tiers.slice(1).map((t) => `${t.threshold} — «${t.title}»`).join(', ')}${lv.oncePerDay ? ' (одна покупка в день)' : ''}.` +
        (lv.mode === 'sticky' && lv.resetAfterDays ? ` Покупайте хотя бы раз в ${days(lv.resetAfterDays)} — уровень сохранится.` : '')
      : `👑 Уровень растёт от суммы покупок: ${tiers.slice(1).map((t) => `от ${fmt(t.threshold)} сум — «${t.title}»`).join(', ')}.`;
  return [
    `🍯 Мёд с каждой покупки: ${tiers.map((t) => `${t.cashbackPct} %`).join(' → ')} по уровню, 1 мёд = 1 сум.`,
    levelBullet,
    `🐝 Соты: каждая покупка${rules.honeycomb.maxCellsPerDay === 1 ? ' (одна в день)' : ''} — шаг пчёлки, подарки на сотах ${cellGiftsRu(rules)}.`,
    `💳 Мёдом — до ${rules.maxRedeemPct} % заказа; мёд сгорает через ${days(rules.expiry.expiryDays)} без покупок, мы напомним.` +
      (rules.welcomeBonus > 0 ? ` За регистрацию — ${fmt(rules.welcomeBonus)} мёда` : '') +
      (bday ? `${rules.welcomeBonus > 0 ? ',' : ' Подарок:'} −${bday} % ко дню рождения.` : rules.welcomeBonus > 0 ? '.' : ''),
  ];
}

function rulesDoc(rules: LoyaltyRules): LegalDocDTO {
  const br = rules.birthdayReward;
  const bday = br.enabled && br.type === 'discount_pct';
  return {
    id: 'rules',
    title: 'Правила программы лояльности «Медовая карта»',
    paragraphs: [
      `Редакция ${CONSENT_VERSION}. Действуют с [дата начала действия].`,
      '## 1. Кто проводит программу',
      'Программу лояльности «Медовая карта» цветочного магазина Honey Flowers проводит индивидуальный предприниматель [ФИО ИП], ИНН [ИНН], адрес: [адрес], телефон: [телефон] (далее — «Магазин»).',
      'Участвуя в программе, вы принимаете эти правила. Участие бесплатное и добровольное.',
      '## 2. Как стать участником',
      'Участником может стать любой человек старше [возраст, например 16] лет, у которого есть аккаунт Telegram. Для регистрации нужно открыть бота Магазина, принять эти правила и согласие на обработку персональных данных и поделиться номером телефона.',
      'Одному номеру телефона соответствует одна карта. Если покупку уже начисляли на ваш номер до регистрации, после регистрации карта со всеми начислениями станет вашей.',
      '## 3. Мёд',
      `• За каждую оплаченную покупку начисляется кешбэк баллами — «мёдом». 1 мёд = 1 сум. Процент зависит от уровня: ${rules.levels.tiers.map((t) => `${t.title} — ${t.cashbackPct} %`).join(', ')}.`,
      `• Мёд начисляется на оплаченную деньгами часть заказа${rules.cashbackCategories.delivery ? '' : ', кроме стоимости доставки'}.`,
      `• Мёдом можно оплатить до ${rules.maxRedeemPct} % стоимости заказа.${rules.allowDiscountWithPoints ? '' : ' Мёд не используется в одном заказе со скидкой (за соту или ко дню рождения).'}`,
      rules.welcomeBonus > 0 ? `• После регистрации начисляется приветственный бонус ${fmt(rules.welcomeBonus)} мёда; его можно потратить сразу, в пределах ${rules.maxRedeemPct} % заказа.` : '• Приветственный бонус не предусмотрен.',
      `• Если ${days(rules.expiry.expiryDays)} подряд не было покупок, весь мёд на карте сгорает. Каждая покупка продлевает срок. Мы напомним об этом за ${rules.expiry.expiryWarnDays.map((d) => days(d)).join(', ')}.`,
      '• Мёд не обменивается на деньги и не передаётся другому человеку.',
      '## 4. Уровни',
      `• ${levelRuleRu(rules)}`,
      rules.levels.mode === 'sticky' && rules.levels.resetWarnDays.length ? `• О скором сбросе уровня мы напомним за ${rules.levels.resetWarnDays.map((d) => days(d)).join(' и ')}.` : '• Новый процент действует со следующей покупки.',
      '## 5. Медовые соты и подарки',
      `• Каждая покупка${rules.honeycomb.minPurchaseForCell > 0 ? ` от ${fmt(rules.honeycomb.minPurchaseForCell)} сум` : ''} переносит пчёлку на следующую соту, не больше ${rules.honeycomb.maxCellsPerDay === 1 ? 'одной соты' : `${rules.honeycomb.maxCellsPerDay} сот`} в день.`,
      `• Подарки на сотах: ${cellGiftsRu(rules)}. После последней соты начинается новая карта с теми же подарками.`,
      '• Подарок используется в одном из следующих заказов; в одном заказе — один подарок.',
      ...(bday
        ? [
            '## 6. День рождения',
            `• Если вы указали дату рождения, за ${days(br.daysBefore)} до дня рождения появляется подарок «−${br.value} %», он действует до ${days(br.daysAfter)} после дня рождения, один раз в год.`,
            '• Дату рождения можно указать один раз; изменить её может только Магазин по вашей просьбе.',
            '• Скидка ко дню рождения не суммируется со скидкой за соту и не совмещается с оплатой мёдом.',
          ]
        : []),
      '## 7. Отмена и возврат',
      `• Если покупку начислили по ошибке, Магазин может отменить начисление в течение ${rules.reversalWindowHours} ч. При возврате товара начисленный за него мёд и подарки отменяются.`,
      '## 8. Изменение и завершение программы',
      '• Магазин может изменить правила, предупредив участников в боте не менее чем за [срок, например 14 дней]. Новые правила действуют для следующих покупок.',
      '• Магазин может завершить программу, предупредив участников за [срок]; накопленный мёд можно использовать до даты завершения.',
      '## 9. Контакты',
      'Вопросы по программе: [телефон / Telegram магазина], адрес магазина: [адрес].',
    ],
  };
}

function consentDoc(): LegalDocDTO {
  return {
    id: 'consent',
    title: 'Согласие на обработку персональных данных',
    paragraphs: [
      `Редакция ${CONSENT_VERSION}.`,
      'Я, участник программы лояльности «Медовая карта», в соответствии с Законом Республики Узбекистан «О персональных данных» (ЗРУ-547) даю согласие индивидуальному предпринимателю [ФИО ИП], ИНН [ИНН], адрес: [адрес] (далее — «Оператор») на обработку моих персональных данных на следующих условиях.',
      '## 1. Какие данные',
      '• имя и идентификатор аккаунта Telegram;',
      '• номер телефона;',
      '• дата рождения — если я укажу её сам;',
      '• история покупок в магазине Honey Flowers: дата, сумма, начисленный и списанный мёд, подарки.',
      '## 2. Для чего',
      '• ведение моей карты программы лояльности: начисление и списание мёда, уровни, подарки;',
      '• служебные сообщения в Telegram: о начислениях, подарках, скором сгорании мёда и сбросе уровня;',
      '• учёт и статистика Магазина в обезличенном виде.',
      'Рекламные рассылки — только с отдельного согласия [пункт будет добавлен, если понадобится].',
      '## 3. Что Оператор делает с данными',
      'Сбор, запись, хранение, уточнение, использование, обезличивание, блокирование и удаление. Данные не передаются третьим лицам, кроме [поставщик хостинга / сервисы, если требуется], и не продаются.',
      '## 4. Где и сколько хранятся',
      'Данные хранятся [место хранения базы данных — уточнить с юристом с учётом требований о хранении данных граждан Узбекистана] в течение участия в программе и [срок] после выхода из неё.',
      '## 5. Как отозвать согласие',
      'Я могу отозвать согласие, написав Оператору: [контакт для обращений]. После отзыва карта будет закрыта, а данные удалены в течение [срок], кроме случаев, когда хранение требует закон.',
      '## 6. Срок действия',
      'Согласие действует с момента нажатия «Принимаю» до его отзыва.',
    ],
  };
}

export function legalDTO(rules: LoyaltyRules): LegalDTO {
  return { version: CONSENT_VERSION, draft: LEGAL_IS_DRAFT, summary: summaryBullets(rules), rules: rulesDoc(rules), consent: consentDoc() };
}

/**
 * Д1 gate: the Telegram user must have accepted the CURRENT texts before a card is created or claimed.
 * Returns the accepted version; throws 409 consent_required otherwise.
 */
export async function requireConsent(app: { repo: { getTgConsent(id: number): Promise<{ version: string } | null> } }, telegramId: number): Promise<string> {
  const c = await app.repo.getTgConsent(telegramId);
  if (c?.version !== CONSENT_VERSION) {
    throw new HttpError(409, 'consent_required', 'Сначала примите правила программы и согласие на обработку персональных данных');
  }
  return c.version;
}
