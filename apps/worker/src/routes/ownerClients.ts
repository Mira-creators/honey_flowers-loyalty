import type {
  AdjustResultDTO,
  ClientListDTO,
  ClientRowDTO,
  ClientSort,
  ClientStatus,
  ExportLinkDTO,
  Lang,
  NoteDTO,
  OperationDTO,
  OwnerClientDTO,
} from '@honey/contracts';
import { dayNumberFromKey, keyFromDayNumber, localDateKey, manualAdjust, type ClientState, type LoyaltyRules } from '@honey/core';
import { maskPhone, nationalPart, phoneDigits, type ClientProfile } from '@honey/service';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { actingStaff, type Vars } from '../auth.js';
import type { AppContext } from '../context.js';
import { CLIENT_SORTS, type ClientListQuery, type ClientListRow } from '../db/d1Repository.js';
import { DAY_MS } from '../lib/clock.js';
import { computeClientStats, sameStats } from '../lib/clientStats.js';
import { csvLine, csvResponse, tashkentMinute } from '../lib/csv.js';
import { actorIds, clientSummary, history, tashkentDayStartIso, viewState } from '../lib/dto.js';
import { HttpError } from '../lib/errors.js';
import { translateWarning } from '../lib/summary.js';

/**
 * Owner's client base (mounted under /api/owner, so the owner-only guard of owner.ts applies):
 *   GET  /clients                 paginated list from client_stats (O(page) rows)
 *   GET  /clients/:id             full card + staff-only fields
 *   POST /clients/:id/adjust      manual points adjustment (core manualAdjust)
 *   PUT  /clients/:id/note        free-text note
 *   POST /export/link             one-time 10-minute link to a CSV file
 *   GET  /export/clients.csv, /export/operations.csv   streamed CSV (also via ?token=, see app.ts)
 */
export const ownerClientRoutes = new Hono<{ Variables: Vars }>();

const TZ = 'Asia/Tashkent';
export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;
/** CSV export: rows per query and the hard cap of one operations file. */
export const EXPORT_CHUNK = 1500; // 50k rows ≈ 34 D1 queries, under the 50-per-request limit
export const EXPORT_MAX_ROWS = 50_000;
export const EXPORT_LINK_TTL_MS = 10 * 60_000;

// ------------------------------------------------------------ list

const STATUSES = ['active', 'sleeping', 'lost', 'expiring', 'birthday'] as const satisfies readonly ClientStatus[];
const SORT_IDS = ['last_purchase_desc', 'spent_desc', 'balance_desc', 'name', 'created_desc'] as const satisfies readonly ClientSort[];

interface Cursor { s: ClientSort; v: string | number; i: string }

function encodeCursor(c: Cursor): string {
  const bin = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(c)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string, sort: ClientSort): Cursor {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    const c = JSON.parse(json) as Partial<Cursor>;
    const numeric = CLIENT_SORTS[sort].numeric;
    if (c.s === sort && typeof c.i === 'string' && (numeric ? typeof c.v === 'number' : typeof c.v === 'string')) return c as Cursor;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'validation', 'Неверный курсор страницы: начните список сначала');
}

function cursorValue(sort: ClientSort, r: ClientListRow): string | number {
  switch (sort) {
    case 'last_purchase_desc':
      return r.lastPurchaseAt;
    case 'spent_desc':
      return r.spent;
    case 'balance_desc':
      return r.balance;
    case 'name':
      return r.name ?? '';
    case 'created_desc':
      return r.createdAt;
  }
}

/** Free text → code / phone digits / name substrings (with Cyrillic case variants: SQLite instr is case-sensitive). */
export function parseClientQuery(q: string): Pick<ClientListQuery, 'code' | 'phone' | 'names'> {
  const s = q.trim();
  if (!s) return {};
  const compact = s.replace(/^HF:/i, '').replace(/[\s-]/g, '');
  if (/^HF\d{4,6}$/i.test(compact)) return { code: compact.toUpperCase() };
  if (/^[\d\s()+-]+$/.test(s)) {
    const digits = phoneDigits(s);
    if (digits.length >= 4) return { phone: nationalPart(digits) };
    throw new HttpError(400, 'validation', 'Для поиска по телефону введите минимум 4 цифры');
  }
  const lower = s.toLocaleLowerCase('ru');
  const cap = lower.charAt(0).toLocaleUpperCase('ru') + lower.slice(1);
  return { names: [...new Set([s, lower, cap, s.toLocaleUpperCase('ru')])] };
}

