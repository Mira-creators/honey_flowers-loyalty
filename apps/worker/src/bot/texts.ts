/**
 * All bot texts (ru / uz). Uzbek is Latin script; please have a native speaker
 * review it before launch. Money is formatted with space separators: 1 250 000.
 */

export type BotLang = 'ru' | 'uz';

export function asLang(v: string | null | undefined): BotLang {
  return v === 'uz' ? 'uz' : 'ru';
}

/** 1250000 → "1 250 000" (no-break spaces, so Telegram never wraps inside a number). */
export function fmt(n: number): string {
  const sign = n < 0 ? '−' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'. */
export function fmtDate(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** Rules facts for /help (from the rules in force). */
export interface HelpInfo {
  /** «Как работает» bullets from the rules in force (lib/legal.ts summaryBullets). */
  bullets: string[];
  owner: boolean;
}

const ru = {
  greeting: (name: string) =>
    `Здравствуйте, ${name}! 🌸\nЭто «Медовая карта» Honey Flowers: за каждую покупку — мёд (кешбэк) и шаг пчёлки по сотам с подарками.\n\n🇺🇿 Assalomu alaykum! Honey Flowers «Asal kartasi»ga xush kelibsiz.`,
  // Д1: before the phone is shared
  consentIntro: (bullets: string[], draft: boolean) =>
    `🐝 Как работает Медовая карта\n\n${bullets.join('\n')}\n\n` +
    `Прежде чем получить карту, пожалуйста, прочитайте «Правила программы» и «Согласие на обработку персональных данных» и нажмите «✅ Принимаю».` +
    (draft ? '\n\n⚠️ Черновик текстов — требует проверки юристом.' : ''),
  consentRulesButton: '📄 Правила программы',
  consentDataButton: '🔒 Согласие на обработку данных',
  consentAcceptButton: '✅ Принимаю',
  consentAccepted: 'Спасибо! Теперь нажмите «📱 Поделиться номером» внизу экрана 👇',
  consentNeeded: 'Чтобы получить карту, сначала примите правила программы и согласие на обработку данных 👇',
  askContact: 'Чтобы получить медовую карту, нажмите кнопку «📱 Поделиться номером» ниже 👇',
  contactButton: '📱 Поделиться номером',
  openCardButton: '🐝 Открыть медовую карту',
  menuButton: 'Медовая карта',
  openCardHint: 'Ваша медовая карта 👇',
  cardUnavailable: 'Карта откроется, как только администратор завершит настройку бота.',
  notOwnContact: 'Пожалуйста, отправьте свой собственный номер кнопкой «📱 Поделиться номером».',
  badPhone: 'Не получилось распознать номер. Попробуйте ещё раз кнопкой ниже.',
  phoneTaken: 'Этот номер уже привязан к другому аккаунту Telegram. Обратитесь, пожалуйста, к флористу.',
  welcome: (bonus: number, code: string) =>
    (bonus > 0 ? `Готово! 🎉 Вам начислено ${fmt(bonus)} мёда в подарок.\n` : 'Готово! 🎉 Ваша медовая карта создана.\n') +
    `Номер карты: ${code}. Покажите QR из карты флористу при покупке.`,
  alreadyRegistered: (code: string) => `Вы уже участник программы. Номер карты: ${code}.`,
  claimed: (bonus: number, code: string) =>
    `Готово! 🎉 Мы нашли вас в базе клиентов Honey Flowers: ваш мёд и история сохранены.\n` +
    (bonus > 0 ? `За регистрацию начислено ещё ${fmt(bonus)} мёда.\n` : '') +
    `Номер карты: ${code}. Покажите QR из карты флористу при покупке.`,
  help: 'Команды:\n/card — открыть медовую карту\n/help — как копить мёд\n/lang — язык / til\n/start — начать заново',
  helpFull: (h: HelpInfo) =>
    `🐝 Как работает «Медовая карта»\n\n${h.bullets.join('\n')}\n\n` +
    `Команды:\n/card — открыть медовую карту\n/lang — язык / til\n/help — эта подсказка` +
    (h.owner ? '\n/stats — сводка для владельца' : ''),
  helpButton: '🍯 Как копить мёд',
  langButton: '🌐 Язык / Til',
  statsButton: '📊 Сводка за сегодня',
  ownerOnly: 'Эта команда доступна только владельцу 🐝',
  langPrompt: 'Выберите язык / Tilni tanlang:',
  langSet: 'Язык: русский 🇷🇺',
  // notifications
  accrued: (amount: number, balance: number) => `🍯 +${fmt(amount)} мёда за покупку. Баланс: ${fmt(balance)} мёда.`,
  redeemed: (amount: number) => `Оплачено мёдом: ${fmt(amount)}.`,
  cardAdvanced: (cell: number, cells: number, toGift: number | null) =>
    `🐝 Пчёлка на соте ${cell} из ${cells}.` + (toGift ? ` До подарка: ${toGift} ${plural(toGift, ['покупка', 'покупки', 'покупок'])}.` : ''),
  cardCompleted: '🏁 Карта заполнена! Начинаем новую.',
  giftUnlocked: (title: string) => `🎁 Открыт подарок: ${title}! Он ждёт вас в разделе «Подарки».`,
  levelUp: (title: string, pct: number) => `👑 Новый уровень: ${title}! Кешбэк ${pct}% со следующей покупки.`,
  levelDown: (title: string) => `Уровень изменён: ${title}.`,
  levelReset: (title: string, days: number) =>
    `🐝 Уровень сброшен до «${title}»: ${days} ${plural(days, ['день', 'дня', 'дней'])} не было покупок. Мёд на карте сохранился, а новые покупки снова поднимут уровень.`,
  levelWarning: (title: string, days: number, date: string) =>
    `👑 Ваш уровень «${title}» сохранится до ${date}. Сделайте покупку до этой даты — и уровень останется с вами` + (days > 1 ? ` (осталось ${days} ${plural(days, ['день', 'дня', 'дней'])}).` : ' (остался 1 день).'),
  birthdayGift: (title: string, until: string) => `🎂 С наступающим днём рождения! Ваш подарок: ${title}. Он действует до ${until} включительно и ждёт вас в разделе «Подарки».`,
  expiryWarning: (days: number, balance: number, date: string) =>
    `⏳ Через ${days} ${plural(days, ['день', 'дня', 'дней'])} сгорит ${fmt(balance)} мёда. Загляните к нам до ${date} — любая покупка сохранит мёд.`,
  expired: (amount: number, days: number) => `🥀 Сгорело ${fmt(amount)} мёда: не было покупок ${days} ${plural(days, ['день', 'дня', 'дней'])}.`,
  cardReset: 'Медовые соты начаты заново.',
  reversed: (reason: string) => `↩️ Покупка отменена: ${reason}. Мёд и соты пересчитаны.`,
  giftGranted: (title: string, reason: string) => `🎁 Подарок от Honey Flowers: ${title}! Повод: ${reason}. Он ждёт вас в разделе «Подарки».`,
  pointsGranted: (amount: number, balance: number, reason: string) =>
    `🍯 Вам начислено ${fmt(amount)} мёда от Honey Flowers. Повод: ${reason}. Баланс: ${fmt(balance)} мёда.`,
  adjusted: (amount: number, balance: number, reason: string) =>
    `${amount > 0 ? '🍯 Начислено' : 'Списано'} ${fmt(Math.abs(amount))} мёда: ${reason}. Баланс: ${fmt(balance)} мёда.`,
};

const uz: typeof ru = {
  greeting: ru.greeting,
  consentIntro: (bullets, draft) =>
    `🐝 Asal kartasi qanday ishlaydi\n\n${bullets.join('\n')}\n\n` +
    `Karta olishdan oldin «Dastur qoidalari» va «Shaxsiy ma’lumotlarni qayta ishlashga rozilik»ni o‘qing va «✅ Qabul qilaman» tugmasini bosing.` +
    (draft ? '\n\n⚠️ Matnlar qoralama — yurist tekshiruvi kerak.' : ''),
  consentRulesButton: '📄 Dastur qoidalari',
  consentDataButton: '🔒 Ma’lumotlarga rozilik',
  consentAcceptButton: '✅ Qabul qilaman',
  consentAccepted: 'Rahmat! Endi pastdagi «📱 Raqamni ulashish» tugmasini bosing 👇',
  consentNeeded: 'Karta olish uchun avval dastur qoidalari va ma’lumotlarga rozilikni qabul qiling 👇',
  askContact: 'Asal kartasini olish uchun pastdagi «📱 Raqamni ulashish» tugmasini bosing 👇',
  contactButton: '📱 Raqamni ulashish',
  openCardButton: '🐝 Asal kartasini ochish',
  menuButton: 'Asal kartasi',
  openCardHint: 'Sizning asal kartangiz 👇',
  cardUnavailable: 'Administrator botni sozlab bo‘lgach, karta ochiladi.',
  notOwnContact: 'Iltimos, «📱 Raqamni ulashish» tugmasi orqali o‘z raqamingizni yuboring.',
  badPhone: 'Raqamni aniqlab bo‘lmadi. Pastdagi tugma orqali qayta urinib ko‘ring.',
  phoneTaken: 'Bu raqam boshqa Telegram akkauntiga ulangan. Iltimos, floristga murojaat qiling.',
  welcome: (bonus: number, code: string) =>
    (bonus > 0 ? `Tayyor! 🎉 Sizga sovg‘a sifatida ${fmt(bonus)} asal berildi.\n` : 'Tayyor! 🎉 Asal kartangiz yaratildi.\n') +
    `Karta raqami: ${code}. Xarid paytida floristga kartadagi QR kodni ko‘rsating.`,
  alreadyRegistered: (code: string) => `Siz allaqachon dastur ishtirokchisisiz. Karta raqami: ${code}.`,
  claimed: (bonus: number, code: string) =>
    `Tayyor! 🎉 Sizni Honey Flowers mijozlari bazasidan topdik: asalingiz va tarixingiz saqlandi.\n` +
    (bonus > 0 ? `Roʻyxatdan oʻtganingiz uchun yana ${fmt(bonus)} asal qoʻshildi.\n` : '') +
    `Karta raqami: ${code}. Xarid paytida kartadagi QR kodni floristga koʻrsating.`,
  help: 'Buyruqlar:\n/card — asal kartasini ochish\n/help — asal qanday yig‘iladi\n/lang — til / язык\n/start — boshidan boshlash',
  helpFull: (h) =>
    `🐝 «Asal kartasi» qanday ishlaydi\n\n${h.bullets.join('\n')}\n\n` +
    `Buyruqlar:\n/card — asal kartasini ochish\n/lang — til / язык\n/help — shu yordam` +
    (h.owner ? '\n/stats — egasi uchun hisobot' : ''),
  helpButton: '🍯 Asal qanday yig‘iladi',
  langButton: '🌐 Til / Язык',
  statsButton: '📊 Bugungi hisobot',
  ownerOnly: 'Bu buyruq faqat do‘kon egasi uchun 🐝',
  langPrompt: ru.langPrompt,
  langSet: 'Til: o‘zbekcha 🇺🇿',
  accrued: (amount, balance) => `🍯 Xarid uchun +${fmt(amount)} asal. Balans: ${fmt(balance)} asal.`,
  redeemed: (amount) => `Asal bilan to‘landi: ${fmt(amount)}.`,
  cardAdvanced: (cell, cells, toGift) =>
    `🐝 Asalari ${cells} ta katakdan ${cell}-katakda.` + (toGift ? ` Sovg‘agacha: ${toGift} ta xarid.` : ''),
  cardCompleted: '🏁 Karta to‘ldi! Yangisini boshlaymiz.',
  giftUnlocked: (title) => `🎁 Sovg‘a ochildi: ${title}! U «Sovg‘alar» bo‘limida sizni kutmoqda.`,
  levelUp: (title, pct) => `👑 Yangi daraja: ${title}! Keyingi xariddan ${pct}% keshbek.`,
  levelDown: (title) => `Daraja o‘zgardi: ${title}.`,
  levelReset: (title, days) => `🐝 Daraja «${title}»ga tushdi: ${days} kun davomida xarid bo‘lmadi. Asal saqlanib qoldi, yangi xaridlar darajani yana ko‘taradi.`,
  levelWarning: (title, days, date) => `👑 «${title}» darajangiz ${date} gacha saqlanadi. Shu sanagacha xarid qiling — daraja sizda qoladi (${days} kun qoldi).`,
  birthdayGift: (title, until) => `🎂 Tug‘ilgan kuningiz bilan! Sovg‘angiz: ${title}. U ${until} gacha amal qiladi va «Sovg‘alar» bo‘limida sizni kutmoqda.`,
  expiryWarning: (days, balance, date) =>
    `⏳ ${days} kundan keyin ${fmt(balance)} asal kuyib ketadi. ${date} gacha keling — har qanday xarid asalni saqlab qoladi.`,
  expired: (amount, days) => `🥀 ${fmt(amount)} asal kuydi: ${days} kun davomida xarid bo‘lmadi.`,
  cardReset: 'Asal kataklari qaytadan boshlandi.',
  reversed: (reason) => `↩️ Xarid bekor qilindi: ${reason}. Asal va kataklar qayta hisoblandi.`,
  giftGranted: (title, reason) => `🎁 Honey Flowers’dan sovg‘a: ${title}! Sabab: ${reason}. U «Sovg‘alar» bo‘limida sizni kutmoqda.`,
  pointsGranted: (amount, balance, reason) => `🍯 Honey Flowers sizga ${fmt(amount)} asal berdi. Sabab: ${reason}. Balans: ${fmt(balance)} asal.`,
  adjusted: (amount, balance, reason) =>
    `${amount > 0 ? '🍯 Qo‘shildi' : 'Yechildi'} ${fmt(Math.abs(amount))} asal: ${reason}. Balans: ${fmt(balance)} asal.`,
};

export const TEXTS: Record<BotLang, typeof ru> = { ru, uz };

/**
 * Level names (Л12). The owner may rename levels in «Правила» (then the name is shown as written);
 * the default Russian names have Uzbek (Latin) and English equivalents.
 */
export const LEVEL_NAMES: Record<string, { uz: string; en: string }> = {
  Пчёлка: { uz: 'Asalari', en: 'Bee' },
  'Королева улья': { uz: 'Ari malikasi', en: 'Queen Bee' },
  'Золотой мёд': { uz: 'Oltin asal', en: 'Golden Honey' },
};
export function levelTitle(ruTitle: string, lang: string | null | undefined): string {
  const tr = LEVEL_NAMES[ruTitle];
  return tr && (lang === 'uz' || lang === 'en') ? tr[lang] : ruTitle;
}

export function t(lang: string | null | undefined) {
  return TEXTS[asLang(lang)];
}

function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** Bot commands for setMyCommands. */
export const COMMANDS: Record<BotLang, Array<{ command: string; description: string }>> = {
  ru: [
    { command: 'start', description: 'Начать / получить карту' },
    { command: 'card', description: 'Открыть медовую карту' },
    { command: 'help', description: 'Как копить мёд' },
    { command: 'lang', description: 'Язык / Til' },
  ],
  uz: [
    { command: 'start', description: 'Boshlash / karta olish' },
    { command: 'card', description: 'Asal kartasini ochish' },
    { command: 'help', description: 'Asal qanday yig‘iladi' },
    { command: 'lang', description: 'Til / Язык' },
  ],
};

// ---------------------------------------------------------------- owner /stats (Russian, like the staff screens)

export interface PeriodStats {
  purchases: number;
  revenue: number;
  newClients: number;
  issued: number;
  redeemed: number;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** 'YYYY-MM-DD' → '18 окт'. */
export function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

function periodBlock(title: string, p: PeriodStats): string {
  return (
    `${title}\n` +
    `🛍 Покупок: ${p.purchases} · выручка ${fmt(p.revenue)} сум\n` +
    `👋 Новых клиентов: ${p.newClients}\n` +
    `🍯 Мёда начислено: ${fmt(p.issued)} · списано: ${fmt(p.redeemed)}`
  );
}

export function ownerStatsText(today: { day: string; stats: PeriodStats }, week: { from: string; stats: PeriodStats }): string {
  const quiet = today.stats.purchases === 0 && week.stats.purchases === 0;
  return (
    `📊 Сводка Honey Flowers\n\n` +
    periodBlock(`Сегодня, ${shortDate(today.day)}:`, today.stats) +
    `\n\n` +
    periodBlock(`За неделю (с ${shortDate(week.from)}):`, week.stats) +
    (quiet ? '\n\nПока тихо — пчёлки ждут первых покупок 🐝' : '\n\nПчёлки трудятся 🐝 Подробности — в приложении, раздел «Статистика».')
  );
}
