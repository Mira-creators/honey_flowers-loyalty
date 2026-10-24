import type { ImportBatchDTO, ImportOptions, ImportRequest, ImportResultDTO, ImportRowResult } from '@honey/contracts';
import { normalizeUzPhone } from '@honey/contracts';
import { emptyClientState, type LoyaltyRules } from '@honey/core';
import { placeholderTelegramId } from '@honey/service';
import { z } from 'zod';
import { computeClientStats } from '../lib/clientStats.js';
import { nextCheckOn } from '../lib/expirySchedule.js';
import { HttpError } from '../lib/errors.js';
import { byIds, contributionStmts } from '../lib/statsDaily.js';

export const IMPORT_REASON = 'Импорт базы: стартовый баланс';

/**
 * Import of the shop's existing client base (POST /api/owner/import, ≤ 100 rows per call).
 *
 * Idempotent by phone:
 *  - a phone that is not in the base yet → new client WITHOUT Telegram (negative placeholder
 *    telegram_id, see migrations/0005). Optional starting honey (manual_adjust entry with
 *    idempotency key "import:<batch>:<phone>", so the normal 90-day expiry applies), optional
 *    level floor from the past purchase sum, optional bee position from the past purchase count;
 *  - a phone that is already in the base (registered via Telegram or imported before) → only
 *    name / birthday are filled in; honey is NEVER credited twice;
 *  - a row repeated inside the same batch (a retried chunk) → nothing ("replay").
 * When the real person later shares that phone with the bot, the client is claimed
 * (packages/service registerWithPhone), keeping balance and history.
 *
 * D1 cost per call: 1 read batch (existing phones + batch row + code collisions) + 1 write batch.
 * Rows are passed as ONE JSON parameter and expanded with json_each (D1 allows 100 bound
 * parameters per statement), so a chunk is a handful of statements whatever its size.
 */

export const IMPORT_CHUNK = 100;

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
const amount = z.number().int().min(0).max(100_000_000_000);

export const importSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'batchId: 8–64 латинских букв, цифр или «-»'),
  fileName: z.string().trim().max(200).nullish(),
  dryRun: z.boolean(),
  options: z.object({ creditBalance: z.boolean(), levelFromTotal: z.boolean(), cellsFromCount: z.boolean() }),
  rows: z
    .array(
      z.object({
        line: z.number().int().min(0).max(10_000_000),
        phone: z.string().max(60),
        name: z.string().max(200).nullish(),
        birthday: z.string().max(20).nullish(),
        balance: z.number().nullish(),
        total: z.number().nullish(),
        count: z.number().nullish(),
        lastPurchase: z.string().max(20).nullish(),
      }),
    )
    .min(1)
    .max(IMPORT_CHUNK),
  skipped: z.number().int().min(0).max(1_000_000).optional(),
});

interface CleanRow {
  line: number;
  phone: string;
  name: string | null;
  birthday: string | null;
  balance: number | null;
  total: number | null;
  count: number | null;
  lastPurchase: string | null;
}

const okOr = <T>(schema: z.ZodType<T>, v: unknown): T | null => {
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

function randomCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return `HF${String(100_000 + (buf[0]! % 900_000))}`;
}

/** Tier index reached by the legacy figures (sum or count, as the rules count levels). */
export function legacyTier(rules: LoyaltyRules, total: number | null, count: number | null): number {
  const metric = rules.levels.criterion === 'sum' ? total : count;
  if (!metric) return 0;
  let idx = 0;
  rules.levels.tiers.forEach((t, i) => {
    if (metric >= t.threshold) idx = i;
  });
  return idx;
}

/** Bee position from the legacy purchase count: never on the last cell, no gifts for passed cells. */
export function legacyCell(rules: LoyaltyRules, count: number | null): number {
  if (!count || count <= 0) return 0;
  return Math.min(count, rules.honeycomb.cells - 1);
}

type Row = Record<string, unknown>;

