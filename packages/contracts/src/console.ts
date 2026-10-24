/**
 * Owner web console ("Кабинет владельца", apps/miniapp/console.html) — HTTP contract + the
 * pure helpers both sides need for the client base import (phone normalization, header
 * auto-detection, row validation). No dependencies: runs in the browser and in the Worker.
 *
 * Auth: the console sends `Authorization: Bearer <session>` (POST /api/web/session exchanges a
 * one-time link token for it). In TEST_MODE it may use X-Test-User + X-Test-Key instead.
 * A web session is accepted only on /api/owner/* and /api/web/*.
 *
 * Dates in query strings are Tashkent calendar days 'YYYY-MM-DD' (inclusive ranges).
 */

/* ------------------------------------------------------------------ login */

/** POST /api/owner/web-link (owner, from the Mini App) */
export interface WebLinkDTO { url: string; expiresAt: string; sentToChat: boolean }
/** POST /api/web/session { token } (no auth) */
export interface WebSessionRequest { token: string }
export interface WebSessionDTO { session: string; expiresAt: string; name: string }
/** GET /api/web/me */
export interface WebMeDTO { telegramId: number; name: string; via: 'webSession' | 'testHeader' | 'initData'; testMode: boolean; now: string; sessionExpiresAt: string | null }
/** POST /api/web/logout → { ok: true } (revokes every browser session of this owner) */

/* ------------------------------------------------------------------ overview */

export type Granularity = 'day' | 'week' | 'month';

export interface ConsoleMetrics {
  revenue: number;          // sum of active (not reversed) purchases with the card
  purchases: number;
  avgCheck: number;
  activeClients: number;    // distinct buyers in the period
  newClients: number;       // registered in the period (imported clients excluded)
  repeatPurchases: number;  // purchases by clients who had bought before
  repeatShare: number;      // repeatPurchases / purchases, 0..1
  honeyAccrued: number;
  honeyRedeemed: number;
  honeyExpired: number;
  giftsUnlocked: number;
  giftsUsed: number;
}

/** GET /api/owner/console/overview?from&to */
export interface ConsoleOverviewDTO {
  from: string; to: string;               // the period (inclusive)
  prevFrom: string; prevTo: string;       // the previous period of the same length
  granularity: Granularity;
  current: ConsoleMetrics;
  previous: ConsoleMetrics;
  series: Array<{ bucket: string; purchases: number; revenue: number; buyers: number }>; // bucket = first day of day/week/month
}

/* ------------------------------------------------------------------ clients */

export type ClientActivity = 'active' | 'sleeping' | 'gone' | 'never';
export type ConsoleClientSort = 'name' | 'registered' | 'count' | 'total' | 'avg' | 'last' | 'balance' | 'level';

/**
 * GET /api/owner/console/clients?from&to&level&minCount&maxCount&minTotal&maxTotal&minAvg&maxAvg
 *   &activity=active|sleeping|gone|never&bmonth=1..12&regFrom&regTo&gift=1&linked=tg|pending&q
 *   &sort=<ConsoleClientSort>&dir=asc|desc&cursor&limit (<= 1000)
 * count/total/avg are counted over purchases in [from, to] (all time without a period);
 * activity uses the last purchase ever: active < 30 days, sleeping 30–60, gone > 60, never.
 */
