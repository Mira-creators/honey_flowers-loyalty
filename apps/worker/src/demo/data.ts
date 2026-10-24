/**
 * Deterministic generator of demo clients for the shop-owner briefing (TEST_MODE only).
 * Every client i (1..DEMO_TOTAL) is derived from its own seeded PRNG, so any chunk can be
 * (re)generated independently and a re-run produces the same people, dates and amounts
 * relative to the stored anchor instant.
 *
 * Only the PLAN lives here (who, when, how much). Balances, cells, levels, gifts and expiry
 * are computed by the real engine in seed.ts.
 */

export const DEMO_TOTAL = 250;
export const DEMO_SEED = 20_261_018;
/** History depth, days before the anchor. */
export const DEMO_WINDOW_DAYS = 183;
export const DAY = 86_400_000;
const TZ_OFFSET = 5 * 3_600_000; // Asia/Tashkent, UTC+5, no DST

// ---------------------------------------------------------------- PRNG

/** mulberry32: tiny, fast, good enough for demo data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function rngFor(i: number, salt = 0): () => number {
  return mulberry32((DEMO_SEED ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b)) >>> 0);
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const between = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function weighted<T>(rng: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x < 0) return v;
  }
  return items[items.length - 1]![0];
}

// ---------------------------------------------------------------- ids (UUID-shaped: the staff lookup accepts client ids as UUIDs)

const pad = (n: number, w: number) => String(n).padStart(w, '0');
export const demoClientId = (i: number) => `de300000-0000-4000-8000-${pad(i, 12)}`;
export const demoPurchaseId = (i: number, n: number) => `de3c0000-${pad(i, 4)}-4000-8000-${pad(n, 12)}`;
export const demoLedgerId = (i: number, n: number) => `de3e0000-${pad(i, 4)}-4000-8000-${pad(n, 12)}`;
export const demoStaffId = (j: number) => `de3a0000-0000-4000-8000-${pad(j, 12)}`;
/** Negative: never a real Telegram user (user ids are positive), so nobody can log in as a demo client. */
export const demoTelegramId = (i: number) => -(990_000_000 + i);
export const demoStaffTelegramId = (j: number) => -(980_000_000 + j);

/** "HF" + 6 digits; `salt` > 0 only if the code is taken by a real client. */
export function demoCode(i: number, salt = 0): string {
  return `HF${100_000 + ((i * 7_907 + 54_321 + salt * 104_729) % 900_000)}`;
}

const OPERATORS: ReadonlyArray<readonly [string, number]> = [
  ['90', 22], ['91', 9], ['93', 16], ['94', 9], ['95', 5], ['97', 14], ['98', 6], ['99', 10], ['88', 6], ['33', 5], ['77', 4], ['50', 3], ['20', 2],
];

/** +998 XX NNN NN NN with a real operator code; the 7 digits are a bijection of i (unique within the demo set). */
export function demoPhone(i: number, salt = 0): string {
  const op = weighted(rngFor(i, 11 + salt), OPERATORS);
  const n = 1_000_000 + ((i * 104_729 + 1_234_567 + salt * 7_919) % 9_000_000);
  return `+998${op}${n}`;
}

// ---------------------------------------------------------------- staff

export interface DemoStaff {
  j: number;
  name: string;
  role: 'florist' | 'manager';
  weight: number;
}

export const DEMO_STAFF: readonly DemoStaff[] = [
  { j: 1, name: 'Нигора Каримова', role: 'florist', weight: 34 },
  { j: 2, name: 'Дилноза Юсупова', role: 'florist', weight: 28 },
  { j: 3, name: 'Камила Ахмедова', role: 'florist', weight: 22 },
  { j: 4, name: 'Севара Рашидова', role: 'manager', weight: 16 },
];

// ---------------------------------------------------------------- names