function levelName(rules: LoyaltyRules, id: string): { id: string; name: string } {
  const tier = rules.levels.tiers.find((t) => t.id === id) ?? rules.levels.tiers[0]!;
  return { id: tier.id, name: tier.title };
}

export function rowDTO(rules: LoyaltyRules, r: ClientListRow): ClientRowDTO {
  const lv = levelName(rules, r.levelId);
  return {
    id: r.id,
    name: r.name ?? '',
    phoneMasked: maskPhone(r.phone),
    code: r.code,
    levelId: lv.id,
    levelName: lv.name,
    balance: r.balance,
    spent: r.spent,
    purchases: r.purchasesCount,
    lastPurchaseAt: r.lastPurchaseAt || null,
    expiresOn: r.expiresOn || null,
    giftsAvailable: r.giftsAvailable,
    registeredAt: r.createdAt,
  };
}

const listSchema = z.object({
  q: z.string().max(60).optional(),
  level: z.string().max(40).optional(),
  status: z.enum(STATUSES).optional(),
  sort: z.enum(SORT_IDS).default('last_purchase_desc'),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
});

/** Status windows relative to the server "now" (test clock included). */
export function statusFilter(status: ClientStatus, now: Date): Partial<ClientListQuery> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const today = dayNumberFromKey(localDateKey(now, TZ));
  switch (status) {
    case 'active':
      return { lastFrom: ago(90) };
    case 'sleeping':
      return { lastFrom: ago(90), lastBefore: ago(60) };
    case 'lost':
      return { lastBefore: ago(90) };
    case 'expiring':
      return { expiresFrom: keyFromDayNumber(today), expiresTo: keyFromDayNumber(today + 6) };
    case 'birthday':
      return { birthdays: Array.from({ length: 7 }, (_, i) => keyFromDayNumber(today + i).slice(5)) };
  }
}

ownerClientRoutes.get('/clients', async (c) => {
  const app = c.get('app');
  const p = listSchema.parse(Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== '')));
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const after = p.cursor ? decodeCursor(p.cursor, p.sort) : null;
  const rows = await app.repo.listClients({
    ...parseClientQuery(p.q ?? ''),
    ...(p.level ? { levelId: p.level } : {}),
    ...(p.status ? statusFilter(p.status, now) : {}),
    sort: p.sort,
    after: after ? { value: after.v, id: after.i } : null,
    limit: p.limit + 1,
  });
  const more = rows.length > p.limit;
  const page = more ? rows.slice(0, p.limit) : rows;
  const last = page[page.length - 1];
  const body: ClientListDTO = {
    items: page.map((r) => rowDTO(rules, r)),
    nextCursor: more && last ? encodeCursor({ s: p.sort, v: cursorValue(p.sort, last), i: last.id }) : null,
  };
  return c.json(body);
});

// ------------------------------------------------------------ card

async function ownerClient(app: AppContext, rules: LoyaltyRules, client: ClientProfile, note: string | null, state: ClientState, now: Date): Promise<OwnerClientDTO> {
  const names = await app.repo.actorNames(actorIds(state));
  const summary = clientSummary(rules, client, state, now, names);
  return {
    ...summary,
    // The owner sees the whole history, not only the last 50 items.
    history: history(viewState(rules, state, now), names, 10_000),
    phone: client.phone,
    telegramId: client.telegramId,
    registeredAt: client.createdAt.toISOString(),
    language: (client.language === 'uz' ? 'uz' : 'ru') as Lang,
    birthday: client.birthday,
    note,
  };
}

ownerClientRoutes.get('/clients/:id', async (c) => {
  const app = c.get('app');
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const card = await app.repo.loadClientCard(c.req.param('id'));
  if (!card) throw new HttpError(404, 'not_found', 'Клиент не найден');
  // Self-healing summary: normally identical; rewritten only if it drifted (and nobody wrote meanwhile).
  const fresh = computeClientStats(rules, card.versioned.state, now);
  if (!card.stats || !sameStats(card.stats, fresh)) await app.repo.healStats(card.client.id, fresh, card.versioned.version, now);
  return c.json(await ownerClient(app, rules, card.client, card.note, card.versioned.state, now));
});