export interface ConsoleClientRow {
  id: string;
  name: string;
  phone: string | null;     // full phone: the console is the owner's own tool
  code: string;
  birthday: string | null;
  registeredAt: string;
  linked: boolean;          // false = imported from the old base, has not opened the bot yet
  level: string;            // tier id
  levelName: string;
  purchases: number;
  total: number;
  avg: number;
  lastPurchaseAt: string | null;
  balance: number;
  hasGift: boolean;
}
export interface ConsoleClientsPageDTO {
  rows: ConsoleClientRow[];
  matched: number;          // clients matching the filters (all pages)
  /**
   * Their purchase sum in the period. null for the all-time view unless it is sorted / filtered
   * by sum or average: that view reads only the client_stats summaries, not every purchase.
   */
  matchedTotal: number | null;
  matchedPurchases: number;
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ operations */

export type ConsoleOpKind = 'purchase' | 'reversal' | 'redeem' | 'adjust' | 'gift' | 'welcome' | 'expire';
export const CONSOLE_OP_KINDS: ConsoleOpKind[] = ['purchase', 'reversal', 'redeem', 'adjust', 'gift', 'welcome', 'expire'];

/**
 * GET /api/owner/console/operations?from&to&kinds=purchase,redeem&staff=<staff id>&minAmount&maxAmount&cursor&limit&totals=1
 * minAmount/maxAmount filter purchases and reversals by order amount (other kinds are hidden then).
 */
export interface ConsoleOperationRow {
  id: string;
  at: string;
  kind: ConsoleOpKind;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  staffId: string | null;
  staffName: string | null;
  amount: number | null;    // order amount (purchase / reversal)
  points: number;           // signed change of the honey balance
  redeemed: number;         // honey paid inside a purchase
  status: 'active' | 'reversed' | null;
  reason: string | null;
}
export interface ConsoleOpsTotals {
  count: number;
  byKind: Record<ConsoleOpKind, { count: number; amount: number; points: number }>;
}
export interface ConsoleOperationsPageDTO { rows: ConsoleOperationRow[]; nextCursor: string | null; totals: ConsoleOpsTotals | null }

/* ------------------------------------------------------------------ cohorts */

/** GET /api/owner/console/cohorts?months=12 — clients by month of their first purchase. */
export interface ConsoleCohortDTO {
  month: string;            // 'YYYY-MM'
  clients: number;
  // returned for a 2nd purchase (on a later day) within N days, among clients whose N-day window is complete
  r30: number; e30: number;
  r60: number; e60: number;
  r90: number; e90: number;
}
export interface ConsoleCohortsDTO { cohorts: ConsoleCohortDTO[] }

/* ------------------------------------------------------------------ import */

export interface ImportOptions {
  /** Credit the balance column as starting honey (manual_adjust entry, normal expiry). */
  creditBalance: boolean;
  /** Set the starting level from the past purchase sum (or count, if levels go by count). */
  levelFromTotal: boolean;
  /** Place the bee on the card by the past purchase count (no gifts for passed cells). Default off. */
  cellsFromCount: boolean;
}

export interface ImportRowInput {
  line: number;             // row number in the file (for messages)
  phone: string;
  name?: string | null;
  birthday?: string | null; // YYYY-MM-DD
  balance?: number | null;
  total?: number | null;
  count?: number | null;
  lastPurchase?: string | null; // YYYY-MM-DD
}

/** POST /api/owner/import — at most 100 rows per request; send the same batchId for every chunk of one file. */
export interface ImportRequest {
  batchId: string;
  fileName?: string | null;
  dryRun: boolean;
  options: ImportOptions;
  rows: ImportRowInput[];
  /** Rows the console already rejected (bad phone, duplicate in the file); sent once, added to the batch's skipped count. */
  skipped?: number;
}

/**
 * create  — new client (no Telegram yet; claimed when the person shares this phone with the bot)
 * update  — the phone is already in the base: only name / birthday are filled in, no honey
 * replay  — already created by this same batch (a repeated chunk): nothing happens
 * invalid / duplicate — skipped
 */
export type ImportRowStatus = 'create' | 'update' | 'replay' | 'invalid' | 'duplicate';
export interface ImportRowResult { line: number; phone: string | null; status: ImportRowStatus; message: string | null; honey: number; linked: boolean | null }
export interface ImportResultDTO {
  batchId: string;
  dryRun: boolean;
  results: ImportRowResult[];
  summary: { create: number; update: number; replay: number; skipped: number; honey: number };
}

/** GET /api/owner/import/batches ; POST /api/owner/import/:id/undo → ImportBatchDTO */
export interface ImportBatchDTO {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  fileName: string | null;
  options: ImportOptions;
  rowsReceived: number;
  created: number;
  updated: number;
  skipped: number;
  honey: number;
  status: 'active' | 'undone';
  undoneAt: string | null;
  claimed: number;          // created clients who have already joined via Telegram
}

/* ------------------------------------------------------------------ import helpers (pure) */

/**
 * Uzbek mobile/landline number → "+998XXXXXXXXX", or null.
 * Accepts "+998 (90) 123-45-67", "998901234567", "901234567", "90 123 45 67", "8 90 123 45 67",
 * "00998…", Excel numbers (998901234567). Rejects other countries, several numbers in one
 * cell and numbers mangled by Excel into "9.98901E+11".
 */
export function normalizeUzPhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    s = String(raw);
  } else s = String(raw).trim();
  if (!s || /\d[.,]?\d*e[+-]?\d+\s*$/i.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9) d = `998${d}`;
  else if (d.length === 10 && d.startsWith('8')) d = `998${d.slice(1)}`;
  return d.length === 12 && d.startsWith('998') ? `+${d}` : null;
}