const UZ_F: ReadonlyArray<readonly [string, string]> = [
  ['Дилноза', 'Dilnoza'], ['Малика', 'Malika'], ['Гулнора', 'Gulnora'], ['Нилуфар', 'Nilufar'], ['Шахноза', 'Shahnoza'], ['Мадина', 'Madina'],
  ['Севара', 'Sevara'], ['Зарина', 'Zarina'], ['Камола', 'Kamola'], ['Нигора', 'Nigora'], ['Феруза', 'Feruza'], ['Мохира', 'Mohira'],
  ['Дилдора', 'Dildora'], ['Муниса', 'Munisa'], ['Сабина', 'Sabina'], ['Лола', 'Lola'], ['Барно', 'Barno'], ['Нодира', 'Nodira'],
  ['Умида', 'Umida'], ['Юлдуз', 'Yulduz'], ['Гавхар', 'Gavhar'], ['Шахло', 'Shahlo'], ['Азиза', 'Aziza'], ['Наргиза', 'Nargiza'],
] as const;
const UZ_M: ReadonlyArray<readonly [string, string]> = [
  ['Азиз', 'Aziz'], ['Бобур', 'Bobur'], ['Жасур', 'Jasur'], ['Сардор', 'Sardor'], ['Отабек', 'Otabek'], ['Рустам', 'Rustam'],
  ['Шерзод', 'Sherzod'], ['Жавохир', 'Javohir'], ['Дониёр', 'Doniyor'], ['Акмал', 'Akmal'], ['Фаррух', 'Farrux'], ['Улугбек', 'Ulug‘bek'],
  ['Темур', 'Temur'], ['Бекзод', 'Bekzod'], ['Санжар', 'Sanjar'], ['Ислом', 'Islom'], ['Жахонгир', 'Jahongir'], ['Анвар', 'Anvar'],
  ['Дилшод', 'Dilshod'], ['Мурод', 'Murod'], ['Шохрух', 'Shohrux'], ['Абдулла', 'Abdulla'],
] as const;
const UZ_LAST: ReadonlyArray<readonly [string, string]> = [
  ['Каримов', 'Karimov'], ['Юсупов', 'Yusupov'], ['Рахимов', 'Rahimov'], ['Турсунов', 'Tursunov'], ['Абдуллаев', 'Abdullayev'],
  ['Исмоилов', 'Ismoilov'], ['Назаров', 'Nazarov'], ['Саидов', 'Saidov'], ['Холматов', 'Xolmatov'], ['Мирзаев', 'Mirzayev'],
  ['Эргашев', 'Ergashev'], ['Кодиров', 'Qodirov'], ['Алиев', 'Aliyev'], ['Умаров', 'Umarov'], ['Хасанов', 'Hasanov'],
  ['Собиров', 'Sobirov'], ['Ахмедов', 'Ahmedov'], ['Рашидов', 'Rashidov'], ['Усмонов', 'Usmonov'], ['Жураев', 'Jo‘rayev'],
] as const;
const RU_F = ['Анна', 'Екатерина', 'Ольга', 'Наталья', 'Елена', 'Татьяна', 'Мария', 'Ирина', 'Светлана', 'Юлия', 'Виктория', 'Ксения', 'Алина', 'Дарья'];
const RU_M = ['Алексей', 'Дмитрий', 'Сергей', 'Андрей', 'Игорь', 'Максим', 'Артём', 'Павел', 'Михаил', 'Виктор', 'Денис', 'Руслан'];
const RU_LAST = ['Иванов', 'Смирнов', 'Петров', 'Ковалёв', 'Морозов', 'Волков', 'Николаев', 'Соколов', 'Фёдоров', 'Белов'];
/** Korean surnames are common in Tashkent and do not change with gender. */
const KO_LAST = ['Ким', 'Пак', 'Ли', 'Цой', 'Хван', 'Тен', 'Шин'];

export interface DemoProfile {
  name: string;
  language: 'ru' | 'uz';
  birthday: string;
}