// ------------------------------------------------------------ manual adjustment

const adjustSchema = z.object({
  points: z.number().int().refine((n) => n !== 0, 'укажите ненулевое количество мёда'),
  reason: z.string().trim().min(3, 'укажите причину (минимум 3 символа)').max(200),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

ownerClientRoutes.post('/clients/:id/adjust', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const id = c.req.param('id');
  const body = adjustSchema.parse(await c.req.json().catch(() => ({})));
  const { rules } = await app.repo.getActiveRules(app.now());
  if (Math.abs(body.points) > rules.maxPurchaseAmount) {
    throw new HttpError(400, 'validation', `Корректировка не может превышать ${rules.maxPurchaseAmount.toLocaleString('ru-RU')} мёда`);
  }
  const found = await app.repo.findClientWithNote(id);
  if (!found) throw new HttpError(404, 'not_found', 'Клиент не найден');
  const staff = actingStaff(caller);
  // Ledger idempotency keys are global: scope the caller's key to this client.
  const key = `adjust:${id}:${body.idempotencyKey ?? crypto.randomUUID()}`;
  const res = await app.service.execute(id, ({ rules: r, state, now }) =>
    manualAdjust(r, state, { idempotencyKey: key, staffId: staff.id, amount: body.points, reason: body.reason }, now),
  );
  const out: AdjustResultDTO = {
    client: await ownerClient(app, res.rules, found.client, found.note, res.state, res.now),
    replayed: res.outcome.replayed,
    warnings: res.outcome.warnings.map(translateWarning),
  };
  return c.json(out);
});

// ------------------------------------------------------------ note

ownerClientRoutes.put('/clients/:id/note', async (c) => {
  const app = c.get('app');
  const { note } = z.object({ note: z.string().max(500, 'заметка длиннее 500 символов') }).parse(await c.req.json().catch(() => ({})));
  const value = note.trim() || null;
  if (!(await app.repo.setClientNote(c.req.param('id'), value))) throw new HttpError(404, 'not_found', 'Клиент не найден');
  return c.json({ note: value } satisfies NoteDTO);
});

// ------------------------------------------------------------ CSV export

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Operations range in Tashkent days (inclusive); default: the last 90 days. */
export function exportRange(now: Date, from?: string | null, to?: string | null): { from: string; to: string; fromIso: string; toIso: string } {
  const today = localDateKey(now, TZ);
  const t = to || today;
  const f = from || keyFromDayNumber(dayNumberFromKey(t) - 89);
  if (!DAY_RE.test(f) || !DAY_RE.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) {
    throw new HttpError(400, 'validation', 'Даты периода — в формате ГГГГ-ММ-ДД');
  }
  if (f > t) throw new HttpError(400, 'validation', 'Начало периода позже конца');
  return { from: f, to: t, fromIso: tashkentDayStartIso(f), toIso: tashkentDayStartIso(keyFromDayNumber(dayNumberFromKey(t) + 1)) };
}

const KIND_LABEL: Record<OperationDTO['kind'], string> = {
  purchase: 'Покупка',
  reversal: 'Отмена покупки',
  welcome: 'Приветственный бонус',
  redeem: 'Оплата мёдом',
  expire: 'Сгорание мёда',
  manual: 'Корректировка',
  gift_used: 'Подарок выдан',
};

async function* clientLines(app: AppContext, rules: LoyaltyRules): AsyncGenerator<string> {
  yield csvLine(['Код', 'Имя', 'Телефон', 'Уровень', 'Мёд', 'Мёд действует до', 'Сумма покупок', 'Покупок', 'Последняя покупка', 'Подарков доступно', 'Регистрация', 'Язык', 'Заметка']);
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const rows = await app.repo.exportClientsChunk(after, EXPORT_CHUNK);
    for (const r of rows) {
      yield csvLine([
        r.code, r.name ?? '', r.phone ?? '', levelName(rules, r.levelId).name, r.balance, r.expiresOn, r.spent, r.purchasesCount,
        tashkentMinute(r.lastPurchaseAt), r.giftsAvailable, tashkentMinute(r.createdAt), r.language, r.note ?? '',
      ]);
    }
    if (rows.length < EXPORT_CHUNK) return;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
  }
}

