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
  levels: Array<{ title: string; pct: number }>;
  minCell: number;
  giftCells: number[];
  maxRedeemPct: number;
  expiryDays: number;
  owner: boolean;
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
  claimed: (bonus: number, code: string) =>
    `Готово! 🎉 Мы нашли вас в базе клиентов Honey Flowers: ваш мёд и история сохранены.\n` +
    (bonus > 0 ? `За регистрацию начислено ещё ${fmt(bonus)} мёда.\n` : '') +
    `Номер карты: ${code}. Покажите QR из карты флористу при покупке.`,
  help: 'Команды:\n/card — открыть медовую карту\n/help — как копить мёд\n/lang — язык / til\n/start — начать заново',
  helpFull: (h: HelpInfo) =>
    `🐝 Как работает «Медовые соты»\n\n` +
    `🍯 Мёд — кешбэк с каждой покупки, 1 мёд = 1 сум. Уровни: ${h.levels.map((l) => `${l.title} ${l.pct}%`).join(' → ')}.\n` +
    `🌸 Соты — покупка от ${fmt(h.minCell)} сум переносит пчёлку на следующую соту` +
    (h.giftCells.length ? `; в сотах ${h.giftCells.join(', ')} ждут подарки-сюрпризы.\n` : '.\n') +
    `💳 Мёдом можно оплатить до ${h.maxRedeemPct}% заказа.\n` +
    `⏳ Мёд сгорает, если ${h.expiryDays} ${plural(h.expiryDays, ['день', 'дня', 'дней'])} не было покупок, — мы напомним заранее.\n\n` +
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
    `🐝 «Asal kataklari» qanday ishlaydi\n\n` +
    `🍯 Asal — har bir xariddan keshbek, 1 asal = 1 so‘m. Darajalar: ${h.levels.map((l) => `${l.title} ${l.pct}%`).join(' → ')}.\n` +
    `🌸 Kataklar — ${fmt(h.minCell)} so‘mdan boshlab har bir xarid asalarini keyingi katakka olib o‘tadi` +
    (h.giftCells.length ? `; ${h.giftCells.join(', ')}-kataklarda syurpriz sovg‘alar bor.\n` : '.\n') +
    `💳 Buyurtmaning ${h.maxRedeemPct}% gacha qismini asal bilan to‘lash mumkin.\n` +
    `⏳ ${h.expiryDays} kun davomida xarid bo‘lmasa, asal kuyadi — oldindan eslatamiz.\n\n` +
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