export function demoProfile(i: number): DemoProfile {
  const rng = rngFor(i, 1);
  const female = rng() < 0.56;
  const uzbek = rng() < 0.62;
  const withLast = rng() < 0.68;
  let name: string;
  let language: 'ru' | 'uz';
  if (uzbek) {
    const latin = rng() < 0.45;
    const [fc, fl] = pick(rng, female ? UZ_F : UZ_M);
    const [lc, ll] = pick(rng, UZ_LAST);
    const first = latin ? fl : fc;
    const last = (latin ? ll : lc) + (female ? (latin ? 'a' : 'а') : '');
    name = withLast ? `${first} ${last}` : first;
    language = latin ? (rng() < 0.8 ? 'uz' : 'ru') : rng() < 0.35 ? 'uz' : 'ru';
  } else {
    const first = pick(rng, female ? RU_F : RU_M);
    const korean = rng() < 0.3;
    const last = korean ? pick(rng, KO_LAST) : pick(rng, RU_LAST) + (female ? 'а' : '');
    name = withLast ? `${first} ${last}` : first;
    language = 'ru';
  }
  const birthday = `${between(rng, 1962, 2005)}-${pad(between(rng, 1, 12), 2)}-${pad(between(rng, 1, 28), 2)}`;
  return { name, language, birthday };
}

// ---------------------------------------------------------------- calendar (Tashkent local)

export function localKey(ms: number): string {
  return new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);
}

/** Instant of a Tashkent local time on day `key`. */
export function atLocal(key: string, hour: number, minute: number): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hour - 5, minute);
}

/** Peaks: Valentine's day, 8 March, Navruz, 1 September, Teacher's day (1 October), New Year. */
const HOLIDAYS = ['02-14', '03-08', '03-21', '09-01', '10-01', '12-31'];

