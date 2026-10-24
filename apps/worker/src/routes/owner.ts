import type { EditableRulesDTO, OwnerStatsDTO, StaffDTO } from '@honey/contracts';
import { localDateKey } from '@honey/core';
import { normalizePhone, type StaffMember } from '@honey/service';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, type Vars } from '../auth.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import { applyEditable, toEditable } from '../lib/rulesEditor.js';
import { operationsFor } from '../lib/summary.js';
import { addDays, DayTable, daysFromStmt, mondayOf } from '../lib/statsRead.js';
import { ownerClientRoutes } from './ownerClients.js';

export const ownerRoutes = new Hono<{ Variables: Vars }>();

ownerRoutes.use('*', async (c, next) => {
  requireRole(c, ['owner']);
  await next();
});

// ------------------------------------------------------------ stats

/**
 * GET /api/owner/stats — from the daily aggregates (stats_daily, migration 0007): the '*' row and
 * the last 90 Tashkent days, ONE query (~100 rows read whatever the number of purchases).
 * "7 days" / "90 days" are calendar days including today; repeatRate90d = clients with ≥ 2 active
 * purchases in those 90 days / clients with ≥ 1 (summed from last_buyers / prev_buyers).
 */
ownerRoutes.get('/stats', async (c) => {
  const app = c.get('app');
  const now = app.now();
  const today = localDateKey(now, 'Asia/Tashkent');
  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(thisWeek, -7 * (7 - i)));
  const from90 = addDays(today, -89);
  const days = new DayTable((await daysFromStmt(app.repo.db, weeks[0]! < from90 ? weeks[0]! : from90, true).all<Record<string, unknown>>()).results);
  const t = days.total;
  // Windows ending today: clients whose last (second-to-last) purchase is in the window.
  const live = !days.activityAfter(today);
  const buyers = live ? days.sum('last_buyers', from90, '9999-12-31') : 0;
  const repeaters = live ? days.sum('prev_buyers', from90, '9999-12-31') : 0;
  const body: OwnerStatsDTO = {
    clients: t.new_clients + t.imported_clients,
    clientsNew7d: days.sum('new_clients', addDays(today, -6), today),
    purchases: t.purchases,
    purchases7d: days.sum('purchases', addDays(today, -6), today),
    revenueWithCard: t.revenue,
    repeatRate90d: buyers ? repeaters / buyers : 0,
    points: {
      accrued: t.honey_accrued,
      redeemed: t.honey_redeemed,
      expired: t.honey_expired,
      outstanding: t.honey_accrued - t.honey_redeemed - t.honey_expired + t.honey_imported,
    },
    giftsUnlocked: t.gifts_unlocked,
    giftsUsed: t.gifts_used,
    perWeek: weeks.map((w) => ({ weekStart: w, purchases: days.sum('purchases', w, addDays(w, 6)) })),
  };
  return c.json(body);
});

// ------------------------------------------------------------ rules

ownerRoutes.get('/rules', async (c) => {
  const { rules } = await c.get('app').repo.getActiveRules();
  return c.json(toEditable(rules) satisfies EditableRulesDTO);
});

/** PUT /api/owner/rules — validates and stores a NEW rules version (old purchases keep theirs). */
ownerRoutes.put('/rules', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const { rules: current } = await app.repo.getActiveRules();
  const next = applyEditable(current, await c.req.json());
  await app.repo.createRulesVersion(next, caller.staff?.id ?? `tg:${caller.telegramId}`, app.now());
  return c.json(toEditable(next) satisfies EditableRulesDTO);
});

// ------------------------------------------------------------ staff

function staffDTO(s: StaffMember): StaffDTO {
  return { id: s.id, telegramId: s.telegramId, name: s.name, role: s.role, active: s.active };
}

ownerRoutes.get('/staff', async (c) => {
  return c.json((await c.get('app').repo.listStaff()).map(staffDTO));
});

const addStaffSchema = z.object({
  phoneOrTelegramId: z.union([z.string().trim().min(1), z.number().int().positive()]),
  role: z.enum(['florist', 'manager', 'owner']),
  name: z.string().trim().max(60).optional(),
});

/**
 * Phone or Telegram id? "id:123456789" / "tg:123456789" is always a Telegram id. A phone
 * is "+…", "998XXXXXXXXX" or contains spaces / dashes / parentheses; any other bare
 * number is a Telegram id — except a bare 9-digit number, which is ambiguous
 * (national phone "901234567" vs a 9-digit Telegram id) and is refused.
 */