export type ImportField = 'phone' | 'name' | 'birthday' | 'balance' | 'total' | 'count' | 'lastPurchase';

export const IMPORT_FIELDS: Array<{ field: ImportField; label: string; required?: boolean }> = [
  { field: 'phone', label: 'Телефон', required: true },
  { field: 'name', label: 'Имя' },
  { field: 'birthday', label: 'День рождения' },
  { field: 'balance', label: 'Баланс / бонусы' },
  { field: 'total', label: 'Сумма покупок' },
  { field: 'count', label: 'Кол-во покупок' },
  { field: 'lastPurchase', label: 'Последняя покупка' },
];

/** Checked in this order, so a specific header ("дата последней покупки") wins over a generic one. */
const HEADER_RULES: Array<[ImportField, RegExp]> = [
  ['lastPurchase', /послед|last\s*(purchase|order|visit|buy|sale)|oxirgi/],
  ['birthday', /рожд|д\.?\s*р\.?$|^др$|birth|b-?day|dob|tug['‘’]?il/],
  ['count', /кол-?во|количеств|число\s*(покуп|заказ)|кол\.?\s*покуп|count|orders?$|визит|чек(ов|и)$|soni/],
  ['balance', /баланс|бонус|балл|м[её]д|кешб[эе]к|cashback|bonus|balance|points?|ball/],
  ['total', /сумм|оборот|выручк|потрач|total|spent|amount|revenue|summa/],
  ['phone', /тел|phone|моб|mobile|whats\s*app|номер(?!\s*карт)|контакт|telefon|raqam/],
  ['name', /имя|фио|ф\.и\.о|фамил|клиент|покупател|name|customer|client|ism|mijoz/],
];

export function normalizeHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Column index for each field (null = not found). Every column is used at most once. */
export function detectImportColumns(headers: unknown[]): Record<ImportField, number | null> {
  const out: Record<ImportField, number | null> = { phone: null, name: null, birthday: null, balance: null, total: null, count: null, lastPurchase: null };
  headers.forEach((raw, i) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    for (const [field, re] of HEADER_RULES) {
      if (re.test(h)) {
        if (out[field] === null) out[field] = i;
        return; // the first matching rule decides the column's meaning
      }
    }
  });
  return out;
}

/** Index of the header row among the first rows: the first one where a phone column is recognised. */
export function detectHeaderRow(table: unknown[][], maxScan = 10): number {
  for (let r = 0; r < Math.min(table.length, maxScan); r++) {
    if (detectImportColumns(table[r] ?? []).phone !== null) return r;
  }
  return 0;
}

/** Integer amount from "1 200 000", "1 200 000,00 сум", "1,200,000", 1200000.4; undefined = empty, null = unreadable. */
export function parseImportNumber(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = String(v).trim().toLowerCase();
  if (!s || s === '-' || s === '—') return undefined;
  s = s.replace(/(сум|sum|so['‘’]?m|uzs)\.?$/i, '').replace(/[\s  ']/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s));
  return Number.isSafeInteger(n) ? n : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/**
 * Calendar date → 'YYYY-MM-DD'. Accepts Date objects, Excel serial numbers (1900 date system),
 * "2026-03-08", "08.03.2026", "8/3/2026", "08-03-26" (two-digit years: <= current+0 → 20yy, else 19yy),
 * with an optional time after the date. undefined = empty, null = unreadable.
 */
export function parseImportDate(v: unknown, now: Date = new Date()): string | null | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1 || v > 80_000) return null;
    const d = new Date(Math.round((Math.floor(v) - 25569) * 86_400_000));
    return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  if (!s || s === '-' || s === '—') return undefined;
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return validYmd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2}|\d{4})(?:[ T,].*)?$/.exec(s);
  if (m) {
    let y = +m[3]!;
    if (m[3]!.length === 2) y += y <= now.getUTCFullYear() % 100 ? 2000 : 1900;
    return validYmd(y, +m[2]!, +m[1]!);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseImportDate(Number(s), now);
  return null;
}