/** Holiday instants (noon local) inside [fromMs, toMs]. */
export function holidaysBetween(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const y0 = Number(localKey(fromMs).slice(0, 4));
  const y1 = Number(localKey(toMs).slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    for (const md of HOLIDAYS) {
      const t = atLocal(`${y}-${md}`, 12, 0);
      if (t >= fromMs && t <= toMs) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- client plan

export type Segment = 'loyal' | 'regular' | 'one_time' | 'sleeping' | 'lost' | 'newbie';

const SEGMENTS: ReadonlyArray<readonly [Segment, number]> = [
  ['loyal', 11], ['regular', 26], ['one_time', 26], ['sleeping', 17], ['lost', 15], ['newbie', 5],
];

export interface PlannedPurchase {
  /** Purchase instant (ms). */
  at: number;
  flowers: number;
  card: number;
  delivery: number;
  holiday: boolean;
  staff: number;
  /** Reversal right after the purchase ("Ошибка в сумме" → re-entered with the right amount). */
  reversal: { reason: string; correctedFlowers: number | null } | null;
  /** Wants to pay with мёд if possible: share of the maximum (0 = no). */
  redeemShare: number;
  /** Uses an available discount gift on this order. */
  useDiscount: boolean;
  /** Hands out an available free-card gift without a purchase (card given to the client). */
  handOutCard: boolean;
}

export interface ClientPlan {
  i: number;
  segment: Segment;
  registeredAt: number;
  purchases: PlannedPurchase[];
}

/** Skewed bouquet price: most 100–600k, a tail of big orders up to 2.5M (сум, rounded to 5 000). */
function bouquet(rng: () => number, segment: Segment, holiday: boolean): number {
  let x = rng() < 0.86 ? 80_000 + 520_000 * rng() ** 1.6 : 600_000 + 1_900_000 * rng() ** 2;
  if (segment === 'loyal') x *= 1.25;
  if (holiday) x *= 1.2;
  return Math.min(2_500_000, Math.max(80_000, Math.round(x / 5_000) * 5_000));
}

const REASONS = ['Ошибка в сумме', 'Не тот клиент', 'Двойное начисление', 'Возврат букета'];

export function demoPlan(i: number, anchorMs: number): ClientPlan {
  const rng = rngFor(i, 2);
  const segment = weighted(rng, SEGMENTS);
  const daysAgo = (n: number) => anchorMs - n * DAY;

  // Purchase days (days before the anchor), newest last after sorting.
  const days: number[] = [];
  const span = (first: number, last: number, gapLo: number, gapHi: number, maxN: number) => {
    let d = first;
    while (d >= last && days.length < maxN) {
      days.push(d);
      d -= between(rng, gapLo, gapHi);
    }
    if (!days.includes(last) && days.length < maxN) days.push(last);
  };
  switch (segment) {
    case 'loyal':
      span(between(rng, 150, 178), between(rng, 0, 9), 18, 34, 7);
      break;
    case 'regular':
      span(between(rng, 70, 170), between(rng, 0, 32), 30, 65, 4);
      break;
    case 'one_time':
      days.push(between(rng, 0, 175));
      break;
    case 'sleeping':
      span(between(rng, 100, 175), between(rng, 56, 88), 24, 48, 3); // 60–90 days = «засыпает», 83+ with мёд = «сгорает»
      break;
    case 'lost':
      span(between(rng, 110, 178), between(rng, 96, 150), 20, 45, 3);
      break;
    case 'newbie':
      if (rng() < 0.6) days.push(between(rng, 0, 9));
      break;
  }

  // Holiday peaks: regulars come for 1 September, Teacher's day, 8 March…
  const first = days.length ? Math.max(...days) : 0;
  const last = days.length ? Math.min(...days) : 0;
  const pHoliday = { loyal: 0.4, regular: 0.22, sleeping: 0.18, lost: 0.12, one_time: 0, newbie: 0 }[segment];
  const holidayDays = new Set<number>();
  for (const h of holidaysBetween(daysAgo(DEMO_WINDOW_DAYS), anchorMs - DAY / 2)) {
    const d = Math.round((anchorMs - h) / DAY) + between(rng, 0, 2);
    if (d <= first && d >= last && rng() < pHoliday) holidayDays.add(d);
  }
  if (segment === 'one_time' && rng() < 0.3) {
    const hs = holidaysBetween(daysAgo(175), anchorMs - DAY);
    if (hs.length) {
      const d = Math.round((anchorMs - pick(rng, hs)) / DAY) + between(rng, 0, 1);
      days.length = 0;
      days.push(d);
      holidayDays.add(d);
    }
  }
  const allDays = [...new Set([...days, ...holidayDays])].sort((a, b) => b - a); // oldest first

  const purchases: PlannedPurchase[] = [];
  for (const d of allDays) {
    const key = localKey(daysAgo(d));
    let at = atLocal(key, between(rng, 9, 20), between(rng, 0, 59));
    if (at > anchorMs - 10 * 60_000) at = anchorMs - between(rng, 10, 240) * 60_000;
    const holiday = holidayDays.has(d);
    const delivery = rng() < 0.18 ? pick(rng, [30_000, 35_000, 40_000, 50_000]) : 0;
    const card = rng() < (holiday ? 0.3 : 0.12) ? pick(rng, [15_000, 20_000, 25_000]) : 0;
    const flowers = bouquet(rng, segment, holiday);
    // A few mistakes, never within the last 2 hours (the correction must happen before "now").
    const mistake = purchases.length > 0 && at < anchorMs - 2 * 3_600_000 && rng() < 0.03;
    const reason = mistake ? pick(rng, REASONS) : null;
    purchases.push({
      at,
      flowers,
      card,
      delivery,
      holiday,
      staff: weighted(rng, DEMO_STAFF.map((s) => [s.j, s.weight] as const)),
      // "Ошибка в сумме": the florist re-enters the purchase with the right amount; other reasons just cancel it.
      reversal: reason
        ? { reason, correctedFlowers: reason === 'Ошибка в сумме' ? Math.max(80_000, Math.round((flowers * (0.7 + rng() * 0.25)) / 5_000) * 5_000) : null }
        : null,
      redeemShare: rng() < (segment === 'loyal' ? 0.45 : 0.25) ? (rng() < 0.7 ? 1 : 0.5) : 0,
      useDiscount: rng() < 0.65,
      handOutCard: rng() < 0.35,
    });
  }

  // Registration: at the counter right before the first purchase, or a few days earlier via the bot.
  let registeredAt: number;
  if (purchases.length) {
    registeredAt = rng() < 0.7 ? purchases[0]!.at - between(rng, 2, 25) * 60_000 : purchases[0]!.at - between(rng, 1, 14) * DAY;
  } else {
    registeredAt = atLocal(localKey(daysAgo(between(rng, 0, 9))), between(rng, 9, 21), between(rng, 0, 59));
    if (registeredAt > anchorMs - 5 * 60_000) registeredAt = anchorMs - between(rng, 5, 300) * 60_000;
  }
  return { i, segment, registeredAt, purchases };
}