export async function runImport(
  db: D1Database,
  rules: LoyaltyRules,
  actorId: string,
  req: ImportRequest,
  now: Date,
): Promise<ImportResultDTO> {
  const nowIso = now.toISOString();
  const results: ImportRowResult[] = [];
  const clean: CleanRow[] = [];
  const seen = new Set<string>();
  for (const r of req.rows) {
    const phone = normalizeUzPhone(r.phone);
    if (!phone) {
      results.push({ line: r.line, phone: null, status: 'invalid', message: `Не похоже на узбекский номер: «${r.phone}»`, honey: 0, linked: null });
      continue;
    }
    if (seen.has(phone)) {
      results.push({ line: r.line, phone, status: 'duplicate', message: 'Повтор номера в файле', honey: 0, linked: null });
      continue;
    }
    seen.add(phone);
    const name = r.name?.replace(/\s+/g, ' ').trim().slice(0, 60) || null;
    clean.push({
      line: r.line,
      phone,
      name,
      birthday: okOr(ymd, r.birthday),
      balance: okOr(amount, r.balance),
      total: okOr(amount, r.total),
      count: okOr(amount, r.count),
      lastPurchase: okOr(ymd, r.lastPurchase),
    });
  }

  // Code candidates for the clients this chunk may create (checked against the base in the same round trip).
  const codes = new Set<string>();
  while (codes.size < clean.length) codes.add(randomCode());

  const [existingRes, batchRes, codeRes] = await db.batch<Row>([
    db
      .prepare(
        `SELECT c.id, c.phone, c.name, c.birthday, c.telegram_id, c.demo, i.batch_id
         FROM clients c LEFT JOIN client_imports i ON i.client_id = c.id
         WHERE c.phone IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(clean.map((r) => r.phone))),
    db.prepare('SELECT status, options FROM import_batches WHERE id = ?1').bind(req.batchId),
    db.prepare('SELECT code FROM clients WHERE code IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...codes])),
  ]);
  const existing = new Map(existingRes!.results.map((r) => [String(r.phone), r]));
  const batch = batchRes!.results[0];
  if (batch && batch.status === 'undone') throw new HttpError(409, 'conflict', 'Этот импорт уже отменён: начните импорт файла заново');
  if (batch && !req.dryRun) {
    const prev = JSON.parse(String(batch.options)) as ImportOptions;
    if (prev.creditBalance !== req.options.creditBalance || prev.levelFromTotal !== req.options.levelFromTotal || prev.cellsFromCount !== req.options.cellsFromCount) {
      throw new HttpError(409, 'conflict', 'Параметры импорта нельзя менять посреди загрузки файла: начните импорт заново');
    }
  }
  const taken = new Set(codeRes!.results.map((r) => String(r.code)));
  const freeCodes = [...codes].filter((c) => !taken.has(c));
  while (freeCodes.length < clean.length) freeCodes.push(randomCode()); // ~never; a clash then fails the batch → retry

  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  for (const r of clean) {
    const ex = existing.get(r.phone);
    if (ex) {
      const linked = Number(ex.telegram_id) > 0;
      if (Number(ex.demo ?? 0) === 1) {
        // TEST_MODE demo data owns this (fake) number: leave the demo client alone, import nothing.
        results.push({ line: r.line, phone: r.phone, status: 'update', message: 'Номер занят демо-клиентом (тестовые данные): строка не загружена — удалите демо-данные и повторите импорт', honey: 0, linked: false });
        continue;
      }
      if (ex.batch_id !== null && ex.batch_id !== undefined && String(ex.batch_id) === req.batchId) {
        results.push({ line: r.line, phone: r.phone, status: 'replay', message: 'Уже загружен в этом импорте', honey: 0, linked });
        continue;
      }
      // Imported (not yet linked) clients take the file's values; real Telegram clients only get blanks filled.
      const changes: string[] = [];
      if (r.name && r.name !== ex.name && (!linked || !ex.name)) changes.push('имя');
      if (r.birthday && r.birthday !== ex.birthday && (!linked || !ex.birthday)) changes.push('день рождения');
      if (changes.length) {
        const oldName = ex.name === null || ex.name === undefined ? null : String(ex.name);
        const oldBirthday = ex.birthday === null || ex.birthday === undefined ? null : String(ex.birthday);
        updates.push({
          id: String(ex.id),
          oldName,
          oldBirthday,
          name: linked ? oldName ?? r.name : r.name ?? oldName,
          birthday: linked ? oldBirthday ?? r.birthday : r.birthday ?? oldBirthday,
        });
      }
      results.push({
        line: r.line,
        phone: r.phone,
        status: 'update',
        message: `${linked ? 'Уже участник в Telegram' : 'Уже в базе (импорт)'}: ${changes.length ? `обновим ${changes.join(' и ')}` : 'без изменений'}, мёд не начисляется`,
        honey: 0,
        linked,
      });
      continue;
    }
    const honey = req.options.creditBalance && r.balance ? r.balance : 0;
    const tier = req.options.levelFromTotal ? legacyTier(rules, r.total, r.count) : 0;
    const cell = req.options.cellsFromCount ? legacyCell(rules, r.count) : 0;
    const notes = [honey ? `мёд ${honey.toLocaleString('ru-RU')}` : null, tier ? `уровень «${rules.levels.tiers[tier]!.title}»` : null, cell ? `соты: ${cell}` : null].filter(Boolean);
    results.push({ line: r.line, phone: r.phone, status: 'create', message: notes.length ? notes.join(', ') : null, honey, linked: false });
    const id = crypto.randomUUID();
    const key = `import:${req.batchId}:${r.phone}`;
    // The owner's client list summary (client_stats, migration 0004) for the new client, computed by the
    // engine exactly like saveOutcome does, from the facts this import writes.
    const state = emptyClientState(id, now);
    if (honey) state.ledger.push({ clientId: id, type: 'manual_adjust', amount: honey, purchaseId: null, staffId: actorId, reason: IMPORT_REASON, idempotencyKey: key, createdAt: now });
    if (tier) state.levelOverride = { levelId: rules.levels.tiers[tier]!.id, setAt: now, levelIndex: tier };
    if (cell) state.cardMoves.push({ clientId: id, purchaseId: null, cycle: 1, cell, reason: 'import', createdAt: now, revertedAt: null });
    const st = computeClientStats(rules, state, now);
    creates.push({
      id,
      // The daily job's schedule: reminders / expiry of the starting мёд (lib/expirySchedule.ts).
      nc: nextCheckOn(rules, state, now),
      s: [st.balance, st.spent, st.purchasesCount, st.lastPurchaseAt, st.levelId, st.giftsAvailable, st.activityAt, st.expiresOn, st.levelSum, st.levelCount],
      tid: placeholderTelegramId(r.phone),
      code: freeCodes.pop(),
      phone: r.phone,
      name: r.name,
      birthday: r.birthday,
      lo: tier ? rules.levels.tiers[tier]!.id : null,
      loi: tier || null,
      honey,
      cell,
      key,
      lb: r.balance,
      lt: r.total,
      lc: r.count,
      lp: r.lastPurchase,
    });
  }
  results.sort((a, b) => a.line - b.line);
  const summary = {
    create: results.filter((r) => r.status === 'create').length,
    update: results.filter((r) => r.status === 'update').length,
    replay: results.filter((r) => r.status === 'replay').length,
    skipped: results.filter((r) => r.status === 'invalid' || r.status === 'duplicate').length,
    honey: results.reduce((s, r) => s + r.honey, 0),
  };
  if (req.dryRun) return { batchId: req.batchId, dryRun: true, results, summary };

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO import_batches (id, created_at, updated_at, created_by, file_name, options, rows_received, created_count, updated_count, skipped_count, honey_total)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
           rows_received = rows_received + excluded.rows_received, created_count = created_count + excluded.created_count,
           updated_count = updated_count + excluded.updated_count, skipped_count = skipped_count + excluded.skipped_count,
           honey_total = honey_total + excluded.honey_total`,
      )
      .bind(
        req.batchId, nowIso, actorId, req.fileName ?? null, JSON.stringify(req.options), req.rows.length + (req.skipped ?? 0),
        summary.create, summary.update, summary.skipped + (req.skipped ?? 0), summary.honey,
      ),
  ];
  if (creates.length) {
    const json = JSON.stringify(creates);
    stmts.push(
      db
        .prepare(
          `INSERT INTO clients (id, telegram_id, code, phone, name, birthday, language, consent_at, created_at, level_override, level_override_at, level_override_index, next_check_on)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.tid'), json_extract(value, '$.code'), json_extract(value, '$.phone'),
             json_extract(value, '$.name'), json_extract(value, '$.birthday'), 'ru', NULL, ?2,
             json_extract(value, '$.lo'), CASE WHEN json_extract(value, '$.lo') IS NULL THEN NULL ELSE ?2 END, json_extract(value, '$.loi'),
             json_extract(value, '$.nc')
           FROM json_each(?1)`,
        )
        .bind(json, nowIso),
      db
        .prepare(
          `INSERT INTO client_imports (client_id, batch_id, legacy_balance, legacy_total, legacy_count, legacy_last_purchase, created_at)
           SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.lb'), json_extract(value, '$.lt'), json_extract(value, '$.lc'), json_extract(value, '$.lp'), ?3
           FROM json_each(?1)`,
        )
        .bind(json, req.batchId, nowIso),
    );
    if (creates.some((c) => Number(c.honey) > 0)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
             SELECT lower(hex(randomblob(16))), json_extract(value, '$.id'), 'manual_adjust', json_extract(value, '$.honey'), NULL, ?2,
               ?4, json_extract(value, '$.key'), ?3
             FROM json_each(?1) WHERE json_extract(value, '$.honey') > 0`,
          )
          .bind(json, actorId, nowIso, IMPORT_REASON),
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at, level_sum, level_count)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.s[0]'), json_extract(value, '$.s[1]'), json_extract(value, '$.s[2]'),
             json_extract(value, '$.s[3]'), json_extract(value, '$.s[4]'), json_extract(value, '$.s[5]'), json_extract(value, '$.s[6]'),
             json_extract(value, '$.s[7]'), ?2, json_extract(value, '$.s[8]'), json_extract(value, '$.s[9]')
           FROM json_each(?1)`,
        )
        .bind(json, nowIso),
    );
    if (creates.some((c) => Number(c.cell) > 0)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO card_moves (client_id, purchase_id, cycle, cell, reason, reverted_at, created_at)
             SELECT json_extract(value, '$.id'), NULL, 1, json_extract(value, '$.cell'), 'import', NULL, ?2
             FROM json_each(?1) WHERE json_extract(value, '$.cell') > 0`,
          )
          .bind(json, nowIso),
      );
    }
  }
  if (creates.length) {
    // stats_daily (migration 0007): imported clients and their starting мёд (not "issued", not "new").
    stmts.push(...contributionStmts(db, 1, byIds, [JSON.stringify(creates.map((c) => c.id))]));
  }
  if (updates.length) {
    const json = JSON.stringify(updates);
    stmts.push(
      // The old values first (the first import of this batch wins on a repeated chunk), for undo.
      db
        .prepare(
          `INSERT OR IGNORE INTO import_updates (batch_id, client_id, old_name, old_birthday, new_name, new_birthday, created_at)
           SELECT ?2, json_extract(value, '$.id'), json_extract(value, '$.oldName'), json_extract(value, '$.oldBirthday'),
             json_extract(value, '$.name'), json_extract(value, '$.birthday'), ?3
           FROM json_each(?1)`,
        )
        .bind(json, req.batchId, nowIso),
      // Exact new values, only if nobody changed the client since it was read.
      db
        .prepare(
          `UPDATE clients SET name = j.name, birthday = j.birthday
           FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.name') AS name, json_extract(value, '$.birthday') AS birthday,
                   json_extract(value, '$.oldName') AS old_name, json_extract(value, '$.oldBirthday') AS old_birthday
                 FROM json_each(?1)) AS j
           WHERE clients.id = j.id AND clients.name IS j.old_name AND clients.birthday IS j.old_birthday`,
        )
        .bind(json),
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
    if (msg.includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'conflict', 'Пока шёл импорт, кто-то из клиентов зарегистрировался: отправьте эту часть ещё раз');
    }
    throw e;
  }
  return { batchId: req.batchId, dryRun: false, results, summary };
}

// ------------------------------------------------------------------ batches

function batchDTO(r: Row): ImportBatchDTO {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    createdBy: r.created_by_name ? String(r.created_by_name) : r.created_by ? String(r.created_by) : null,
    fileName: r.file_name === null ? null : String(r.file_name),
    options: JSON.parse(String(r.options)) as ImportOptions,
    rowsReceived: Number(r.rows_received),
    created: Number(r.created_count),
    updated: Number(r.updated_count),
    skipped: Number(r.skipped_count),
    honey: Number(r.honey_total),
    status: String(r.status) as 'active' | 'undone',
    undoneAt: r.undone_at === null ? null : String(r.undone_at),
    claimed: Number(r.claimed ?? 0),
  };
}

const BATCH_SELECT = `SELECT b.*, s.name AS created_by_name,
    (SELECT COUNT(*) FROM client_imports i JOIN clients c ON c.id = i.client_id WHERE i.batch_id = b.id AND c.telegram_id > 0) AS claimed
  FROM import_batches b LEFT JOIN staff s ON s.id = b.created_by`;

export async function listBatches(db: D1Database, limit = 50): Promise<ImportBatchDTO[]> {
  const { results } = await db.prepare(`${BATCH_SELECT} ORDER BY b.created_at DESC LIMIT ?1`).bind(limit).all<Row>();
  return results.map(batchDTO);
}

/** What prevents undoing a batch: claimed by Telegram users, purchases, or other honey movements. */
const BLOCKERS = `FROM client_imports i JOIN clients c ON c.id = i.client_id WHERE i.batch_id = ?1 AND (
    c.telegram_id > 0
    OR EXISTS (SELECT 1 FROM purchases p WHERE p.client_id = c.id)
    OR EXISTS (SELECT 1 FROM points_ledger l WHERE l.client_id = c.id AND COALESCE(l.idempotency_key, '') NOT LIKE 'import:%')
    OR EXISTS (SELECT 1 FROM rewards r WHERE r.client_id = c.id))`;

/**
 * Undo a batch: removes every client it CREATED, with their import honey and bee moves, but
 * only if none of them has joined via Telegram, bought, or had any other honey movement
 * (incl. expiry by the daily job). Name/birthday updates of existing clients are not undone.
 * All in one transaction; the ledger's append-only trigger doubles as the guard: the
 * maintenance flag is set only when there are no blockers at that moment.
 */
export async function undoBatch(db: D1Database, id: string, now: Date): Promise<ImportBatchDTO> {
  const b = await db.prepare('SELECT status FROM import_batches WHERE id = ?1').bind(id).first<Row>();
  if (!b) throw new HttpError(404, 'not_found', 'Импорт не найден');
  if (b.status === 'undone') throw new HttpError(409, 'conflict', 'Этот импорт уже отменён');
  const blockers = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(c.telegram_id > 0), 0) AS claimed ${BLOCKERS}`)
    .bind(id)
    .first<{ n: number; claimed: number }>();
  if (Number(blockers?.n ?? 0) > 0) {
    throw new HttpError(
      409,
      'conflict',
      `Отменить нельзя: у ${blockers!.n} клиент(ов) из этого импорта уже были покупки или движения мёда` +
        (Number(blockers!.claimed) ? `, ${blockers!.claimed} уже вошли через Telegram` : '') +
        '. Исправьте их вручную в карточке клиента.',
    );
  }
  const mine = `client_id IN (SELECT client_id FROM client_imports WHERE batch_id = ?1)`;
  const guard = `EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_ledger_delete')`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO maintenance (flag) SELECT 'allow_ledger_delete' WHERE NOT EXISTS (SELECT 1 ${BLOCKERS})`).bind(id),
    // stats_daily: subtract what the batch's clients contributed — only when the undo really happens.
    ...contributionStmts(db, -1, (col) => `${col} IN (SELECT client_id FROM client_imports WHERE batch_id = ?1)`, [id], guard),
    db.prepare(`DELETE FROM points_ledger WHERE ${mine}`).bind(id),
    ...['card_moves', 'notification_keys', 'notifications_log', 'outbox', 'client_versions', 'important_dates', 'client_stats'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE ${mine} AND ${guard}`).bind(id),
    ),
    db.prepare(`DELETE FROM clients WHERE id IN (SELECT client_id FROM client_imports WHERE batch_id = ?1) AND ${guard}`).bind(id),
    // Clients that existed before: put back the name / birthday the import filled in, unless changed since.
    db
      .prepare(
        `UPDATE clients SET name = u.old_name FROM import_updates u
         WHERE u.batch_id = ?1 AND clients.id = u.client_id AND clients.name IS u.new_name AND u.old_name IS NOT u.new_name AND ${guard}`,
      )
      .bind(id),
    db
      .prepare(
        `UPDATE clients SET birthday = u.old_birthday FROM import_updates u
         WHERE u.batch_id = ?1 AND clients.id = u.client_id AND clients.birthday IS u.new_birthday AND u.old_birthday IS NOT u.new_birthday AND ${guard}`,
      )
      .bind(id),
    db.prepare(`DELETE FROM import_updates WHERE batch_id = ?1 AND ${guard}`).bind(id),
    db.prepare(`UPDATE import_batches SET status = 'undone', undone_at = ?2 WHERE id = ?1 AND ${guard}`).bind(id, now.toISOString()),
    db.prepare(`DELETE FROM maintenance WHERE flag = 'allow_ledger_delete'`),
  ]);
  const after = await db.prepare(`${BATCH_SELECT} WHERE b.id = ?1`).bind(id).first<Row>();
  if (!after || after.status !== 'undone') throw new HttpError(409, 'conflict', 'Отменить не получилось: клиенты из импорта только что начали пользоваться картой');
  return batchDTO(after);
}