export function classifyPhoneOrId(s: string): { kind: 'phone' | 'id' | 'ambiguous'; value: string } {
  const m = /^(?:id|tg):\s*(\d+)$/i.exec(s);
  if (m) return { kind: 'id', value: m[1]! };
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') || /[\s()-]/.test(s) || /^998\d{9}$/.test(digits)) return { kind: 'phone', value: s };
  if (/^\d{9}$/.test(s)) return { kind: 'ambiguous', value: s };
  return { kind: 'id', value: s };
}

export const AMBIGUOUS_MSG = 'Непонятно, телефон это или Telegram ID: телефон укажите с кодом страны (+998 90 123 45 67), Telegram ID — как id:123456789';

async function resolveStaffTarget(app: AppContext, raw: string | number) {
  const s = String(raw).trim();
  const { kind, value } = classifyPhoneOrId(s);
  if (kind === 'ambiguous') throw new HttpError(400, 'validation', AMBIGUOUS_MSG);
  const digits = value.replace(/\D/g, '');
  if (kind === 'phone') {
    const phone = normalizePhone(s);
    if (!phone) throw new HttpError(400, 'validation', 'Не похоже на номер телефона');
    const found = await app.repo.findClientByPhone(phone);
    // An imported client (old base) has a negative placeholder id: not a Telegram account yet.
    const client = found && found.telegramId > 0 ? found : null;
    const user = client ? await app.repo.getTgUser(client.telegramId) : null;
    return { telegramId: client?.telegramId ?? null, phone, name: client?.name ?? found?.name ?? user?.firstName ?? null };
  }
  // Only a plain number is a Telegram id: "@ivan_2002", "id:12a" or "1e+21" must not turn into 2002 / 12 / 121.
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'validation', 'Укажите телефон (+998 90 123 45 67) или Telegram ID цифрами (id:123456789)');
  const id = Number(digits);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'validation', 'Укажите телефон или Telegram ID');
  const client = await app.repo.findClientByTelegramId(id);
  const user = await app.repo.getTgUser(id);
  return { telegramId: id, phone: client?.phone ?? null, name: client?.name ?? user?.firstName ?? null };
}

ownerRoutes.post('/staff', async (c) => {
  const app = c.get('app');
  const body = addStaffSchema.parse(await c.req.json());
  const target = await resolveStaffTarget(app, body.phoneOrTelegramId);
  const name = body.name || target.name || (target.phone ? `Сотрудник ${target.phone.slice(-4)}` : `Сотрудник ${target.telegramId}`);
  // Changing the role of the last active owner to something else would lock everyone out of the owner screens.
  if (body.role !== 'owner') {
    const existing = target.telegramId !== null ? await app.repo.findStaffByTelegramId(target.telegramId) : target.phone ? await app.repo.findStaffByPhone(target.phone) : null;
    if (existing?.active && existing.role === 'owner' && (await app.repo.countActiveOwners()) <= 1) {
      throw new HttpError(409, 'conflict', 'Нельзя понизить последнего владельца: сначала назначьте другого владельца');
    }
  }
  const member = await app.repo.upsertStaff({ telegramId: target.telegramId, phone: target.phone, name, role: body.role }, app.now());
  return c.json(staffDTO(member), 201);
});

ownerRoutes.delete('/staff/:id', async (c) => {
  const app = c.get('app');
  const caller = c.get('caller');
  const target = await app.repo.findStaffById(c.req.param('id'));
  if (!target) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
  if (target.role === 'owner' && target.active && (await app.repo.countActiveOwners()) <= 1 && !caller.tester) {
    throw new HttpError(409, 'conflict', 'Нельзя отключить последнего владельца');
  }
  if (caller.staff?.id === target.id && !caller.tester) throw new HttpError(409, 'conflict', 'Нельзя отключить самого себя');
  const updated = await app.repo.deactivateStaff(target.id);
  return c.json(staffDTO(updated!));
});

// ------------------------------------------------------------ operations

ownerRoutes.get('/operations', async (c) => {
  const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(c.req.query('limit') ?? 100);
  return c.json(await operationsFor(c.get('app'), limit));
});

// ------------------------------------------------------------ client base, manual adjustment, CSV export

ownerRoutes.route('/', ownerClientRoutes);