export interface ImportPreviewRow extends ImportRowInput {
  phoneRaw: string;
  phone: string;            // '' when invalid
  errors: string[];         // the row is skipped
  warnings: string[];       // a field is ignored, the row is imported
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

/**
 * Turn a parsed sheet into import rows with per-row validation. `headerRow` is skipped;
 * `line` is the 1-based row number in the file. Fully empty rows are dropped.
 */
export function buildImportRows(
  table: unknown[][],
  headerRow: number,
  map: Record<ImportField, number | null>,
  now: Date = new Date(),
): ImportPreviewRow[] {
  const out: ImportPreviewRow[] = [];
  const seen = new Map<string, number>();
  const today = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const get = (row: unknown[], f: ImportField) => (map[f] === null ? undefined : row[map[f]!]);
  for (let r = headerRow + 1; r < table.length; r++) {
    const row = table[r] ?? [];
    if (!row.some((c) => cellText(c) !== '')) continue;
    const line = r + 1;
    const errors: string[] = [];
    const warnings: string[] = [];
    const phoneRaw = cellText(get(row, 'phone'));
    const phone = normalizeUzPhone(get(row, 'phone') ?? null) ?? '';
    if (!phoneRaw) errors.push('Нет телефона');
    else if (!phone) errors.push(`Не похоже на узбекский номер: «${phoneRaw}»`);
    else if (seen.has(phone)) errors.push(`Повтор номера (уже в строке ${seen.get(phone)})`);
    else seen.set(phone, line);

    const nameRaw = cellText(get(row, 'name')).replace(/\s+/g, ' ');
    const name = nameRaw ? nameRaw.slice(0, 60) : null;
    if (nameRaw.length > 60) warnings.push('Имя обрезано до 60 символов');

    let birthday: string | null = null;
    const b = parseImportDate(get(row, 'birthday'), now);
    if (b === null) warnings.push(`Дата рождения не распознана: «${cellText(get(row, 'birthday'))}»`);
    else if (b !== undefined) {
      if (b > today) warnings.push(`Дата рождения в будущем: ${b}`);
      else birthday = b;
    }

    const num = (f: ImportField, label: string, max: number): number | null => {
      const v = parseImportNumber(get(row, f));
      if (v === undefined) return null;
      if (v === null || v < 0 || v > max) {
        warnings.push(`${label}: «${cellText(get(row, f))}» не учтено`);
        return null;
      }
      return v;
    };
    const balance = num('balance', 'Баланс', 1_000_000_000);
    const total = num('total', 'Сумма покупок', 100_000_000_000);
    const count = num('count', 'Кол-во покупок', 100_000);

    let lastPurchase: string | null = null;
    const lp = parseImportDate(get(row, 'lastPurchase'), now);
    if (lp === null) warnings.push(`Дата последней покупки не распознана: «${cellText(get(row, 'lastPurchase'))}»`);
    else if (lp !== undefined) lastPurchase = lp;

    out.push({ line, phoneRaw, phone, name, birthday, balance, total, count, lastPurchase, errors, warnings });
  }
  return out;
}
