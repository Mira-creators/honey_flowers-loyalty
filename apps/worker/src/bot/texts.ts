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

const ru = {
  greeting: (name: string) =>
    `Здравствуйте, ${name}! 🌸\nЭто программа лояльности Honey Flowers «Медовые соты»: за каждую покупку — мёд (кешбэк) и шаг пчёлки по сотам с подарками.\n\n🇺🇿 Assalomu alaykum! Honey Flowers sodiqlik dasturiga xush kelibsiz.`,
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
  help: 'Команды:\n/card — открыть медовую карту\n/lang — язык / til\n/start — начать заново',
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
  expiryWarning: (days: number, balance: number, date: string) =>
    `⏳ Через ${days} ${plural(days, ['день', 'дня', 'дней'])} сгорит ${fmt(balance)} мёда. Загляните к нам до ${date} — любая покупка сохранит мёд.`,
  expired: (amount: number, days: number) => `🥀 Сгорело ${fmt(amount)} мёда: не было покупок ${days} ${plural(days, ['день', 'дня', 'дней'])}.`,
  cardReset: 'Медовые соты начаты заново.',
  reversed: (reason: string) => `↩️ Покупка отменена: ${reason}. Мёд и соты пересчитаны.`,
  adjusted: (amount: number, balance: number, reason: string) =>
    `${amount > 0 ? '🍯 Начислено' : 'Списано'} ${fmt(Math.abs(amount))} мёда: ${reason}. Баланс: ${fmt(balance)} мёда.`,
};

const uz: typeof ru = {
  greeting: ru.greeting,
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
  help: 'Buyruqlar:\n/card — asal kartasini ochish\n/lang — til / язык\n/start — boshidan boshlash',
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
  expiryWarning: (days, balance, date) =>
    `⏳ ${days} kundan keyin ${fmt(balance)} asal kuyib ketadi. ${date} gacha keling — har qanday xarid asalni saqlab qoladi.`,
  expired: (amount, days) => `🥀 ${fmt(amount)} asal kuydi: ${days} kun davomida xarid bo‘lmadi.`,
  cardReset: 'Asal kataklari qaytadan boshlandi.',
  reversed: (reason) => `↩️ Xarid bekor qilindi: ${reason}. Asal va kataklar qayta hisoblandi.`,
  adjusted: (amount, balance, reason) =>
    `${amount > 0 ? '🍯 Qo‘shildi' : 'Yechildi'} ${fmt(Math.abs(amount))} asal: ${reason}. Balans: ${fmt(balance)} asal.`,
};

export const TEXTS: Record<BotLang, typeof ru> = { ru, uz };

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
    { command: 'lang', description: 'Язык / Til' },
  ],
  uz: [
    { command: 'start', description: 'Boshlash / karta olish' },
    { command: 'card', description: 'Asal kartasini ochish' },
    { command: 'lang', description: 'Til / Язык' },
  ],
};