async function* operationLines(app: AppContext, fromIso: string, toIso: string): AsyncGenerator<string> {
  yield csvLine(['Дата', 'Операция', 'Клиент', 'Код', 'Телефон', 'Сумма покупки', 'Мёд', 'Статус', 'Сотрудник', 'Причина / комментарий']);
  let at = fromIso;
  let id = '';
  for (;;) {
    const rows = await app.repo.operationsChunk(at, id, toIso, EXPORT_CHUNK);
    for (const r of rows) {
      const kind = String(r.kind) as OperationDTO['kind'];
      yield csvLine([
        tashkentMinute(String(r.at)), KIND_LABEL[kind] ?? kind, r.client_name === null ? '' : String(r.client_name), String(r.client_code),
        r.client_phone === null ? '' : String(r.client_phone), r.purchase_amount === null ? '' : Number(r.purchase_amount), Number(r.points ?? 0),
        r.status === 'reversed' ? 'отменена' : r.status === 'active' ? 'активна' : '', r.staff_name === null ? '' : String(r.staff_name),
        r.reason === null ? '' : String(r.reason),
      ]);
    }
    if (rows.length < EXPORT_CHUNK) return;
    const last = rows[rows.length - 1]!;
    at = String(last.at);
    id = String(last.id);
  }
}

/** Builds the CSV response for a kind; validation errors are thrown BEFORE streaming starts. */
export async function exportResponse(app: AppContext, kind: 'clients' | 'operations', params: { from?: string | null; to?: string | null }): Promise<Response> {
  const now = app.now();
  if (kind === 'clients') {
    const { rules } = await app.repo.getActiveRules(now);
    return csvResponse(`honey-clients-${localDateKey(now, TZ)}.csv`, clientLines(app, rules));
  }
  const r = exportRange(now, params.from, params.to);
  const n = await app.repo.countOperations(r.fromIso, r.toIso);
  if (n > EXPORT_MAX_ROWS) {
    throw new HttpError(400, 'validation', `За этот период ${n.toLocaleString('ru-RU')} операций — больше ${EXPORT_MAX_ROWS.toLocaleString('ru-RU')}. Выберите период короче.`);
  }
  return csvResponse(`honey-operations-${r.from}_${r.to}.csv`, operationLines(app, r.fromIso, r.toIso));
}

ownerClientRoutes.get('/export/clients.csv', async (c) => exportResponse(c.get('app'), 'clients', {}));
ownerClientRoutes.get('/export/operations.csv', async (c) =>
  exportResponse(c.get('app'), 'operations', { from: c.req.query('from') ?? null, to: c.req.query('to') ?? null }),
);

const linkSchema = z.object({
  kind: z.enum(['clients', 'operations']),
  from: z.string().optional(),
  to: z.string().optional(),
});

ownerClientRoutes.post('/export/link', async (c) => {
  const app = c.get('app');
  const body = linkSchema.parse(await c.req.json().catch(() => ({})));
  const now = app.now();
  const params: Record<string, string> = {};
  if (body.kind === 'operations') {
    const r = exportRange(now, body.from, body.to);
    params.from = r.from;
    params.to = r.to;
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_MS);
  await app.repo.createExportLink(token, body.kind, params, actingStaff(c.get('caller')).id, now, expiresAt);
  const origin = (await app.origin()) ?? new URL(c.req.url).origin;
  const out: ExportLinkDTO = { url: `${origin}/api/owner/export/${body.kind}.csv?token=${token}`, expiresAt: expiresAt.toISOString() };
  return c.json(out, 201);
});

/**
 * GET /api/owner/export/<kind>.csv?token=… without the auth header (opened in a normal browser).
 * Mounted in app.ts BEFORE the authenticated /api router. The token is consumed atomically.
 */
export async function exportByToken(c: Context, app: AppContext, file: string, token: string): Promise<Response> {
  const link = await app.repo.consumeExportLink(token, app.now());
  const kind = file === 'clients.csv' ? 'clients' : file === 'operations.csv' ? 'operations' : null;
  if (!link || !kind || link.kind !== kind) {
    return c.text('Ссылка недействительна: она одноразовая и действует 10 минут. Создайте новую в приложении.', 410);
  }
  return exportResponse(app, kind, { from: link.params.from ?? null, to: link.params.to ?? null });
}
