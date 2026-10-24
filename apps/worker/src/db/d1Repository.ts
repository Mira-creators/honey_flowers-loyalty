import {
  defaultRules,
  localDateKey,
  LoyaltyError,
  parseRules,
  type CardMove,
  type ClientState,
  type LedgerEntry,
  type LoyaltyRules,
  type Outcome,
  type PurchaseRecord,
  type Reward,
} from '@honey/core';
import {
  ConcurrencyError,
  nationalPart,
  phoneDigits,
  PhoneTakenError,
  type ClientProfile,
  type LoadHint,
  type NewClient,
  type Repository,
  type RulesVersion,
  type SavedState,
  type StaffMember,
  type StaffRole,
  type VersionedState,
} from '@honey/service';

/**
 * Repository on Cloudflare D1 (SQLite). Schema: migrations/0001_init.sql.
 *
 * Concurrency: D1 has no row locks. Every write of engine facts goes through
 * `saveOutcome`, which runs ONE `db.batch([...])` (a transaction) whose first
 * statement inserts (client_id, loadedVersion + 1) into client_versions. A
 * concurrent writer that loaded the same version violates the primary key, its
 * whole batch is rolled back and LoyaltyService re-runs the command on fresh state.
 */

import { computeClientStats, type ClientStats } from '../lib/clientStats.js';
import { assembleBounded, boundedStatements } from './stateLoader.js';
import { HISTORY_PAGE, historyStmt, type HistoryCursor } from '../lib/history.js';
import { NEXT_CHECK_CHUNK, nextCheckOn, nextChecksSql } from '../lib/expirySchedule.js';
import {
  addStmt,
  byIds,
  contributionStmts,
  invalidateBuyersStmt,
  ledgerStmts,
  purchaseContribution,
  rewardsContribution,
  tashkentDay,
} from '../lib/statsDaily.js';

type Row = Record<string, unknown>;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const date = (v: unknown) => new Date(String(v));
const dateOrNull = (v: unknown) => (v === null || v === undefined ? null : new Date(String(v)));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v);

export interface TgUser {
  telegramId: number;
  firstName: string | null;
  username: string | null;
  language: string;
}

export interface NotificationLogEntry {
  clientId: string | null;
  telegramId: number | null;
  types: string;
  text: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string | null;
}

export interface ClientContact {
  id: string;
  telegramId: number;
  language: string;
  name: string | null;
  /** Demo client (TEST_MODE seeding): has no real chat, never messaged. */
  demo: boolean;
}

/** Filters of the owner's client list (routes/owner.ts builds them from the query string). */
export interface ClientListQuery {
  /** Exact client code ("HF4821"). */
  code?: string | null;
  /** National part of a phone number (digits), matched as a substring. */
  phone?: string | null;
  /** Substrings of the name (any of them matches; case variants prepared by the caller). */
  names?: string[] | null;
  levelId?: string | null;
  /** last_purchase_at >= this ISO instant. */
  lastFrom?: string | null;
  /** last_purchase_at < this ISO instant ('' = never also matches, since '' sorts first). */
  lastBefore?: string | null;
  /** expires_on within [from, to] (Tashkent days). */
  expiresFrom?: string | null;
  expiresTo?: string | null;
  /** birthday 'MM-DD' in this list. */
  birthdays?: string[] | null;
  sort: 'last_purchase_desc' | 'spent_desc' | 'balance_desc' | 'name' | 'created_desc';
  /** Keyset position: sort value and id of the last row of the previous page. */
  after?: { value: string | number; id: string } | null;
  limit: number;
}

/** A client list / export row: clients ⋈ client_stats. */
export interface ClientListRow {
  id: string;
  name: string | null;
  phone: string | null;
  code: string;
  language: string;
  createdAt: string;
  note: string | null;
  balance: number;
  spent: number;
  purchasesCount: number;
  lastPurchaseAt: string;
  levelId: string;
  giftsAvailable: number;
  expiresOn: string;
}

/** Everything the owner's client card needs, read in one batch (a consistent snapshot). */
export interface ClientCard {
  client: ClientProfile;
  note: string | null;
  stats: ClientStats | null;
  versioned: VersionedState;
}

function listRowFromRow(r: Row): ClientListRow {
  return {
    id: String(r.id),
    name: str(r.name),
    phone: str(r.phone),
    code: String(r.code),
    language: String(r.language ?? 'ru'),
    createdAt: String(r.created_at),
    note: str(r.note),
    balance: num(r.balance ?? 0),
    spent: num(r.spent ?? 0),
    purchasesCount: num(r.purchases_count ?? 0),
    lastPurchaseAt: String(r.last_purchase_at ?? ''),
    levelId: String(r.level_id ?? ''),
    giftsAvailable: num(r.gifts_available ?? 0),
    expiresOn: String(r.expires_on ?? ''),
  };
}

function statsFromRow(r: Row): ClientStats {
  return {
    balance: num(r.balance),
    spent: num(r.spent),
    purchasesCount: num(r.purchases_count),
    lastPurchaseAt: String(r.last_purchase_at),
    levelId: String(r.level_id),
    giftsAvailable: num(r.gifts_available),
    activityAt: String(r.activity_at),
    expiresOn: String(r.expires_on),
    levelSum: num(r.level_sum ?? 0),
    levelCount: num(r.level_count ?? 0),
  };
}

/** ORDER BY / keyset column of each sort (all DESC except name). */
const SORTS: Record<ClientListQuery['sort'], { col: string; desc: boolean; numeric: boolean; drive: 'stats' | 'clients' }> = {
  last_purchase_desc: { col: 's.last_purchase_at', desc: true, numeric: false, drive: 'stats' },
  spent_desc: { col: 's.spent', desc: true, numeric: true, drive: 'stats' },
  balance_desc: { col: 's.balance', desc: true, numeric: true, drive: 'stats' },
  name: { col: "COALESCE(c.name, '')", desc: false, numeric: false, drive: 'clients' },
  created_desc: { col: 'c.created_at', desc: true, numeric: false, drive: 'clients' },
};

export { SORTS as CLIENT_SORTS };

function clientFromRow(r: Row): ClientProfile {
  return {
    id: String(r.id),
    telegramId: num(r.telegram_id),
    code: String(r.code),
    phone: str(r.phone),
    name: str(r.name),
    birthday: str(r.birthday),
    language: String(r.language ?? 'ru'),
    consentAt: dateOrNull(r.consent_at),
    createdAt: date(r.created_at),
    ...(num(r.demo ?? 0) === 1 ? { demo: true } : {}),
  };
}

function staffFromRow(r: Row): StaffMember {
  return {
    id: String(r.id),
    telegramId: r.telegram_id === null ? null : num(r.telegram_id),
    phone: str(r.phone),
    name: String(r.name),
    role: String(r.role) as StaffRole,
    active: num(r.active) === 1,
  };
}

function purchaseFromRow(r: Row): PurchaseRecord {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    staffId: str(r.staff_id),
    idempotencyKey: String(r.idempotency_key),
    amount: num(r.amount),
    lines: JSON.parse(String(r.lines)),
    channel: String(r.channel) as PurchaseRecord['channel'],
    pointsRedeemed: num(r.points_redeemed),
    discountApplied: num(r.discount_applied),
    rewardUsedId: str(r.reward_used_id),
    rulesVersion: num(r.rules_version_id),
    status: String(r.status) as PurchaseRecord['status'],
    reversedReason: str(r.reversed_reason),
    reversedBy: str(r.reversed_by),
    reversedAt: dateOrNull(r.reversed_at),
    createdAt: date(r.created_at),
    result: r.result === null || r.result === undefined ? null : JSON.parse(String(r.result)),
  };
}

function ledgerFromRow(r: Row): LedgerEntry {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    type: String(r.type) as LedgerEntry['type'],
    amount: num(r.amount),
    purchaseId: str(r.purchase_id),
    staffId: str(r.staff_id),
    reason: str(r.reason),
    idempotencyKey: str(r.idempotency_key),
    createdAt: date(r.created_at),
  };
}

function overrideFromRow(c: Row): ClientState['levelOverride'] {
  if (!c.level_override) return null;
  const idx = c.level_override_index === null || c.level_override_index === undefined ? undefined : num(c.level_override_index);
  return { levelId: String(c.level_override), setAt: date(c.level_override_at), ...(idx !== undefined ? { levelIndex: idx } : {}) };
}

function moveFromRow(r: Row): CardMove {
  return {
    clientId: String(r.client_id),
    purchaseId: str(r.purchase_id),
    cycle: num(r.cycle),
    cell: num(r.cell),
    reason: String(r.reason) as CardMove['reason'],
    createdAt: date(r.created_at),
    revertedAt: dateOrNull(r.reverted_at),
  };
}

function rewardFromRow(r: Row): Reward {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    cycle: num(r.cycle),
    cell: num(r.cell),
    type: String(r.type) as Reward['type'],
    value: r.value === null || r.value === undefined ? null : num(r.value),
    title: String(r.title),
    status: String(r.status) as Reward['status'],
    unlockedByPurchase: str(r.unlocked_by_purchase),
    usedInPurchase: str(r.used_in_purchase),
    usedIdempotencyKey: str(r.used_idempotency_key),
    unlockedAt: date(r.unlocked_at),
    usedAt: dateOrNull(r.used_at),
    ...(r.granted_by !== null && r.granted_by !== undefined ? { grantedBy: String(r.granted_by), grantReason: str(r.grant_reason) } : {}),
  };
}

function randomDigits(n: number): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const min = 10 ** (n - 1);
  return String(min + (buf[0]! % (9 * min)));
}

function isUniqueViolation(e: unknown, needle: string): boolean {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return msg.includes('UNIQUE constraint failed') && msg.includes(needle);
}

function isVersionConflict(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return msg.includes('client_versions') || msg.includes('stale client version');
}

export class D1Repository implements Repository {
  private rulesCache: RulesVersion | null = null;

  constructor(readonly db: D1Database) {}

  // ---------------------------------------------------------------- settings

  async getSetting(key: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    return r?.value ?? null;
  }

  async getSettings(keys: string[]): Promise<Record<string, string>> {
    if (!keys.length) return {};
    const { results } = await this.db
      .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ key: string; value: string }>();
    return Object.fromEntries(results.map((r) => [r.key, r.value]));
  }

  setSettingStmt(key: string, value: string): D1PreparedStatement {
    return this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, value);
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.setSettingStmt(key, value).run();
  }

  /** TEST_MODE time travel, whole days, clamped to [0, MAX_CLOCK_OFFSET_DAYS] so "now" is always a valid Date. */
  static readonly MAX_CLOCK_OFFSET_DAYS = 3650;

  async getClockOffsetDays(): Promise<number> {
    const v = Math.trunc(Number(await this.getSetting('clock_offset_days')));
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), D1Repository.MAX_CLOCK_OFFSET_DAYS) : 0;
  }

  /**
   * TEST_MODE: set the clock offset. "today" moved, so every client's next_check_on is recomputed in
   * SQL for the new today (overdue ones become due today) in the same batch.
   */
  async setClockOffsetDays(days: number): Promise<void> {
    const { rules } = await this.getActiveRules();
    const today = localDateKey(new Date(Date.now() + days * 86_400_000), rules.timezone);
    await this.db.batch([
      this.setSettingStmt('clock_offset_days', String(days)),
      ...(await this.nextChecksStmts(rules, today)),
      // "today" moved: cached distinct buyers of "past" windows may now include purchases to come.
      invalidateBuyersStmt(this.db),
    ]);
  }

  // ---------------------------------------------------------------- rules

  /** Rules in force (settings.rules_version). Version 1 = defaultRules, inserted on first use. */
  async getActiveRules(_now?: Date): Promise<RulesVersion> {
    if (this.rulesCache) return this.rulesCache;
    const row = await this.db
      .prepare(
        `SELECT r.id, r.rules, r.active_from, r.created_by FROM rules_versions r
         WHERE r.id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)`,
      )
      .first<Row>();
    if (row) {
      this.rulesCache = {
        id: num(row.id),
        rules: parseRules(JSON.parse(String(row.rules))),
        activeFrom: date(row.active_from),
        createdBy: str(row.created_by),
      };
      return this.rulesCache;
    }
    // Seed: version 1 = packages/core defaultRules (single source of truth).
    const seed = { ...defaultRules, version: 1 };
    const at = new Date(0).toISOString();
    await this.db.batch([
      this.db
        .prepare('INSERT OR IGNORE INTO rules_versions (id, rules, active_from, created_by, created_at) VALUES (1, ?, ?, NULL, ?)')
        .bind(JSON.stringify(seed), at, new Date().toISOString()),
      this.db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('rules_version', '1')`),
    ]);
    this.rulesCache = null;
    const again = await this.db.prepare('SELECT id FROM rules_versions WHERE id = 1').first();
    if (!again) throw new Error('failed to seed rules');
    return this.getActiveRules();
  }

  async getRulesVersion(id: number): Promise<LoyaltyRules | null> {
    const row = await this.db.prepare('SELECT rules FROM rules_versions WHERE id = ?').bind(id).first<Row>();
    return row ? parseRules(JSON.parse(String(row.rules))) : null;
  }

  /**
   * Store a new rules version and make it current. Fails with
   * LoyaltyError(IDEMPOTENCY_CONFLICT) semantics via ConcurrencyError if the
   * version id already exists (two owners saving at once).
   */
  async createRulesVersion(rules: LoyaltyRules, createdBy: string | null, now: Date): Promise<void> {
    const recompute = await this.nextChecksStmts(rules, localDateKey(now, rules.timezone));
    try {
      await this.db.batch([
        this.db
          .prepare('INSERT INTO rules_versions (id, rules, active_from, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(rules.version, JSON.stringify(rules), iso(now), createdBy, iso(new Date())),
        this.setSettingStmt('rules_version', String(rules.version)),
        // Expiry days / warning days may have changed: recompute every client's next check (set-based).
        ...recompute,
        // client_stats: level thresholds / expiry days may have changed (only changed rows are written).
        ...this.statsRulesStmts(rules),
      ]);
    } catch (e) {
      if (isUniqueViolation(e, 'rules_versions')) throw new ConcurrencyError('rules were changed concurrently');
      throw e;
    }
    this.rulesCache = null;
  }

  /**
   * Recompute clients.next_check_on of EVERY client for these rules and this Tashkent `today`, in SQL
   * (lib/expirySchedule.ts nextChecksSql), one statement per NEXT_CHECK_CHUNK rowids: the caller puts
   * them into its batch. One extra query (max rowid).
   */
  async nextChecksStmts(rules: LoyaltyRules, today: string): Promise<D1PreparedStatement[]> {
    const max = Number((await this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM clients').first<{ m: number }>())?.m ?? 0);
    const out: D1PreparedStatement[] = [];
    const json = JSON.stringify(rules);
    for (let lo = 0; lo < max || out.length === 0; lo += NEXT_CHECK_CHUNK) {
      out.push(this.db.prepare(nextChecksSql('?1', '?2', 'clients.rowid > ?3 AND clients.rowid <= ?4')).bind(json, today, lo, lo + NEXT_CHECK_CHUNK));
      if (lo + NEXT_CHECK_CHUNK >= max) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- telegram users

  /**
   * Remember who opened the bot / the app. Called on EVERY API request (the
   * client app polls every few seconds), so the row is rewritten at most once
   * per TOUCH_INTERVAL_MS unless the name changed (D1 counts rows written).
   */
  static readonly TOUCH_INTERVAL_MS = 10 * 60_000;

  async touchTgUser(u: { telegramId: number; firstName: string | null; username?: string | null; language?: string | null }, now: Date): Promise<void> {
    const lang = u.language === 'uz' ? 'uz' : 'ru';
    await this.db
      .prepare(
        `INSERT INTO tg_users (telegram_id, first_name, username, language, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, tg_users.first_name),
           username = COALESCE(excluded.username, tg_users.username),
           last_seen_at = excluded.last_seen_at
         WHERE tg_users.last_seen_at < ?
            OR (excluded.first_name IS NOT NULL AND excluded.first_name IS NOT tg_users.first_name)
            OR (excluded.username IS NOT NULL AND excluded.username IS NOT tg_users.username)`,
      )
      .bind(u.telegramId, u.firstName, u.username ?? null, lang, iso(now), iso(now), iso(new Date(now.getTime() - D1Repository.TOUCH_INTERVAL_MS)))
      .run();
  }

  async getTgUser(telegramId: number): Promise<TgUser | null> {
    const r = await this.db.prepare('SELECT * FROM tg_users WHERE telegram_id = ?').bind(telegramId).first<Row>();
    return r ? { telegramId: num(r.telegram_id), firstName: str(r.first_name), username: str(r.username), language: String(r.language) } : null;
  }

  async setLanguage(telegramId: number, lang: string, now: Date): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO tg_users (telegram_id, first_name, username, language, first_seen_at, last_seen_at)
           VALUES (?, NULL, NULL, ?, ?, ?)
           ON CONFLICT(telegram_id) DO UPDATE SET language = excluded.language`,
        )
        .bind(telegramId, lang, iso(now), iso(now)),
      this.db.prepare('UPDATE clients SET language = ? WHERE telegram_id = ?').bind(lang, telegramId),
    ]);
  }

  // ---------------------------------------------------------------- clients

  async findClientByTelegramId(telegramId: number): Promise<ClientProfile | null> {
    const r = await this.db.prepare('SELECT * FROM clients WHERE telegram_id = ?').bind(telegramId).first<Row>();
    return r ? clientFromRow(r) : null;
  }

  async findClientById(id: string): Promise<ClientProfile | null> {
    const r = await this.db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<Row>();
    return r ? clientFromRow(r) : null;
  }

  async findClientWithNote(id: string): Promise<{ client: ClientProfile; note: string | null } | null> {
    const r = await this.db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<Row>();
    return r ? { client: clientFromRow(r), note: str(r.note) } : null;
  }

  async findClientByCode(code: string): Promise<ClientProfile | null> {
    const r = await this.db.prepare('SELECT * FROM clients WHERE code = ?').bind(code.toUpperCase()).first<Row>();
    return r ? clientFromRow(r) : null;
  }

  async findClientByPhone(phone: string): Promise<ClientProfile | null> {
    const r = await this.db.prepare('SELECT * FROM clients WHERE phone = ?').bind(phone).first<Row>();
    return r ? clientFromRow(r) : null;
  }

  async searchClientsByPhone(digits: string, limit: number): Promise<ClientProfile[]> {
    const needle = nationalPart(phoneDigits(digits));
    if (needle.length < 4) return [];
    const { results } = await this.db
      .prepare(`SELECT * FROM clients WHERE phone IS NOT NULL AND instr(replace(phone, '+', ''), ?) > 0 ORDER BY created_at DESC LIMIT ?`)
      .bind(needle, limit)
      .all<Row>();
    return results.map(clientFromRow);
  }

  async getClientsByIds(ids: string[]): Promise<ClientProfile[]> {
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(`SELECT * FROM clients WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<Row>();
    return results.map(clientFromRow);
  }

  /** Creates the client with a unique short code "HF" + 4..6 digits. */
  async createClient(input: NewClient): Promise<ClientProfile> {
    const id = crypto.randomUUID();
    // Summary row of an empty client (level = first tier), inserted together with the client.
    const { rules } = await this.getActiveRules();
    const empty: ClientState = {
      clientId: id, registeredAt: input.createdAt, levelOverride: null, purchases: [], ledger: [], cardMoves: [], rewards: [], sentNotificationKeys: [],
    };
    const stats = computeClientStats(rules, empty, input.createdAt);
    const nextCheck = nextCheckOn(rules, empty, input.createdAt);
    for (let attempt = 0; attempt < 15; attempt++) {
      const digits = attempt < 6 ? 4 : attempt < 11 ? 5 : 6;
      const code = `HF${randomDigits(digits)}`;
      try {
        await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at, next_check_on)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(id, input.telegramId, code, input.phone, input.name, input.language === 'uz' ? 'uz' : 'ru', isoOrNull(input.consentAt), iso(input.createdAt), nextCheck),
          this.statsUpsertStmt(id, stats, input.createdAt),
          // stats_daily (migration 0007): a client registered through Telegram is "new" on that day.
          addStmt(this.db, tashkentDay(input.createdAt), { new_clients: 1 })!,
        ]);
        return (await this.findClientById(id))!;
      } catch (e) {
        if (isUniqueViolation(e, 'clients.code')) continue;
        if (isUniqueViolation(e, 'clients.telegram_id')) throw new Error('telegram_id already registered');
        // Two accounts sharing the same phone at the same moment: the second one loses cleanly.
        if (isUniqueViolation(e, 'clients.phone')) throw new PhoneTakenError('phone already belongs to another client');
        throw e;
      }
    }
    throw new Error('could not generate a unique client code');
  }

  async updateClient(
    id: string,
    patch: Partial<Pick<ClientProfile, 'name' | 'phone' | 'language' | 'consentAt' | 'birthday'>>,
  ): Promise<ClientProfile> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.phone !== undefined) add('phone', patch.phone);
    if (patch.language !== undefined) add('language', patch.language);
    if (patch.consentAt !== undefined) add('consent_at', isoOrNull(patch.consentAt));
    if (patch.birthday !== undefined) add('birthday', patch.birthday);
    if (sets.length) {
      try {
        await this.db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
      } catch (e) {
        if (isUniqueViolation(e, 'clients.phone')) throw new PhoneTakenError('phone already belongs to another client');
        throw e;
      }
    }
    const c = await this.findClientById(id);
    if (!c) throw new Error(`client ${id} not found`);
    return c;
  }

  /**
   * A Telegram account takes over a client imported from the old base (migrations/0005):
   * the negative placeholder telegram_id becomes the real one, nothing else moves. Atomic:
   * only succeeds while the row still holds that placeholder.
   */
  async claimClient(
    clientId: string,
    placeholderTelegramId: number,
    patch: { telegramId: number; name: string | null; language: string; consentAt: Date },
  ): Promise<ClientProfile | null> {
    try {
      const r = await this.db
        .prepare(
          `UPDATE clients SET telegram_id = ?1, name = COALESCE(name, ?2), language = ?3, consent_at = COALESCE(consent_at, ?4)
           WHERE id = ?5 AND telegram_id = ?6 AND telegram_id < 0
             AND demo = 0                                                              -- never a demo client (also negative ids)
             AND EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = clients.id) -- only a client created by a base import
           RETURNING *`,
        )
        .bind(patch.telegramId, patch.name, patch.language === 'uz' ? 'uz' : 'ru', iso(patch.consentAt), clientId, placeholderTelegramId)
        .first<Row>();
      return r ? clientFromRow(r) : null;
    } catch (e) {
      if (isUniqueViolation(e, 'clients.telegram_id')) return null; // this Telegram account got its own card meanwhile
      throw e;
    }
  }

  /** TEST_MODE: remove a client with all its facts (ledger delete guard lifted inside the batch). */
  async deleteClient(id: string): Promise<void> {
    await this.db.batch([
      // stats_daily: take everything this client contributed out first (migration 0007).
      ...contributionStmts(this.db, -1, byIds, [JSON.stringify([id])]),
      invalidateBuyersStmt(this.db),
      this.db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_ledger_delete')`),
      this.db.prepare('DELETE FROM points_ledger WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM card_moves WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM rewards WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM purchases WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM notification_keys WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM notifications_log WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM outbox WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM important_dates WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM client_versions WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM client_imports WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM client_stats WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM clients WHERE id = ?').bind(id),
      this.db.prepare(`DELETE FROM maintenance WHERE flag = 'allow_ledger_delete'`),
    ]);
  }

  async allClientIds(): Promise<string[]> {
    const { results } = await this.db.prepare('SELECT id FROM clients ORDER BY created_at').all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async clientContacts(ids: string[]): Promise<Map<string, ClientContact>> {
    const clients = await this.getClientsByIds(ids);
    return new Map(clients.map((c) => [c.id, { id: c.id, telegramId: c.telegramId, language: c.language, name: c.name, demo: c.demo === true }]));
  }

  // ---------------------------------------------------------------- staff

  async findStaffByTelegramId(telegramId: number): Promise<StaffMember | null> {
    const r = await this.db.prepare('SELECT * FROM staff WHERE telegram_id = ?').bind(telegramId).first<Row>();
    return r ? staffFromRow(r) : null;
  }

  async findStaffById(id: string): Promise<StaffMember | null> {
    const r = await this.db.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<Row>();
    return r ? staffFromRow(r) : null;
  }

  async listStaff(): Promise<StaffMember[]> {
    const { results } = await this.db.prepare('SELECT * FROM staff ORDER BY active DESC, created_at').all<Row>();
    return results.map(staffFromRow);
  }

  /**
   * Staff added by phone gets its telegram_id when that person shares the phone
   * with the bot. If that Telegram account already has its own staff row, the
   * two rows are merged into it (role and activity of the phone row win — it is
   * the owner's latest decision) and the phone-only row is removed, so no
   * unreachable "orphan" staff row stays behind.
   */
  async linkStaffByPhone(phone: string, telegramId: number): Promise<void> {
    const byPhone = await this.db.prepare('SELECT * FROM staff WHERE phone = ? AND telegram_id IS NULL').bind(phone).first<Row>();
    if (!byPhone) return;
    const byTg = await this.db.prepare('SELECT * FROM staff WHERE telegram_id = ?').bind(telegramId).first<Row>();
    if (!byTg) {
      await this.db.prepare('UPDATE staff SET telegram_id = ? WHERE id = ?').bind(telegramId, String(byPhone.id)).run();
      return;
    }
    await this.db.batch([
      this.db.prepare('DELETE FROM staff WHERE id = ?').bind(String(byPhone.id)),
      this.db
        .prepare('UPDATE staff SET role = ?, active = ?, phone = COALESCE(phone, ?), name = COALESCE(name, ?) WHERE id = ?')
        .bind(String(byPhone.role), num(byPhone.active), phone, String(byPhone.name), String(byTg.id)),
    ]);
  }

  async findStaffByPhone(phone: string): Promise<StaffMember | null> {
    const r = await this.db.prepare('SELECT * FROM staff WHERE phone = ?').bind(phone).first<Row>();
    return r ? staffFromRow(r) : null;
  }

  async upsertStaff(input: { telegramId: number | null; phone: string | null; name: string; role: StaffRole }, now: Date): Promise<StaffMember> {
    const existing = input.telegramId !== null
      ? await this.db.prepare('SELECT * FROM staff WHERE telegram_id = ?').bind(input.telegramId).first<Row>()
      : await this.db.prepare('SELECT * FROM staff WHERE phone = ?').bind(input.phone).first<Row>();
    if (existing) {
      await this.db
        .prepare('UPDATE staff SET role = ?, active = 1, phone = COALESCE(phone, ?), name = ? WHERE id = ?')
        .bind(input.role, input.phone, input.name || String(existing.name), String(existing.id))
        .run();
      return (await this.findStaffById(String(existing.id)))!;
    }
    const id = crypto.randomUUID();
    await this.db
      .prepare('INSERT INTO staff (id, telegram_id, phone, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .bind(id, input.telegramId, input.phone, input.name, input.role, iso(now))
      .run();
    return (await this.findStaffById(id))!;
  }

  async deactivateStaff(id: string): Promise<StaffMember | null> {
    await this.db.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(id).run();
    return this.findStaffById(id);
  }

  async countActiveOwners(): Promise<number> {
    const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1`).first<{ n: number }>();
    return num(r?.n ?? 0);
  }

  // ---------------------------------------------------------------- TEST_MODE roles

  async getTestRole(telegramId: number): Promise<StaffRole | 'client' | null> {
    const r = await this.db.prepare('SELECT role FROM test_roles WHERE telegram_id = ?').bind(telegramId).first<{ role: string }>();
    return (r?.role as StaffRole | 'client' | undefined) ?? null;
  }

  async setTestRole(telegramId: number, role: StaffRole | 'client', now: Date): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO test_roles (telegram_id, role, updated_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at',
      )
      .bind(telegramId, role, iso(now))
      .run();
  }

  /** Display names of actors: staff ids, or "tg:<telegramId>" for TEST_MODE testers. */
  async actorNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    const staffIds = uniq.filter((x) => !x.startsWith('tg:'));
    const tgIds = uniq.filter((x) => x.startsWith('tg:')).map((x) => Number(x.slice(3)));
    if (staffIds.length) {
      const { results } = await this.db
        .prepare(`SELECT id, name FROM staff WHERE id IN (${staffIds.map(() => '?').join(',')})`)
        .bind(...staffIds)
        .all<{ id: string; name: string }>();
      for (const r of results) out.set(r.id, r.name);
    }
    if (tgIds.length) {
      const { results } = await this.db
        .prepare(`SELECT telegram_id, first_name FROM tg_users WHERE telegram_id IN (${tgIds.map(() => '?').join(',')})`)
        .bind(...tgIds)
        .all<{ telegram_id: number; first_name: string | null }>();
      for (const r of results) out.set(`tg:${r.telegram_id}`, `${r.first_name ?? 'Тестер'} (тест)`);
    }
    return out;
  }

  // ---------------------------------------------------------------- engine state

  private stateStatements(clientId: string): D1PreparedStatement[] {
    return [
      this.db.prepare('SELECT created_at, level_override, level_override_at, level_override_index FROM clients WHERE id = ?').bind(clientId),
      this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM client_versions WHERE client_id = ?').bind(clientId),
      this.db.prepare('SELECT * FROM purchases WHERE client_id = ? ORDER BY created_at, rowid').bind(clientId),
      this.db.prepare('SELECT * FROM points_ledger WHERE client_id = ? ORDER BY rowid').bind(clientId),
      this.db.prepare('SELECT * FROM card_moves WHERE client_id = ? ORDER BY id').bind(clientId),
      this.db.prepare('SELECT * FROM rewards WHERE client_id = ? ORDER BY rowid').bind(clientId),
      this.db.prepare('SELECT key FROM notification_keys WHERE client_id = ? ORDER BY rowid').bind(clientId),
    ];
  }

  /**
   * One round trip (a read batch = a consistent snapshot). With a `hint` (every command and view does
   * this) the state is BOUNDED (db/stateLoader.ts, migration 0010): rows read do not grow with the
   * client's history. Without a hint, or with `full: true`, the whole history (tests, maintenance).
   */
  async loadClientState(clientId: string, hint?: LoadHint & { full?: boolean }): Promise<VersionedState> {
    if (hint && !hint.full) {
      const got = (await this.loadClientStates([clientId], hint)).get(clientId);
      if (!got) throw new Error(`client ${clientId} not found`);
      return got;
    }
    const [client, ver, purchases, ledger, moves, rewards, keys] = await this.db.batch<Row>(this.stateStatements(clientId));
    const c = client!.results[0];
    if (!c) throw new Error(`client ${clientId} not found`);
    const state: ClientState = {
      clientId,
      registeredAt: date(c.created_at),
      levelOverride: overrideFromRow(c),
      purchases: purchases!.results.map(purchaseFromRow),
      ledger: ledger!.results.map(ledgerFromRow),
      cardMoves: moves!.results.map(moveFromRow),
      rewards: rewards!.results.map(rewardFromRow),
      sentNotificationKeys: keys!.results.map((r) => String(r.key)),
    };
    return { state, version: num(ver!.results[0]?.v ?? 0) };
  }

  /**
   * A client's bounded state (unless the caller already has it) and the first history page, in ONE
   * read batch (lib/history.ts).
   */
  async loadStateWithHistory(
    clientId: string,
    hint: LoadHint,
    state?: ClientState,
    limit = HISTORY_PAGE,
  ): Promise<{ state: ClientState; historyRows: Row[] }> {
    if (state) {
      const { results } = await historyStmt(this.db, clientId, limit).all<Row>();
      return { state, historyRows: results };
    }
    const res = await this.db.batch<Row>([historyStmt(this.db, clientId, limit), ...boundedStatements(this.db, [clientId], hint)]);
    const { states, missing } = assembleBounded(res.slice(1) as Array<{ results: Row[] }>, D1Repository.ROW_MAPS);
    const got = states.get(clientId) ?? (missing.length ? await this.loadClientState(clientId) : null);
    if (!got) throw new Error(`client ${clientId} not found`);
    return { state: got.state, historyRows: res[0]!.results };
  }

  /** One page of a client's history (owner card «Показать ещё»). */
  async historyPage(clientId: string, before: HistoryCursor | null, limit = HISTORY_PAGE): Promise<Row[]> {
    return (await historyStmt(this.db, clientId, limit, before).all<Row>()).results;
  }

  private static readonly ROW_MAPS = { purchase: purchaseFromRow, ledger: ledgerFromRow, move: moveFromRow, reward: rewardFromRow, override: overrideFromRow };

  /**
   * Daily job: clients due on `today` (clients.next_check_on <= today), earliest date first, at most
   * `limit`. One range of the index clients_next_check_idx: rows read = rows returned. NULL (nothing
   * pending) is never selected. See lib/expirySchedule.ts.
   */
  async expiryCandidates(today: string, limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM clients WHERE next_check_on <= ? ORDER BY next_check_on LIMIT ?')
      .bind(today, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  /** Statement: store a client's next check date (NULL = nothing pending); writes only on a change. */
  nextCheckStmt(clientId: string, on: string | null): D1PreparedStatement {
    return this.db.prepare('UPDATE clients SET next_check_on = ?1 WHERE id = ?2 AND next_check_on IS NOT ?1').bind(on, clientId);
  }

  /** Daily job: remember when each client must be looked at next (one batch). */
  async setNextChecks(items: Array<{ clientId: string; on: string | null }>): Promise<void> {
    if (!items.length) return;
    await this.db.batch(items.map((i) => this.nextCheckStmt(i.clientId, i.on)));
  }

  /**
   * Several clients' states in one round trip (daily job). Ids travel as ONE JSON parameter. With a
   * `hint` the states are bounded (see loadClientState); a client without a client_stats row (should
   * not happen) is loaded in full by a second round trip.
   */
  async loadClientStates(ids: string[], hint?: LoadHint & { full?: boolean }): Promise<Map<string, VersionedState>> {
    if (ids.length && hint && !hint.full) {
      const res = await this.db.batch<Row>(boundedStatements(this.db, ids, hint));
      const { states, missing } = assembleBounded(res, D1Repository.ROW_MAPS);
      if (missing.length) for (const [id, v] of await this.loadClientStates(missing)) states.set(id, v);
      return states;
    }
    const out = new Map<string, VersionedState>();
    if (!ids.length) return out;
    const json = JSON.stringify(ids);
    const ph = 'SELECT value FROM json_each(?1)';
    const [clients, versions, purchases, ledger, moves, rewards, keys] = await this.db.batch<Row>([
      this.db.prepare(`SELECT id, created_at, level_override, level_override_at, level_override_index FROM clients WHERE id IN (${ph})`).bind(json),
      this.db.prepare(`SELECT client_id, MAX(version) AS v FROM client_versions WHERE client_id IN (${ph}) GROUP BY client_id`).bind(json),
      this.db.prepare(`SELECT * FROM purchases WHERE client_id IN (${ph}) ORDER BY created_at, rowid`).bind(json),
      this.db.prepare(`SELECT * FROM points_ledger WHERE client_id IN (${ph}) ORDER BY rowid`).bind(json),
      this.db.prepare(`SELECT * FROM card_moves WHERE client_id IN (${ph}) ORDER BY id`).bind(json),
      this.db.prepare(`SELECT * FROM rewards WHERE client_id IN (${ph}) ORDER BY rowid`).bind(json),
      this.db.prepare(`SELECT client_id, key FROM notification_keys WHERE client_id IN (${ph}) ORDER BY rowid`).bind(json),
    ]);
    for (const c of clients!.results) {
      const id = String(c.id);
      out.set(id, {
        version: 0,
        state: {
          clientId: id,
          registeredAt: date(c.created_at),
          levelOverride: overrideFromRow(c),
          purchases: [],
          ledger: [],
          cardMoves: [],
          rewards: [],
          sentNotificationKeys: [],
        },
      });
    }
    const get = (r: Row) => out.get(String(r.client_id));
    for (const r of versions!.results) {
      const s = get(r);
      if (s) s.version = num(r.v);
    }
    for (const r of purchases!.results) get(r)?.state.purchases.push(purchaseFromRow(r));
    for (const r of ledger!.results) get(r)?.state.ledger.push(ledgerFromRow(r));
    for (const r of moves!.results) get(r)?.state.cardMoves.push(moveFromRow(r));
    for (const r of rewards!.results) get(r)?.state.rewards.push(rewardFromRow(r));
    for (const r of keys!.results) get(r)?.state.sentNotificationKeys.push(String(r.key));
    return out;
  }

  /**
   * Persist an outcome atomically with an optimistic version check.
   * Statement order respects foreign keys: purchase before its ledger rows / card moves.
   */
  async saveOutcome(clientId: string, o: Outcome, expectedVersion: number, after?: SavedState): Promise<void> {
    if (o.replayed) return;
    try {
      await this.db.batch(this.outcomeStmts(clientId, o, expectedVersion, after));
    } catch (e) {
      throw D1Repository.mapWriteError(e);
    }
  }

  /** Version conflict → ConcurrencyError, duplicate purchase key → IDEMPOTENCY_CONFLICT, else as is. */
  static mapWriteError(e: unknown): unknown {
    if (isVersionConflict(e)) return new ConcurrencyError();
    if (isUniqueViolation(e, 'purchases.idempotency_key')) {
      return new LoyaltyError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for another client');
    }
    return e;
  }

  /**
   * The statements of saveOutcome (version check first). The daily job concatenates several
   * clients' statements into ONE batch (cron.ts); a conflict then rolls back the whole batch.
   */
  outcomeStmts(clientId: string, o: Outcome, expectedVersion: number, after?: SavedState): D1PreparedStatement[] {
    const db = this.db;
    const stmts: D1PreparedStatement[] = [
      db.prepare('INSERT INTO client_versions (client_id, version) VALUES (?, ?)').bind(clientId, expectedVersion + 1),
    ];
    // stats_daily (migration 0007): rows whose status may change contribute −before … +after.
    const purchaseDay = o.purchase ? tashkentDay(o.purchase.createdAt) : null;
    const giftIds = [...new Set([...o.rewardsUpdated, ...o.rewardsUnlocked].map((r) => r.id))];
    if (o.purchase) stmts.push(...purchaseContribution(db, -1, o.purchase.id, clientId, purchaseDay!));
    stmts.push(...rewardsContribution(db, -1, giftIds));
    if (o.purchase) stmts.push(this.purchaseUpsertStmt(clientId, o.purchase));
    for (const e of o.ledger) stmts.push(this.ledgerInsertStmt(clientId, e));
    for (const m of o.cardMovesReverted) {
      stmts.push(
        db
          .prepare(
            `UPDATE card_moves SET reverted_at = ?
             WHERE client_id = ? AND purchase_id IS ? AND cycle = ? AND cell = ? AND reason = ? AND reverted_at IS NULL`,
          )
          .bind(iso(m.revertedAt ?? new Date(0)), clientId, m.purchaseId, m.cycle, m.cell, m.reason),
      );
    }
    for (const m of o.cardMoves) stmts.push(this.cardMoveInsertStmt(clientId, m));
    for (const r of o.rewardsUpdated) {
      stmts.push(
        db
          .prepare('UPDATE rewards SET status = ?, used_in_purchase = ?, used_idempotency_key = ?, used_at = ? WHERE id = ? AND client_id = ?')
          .bind(r.status, r.usedInPurchase, r.usedIdempotencyKey ?? null, isoOrNull(r.usedAt), r.id, clientId),
      );
    }
    for (const r of o.rewardsUnlocked) stmts.push(this.rewardInsertStmt(clientId, r));
    if (o.levelOverride !== undefined) {
      stmts.push(
        db
          .prepare('UPDATE clients SET level_override = ?, level_override_at = ?, level_override_index = ? WHERE id = ?')
          .bind(o.levelOverride?.levelId ?? null, isoOrNull(o.levelOverride?.setAt ?? null), o.levelOverride?.levelIndex ?? null, clientId),
      );
    }
    const keyAt = iso(new Date());
    for (const k of o.notificationKeys) stmts.push(this.notificationKeyInsertStmt(clientId, k, keyAt));
    // The daily job's schedule (lib/expirySchedule.ts), computed precisely from the state after
    // this write: the next reminder / expiry date, or NULL if nothing is pending. Without the
    // after-state the client is simply due today (the job then stores the exact date).
    if (after) stmts.push(this.nextCheckStmt(clientId, nextCheckOn(after.rules, after.state, after.now)));
    else stmts.push(db.prepare('UPDATE clients SET next_check_on = ?1 WHERE id = ?2').bind(new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10), clientId));
    if (o.purchase) stmts.push(...purchaseContribution(db, 1, o.purchase.id, clientId, purchaseDay!), invalidateBuyersStmt(db, purchaseDay!));
    stmts.push(...rewardsContribution(db, 1, giftIds), ...ledgerStmts(db, o.ledger));
    // Denormalized summary for the owner's client list, in the SAME transaction as the facts.
    if (after) stmts.push(this.statsUpsertStmt(clientId, computeClientStats(after.rules, after.state, after.now), after.now));
    else stmts.push(this.statsFromSqlStmt(clientId));
    return stmts;
  }

  // ---------------------------------------------------------------- row statements (saveOutcome, demo seeding)

  /** Insert a purchase, or update its status/result if it exists (reversal). */
  purchaseUpsertStmt(clientId: string, p: PurchaseRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO purchases (id, client_id, staff_id, amount, lines, channel, points_redeemed, discount_applied,
           reward_used_id, idempotency_key, rules_version_id, result, status, reversed_reason, reversed_by, reversed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, reversed_reason = excluded.reversed_reason,
           reversed_by = excluded.reversed_by, reversed_at = excluded.reversed_at, result = excluded.result`,
      )
      .bind(
        p.id,
        clientId,
        p.staffId,
        p.amount,
        JSON.stringify(p.lines),
        p.channel,
        p.pointsRedeemed,
        p.discountApplied,
        p.rewardUsedId,
        p.idempotencyKey,
        p.rulesVersion,
        p.result ? JSON.stringify(p.result) : null,
        p.status,
        p.reversedReason,
        p.reversedBy,
        isoOrNull(p.reversedAt),
        iso(p.createdAt),
      );
  }

  ledgerInsertStmt(clientId: string, e: LedgerEntry): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.id ?? crypto.randomUUID(), clientId, e.type, e.amount, e.purchaseId, e.staffId, e.reason, e.idempotencyKey ?? null, iso(e.createdAt));
  }

  cardMoveInsertStmt(clientId: string, m: CardMove): D1PreparedStatement {
    return this.db
      .prepare('INSERT INTO card_moves (client_id, purchase_id, cycle, cell, reason, reverted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(clientId, m.purchaseId, m.cycle, m.cell, m.reason, isoOrNull(m.revertedAt), iso(m.createdAt));
  }

  rewardInsertStmt(clientId: string, r: Reward): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO rewards (id, client_id, cycle, cell, type, value, title, status, unlocked_by_purchase, used_in_purchase,
           used_idempotency_key, unlocked_at, used_at, granted_by, grant_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        clientId,
        r.cycle,
        r.cell,
        r.type,
        r.value,
        r.title,
        r.status,
        r.unlockedByPurchase,
        r.usedInPurchase,
        r.usedIdempotencyKey ?? null,
        iso(r.unlockedAt),
        isoOrNull(r.usedAt),
        r.grantedBy ?? null,
        r.grantReason ?? null,
      );
  }

  notificationKeyInsertStmt(clientId: string, key: string, at: string): D1PreparedStatement {
    return this.db.prepare('INSERT OR IGNORE INTO notification_keys (client_id, key, created_at) VALUES (?, ?, ?)').bind(clientId, key, at);
  }

  async findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null> {
    const r = await this.db.prepare('SELECT * FROM purchases WHERE id = ?').bind(purchaseId).first<Row>();
    return r ? purchaseFromRow(r) : null;
  }

  async findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null> {
    const r = await this.db.prepare('SELECT * FROM purchases WHERE idempotency_key = ?').bind(key).first<Row>();
    return r ? purchaseFromRow(r) : null;
  }

  async findRewardById(id: string): Promise<Reward | null> {
    const r = await this.db.prepare('SELECT * FROM rewards WHERE id = ?').bind(id).first<Row>();
    return r ? rewardFromRow(r) : null;
  }

  // ---------------------------------------------------------------- client summaries (client_stats, migration 0004)

  statsUpsertStmt(clientId: string, st: ClientStats, now: Date): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at, level_sum, level_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           balance = excluded.balance, spent = excluded.spent, purchases_count = excluded.purchases_count,
           last_purchase_at = excluded.last_purchase_at, level_id = excluded.level_id, gifts_available = excluded.gifts_available,
           activity_at = excluded.activity_at, expires_on = excluded.expires_on, updated_at = excluded.updated_at,
           level_sum = excluded.level_sum, level_count = excluded.level_count`,
      )
      .bind(clientId, st.balance, st.spent, st.purchasesCount, st.lastPurchaseAt, st.levelId, st.giftsAvailable, st.activityAt, st.expiresOn, iso(now), st.levelSum, st.levelCount);
  }

  /**
   * Fallback when a caller saves an outcome without the after-state: refresh the columns
   * SQL can derive cheaply from this client's rows (level / expiry stay until the next full write).
   */
  private statsFromSqlStmt(clientId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE client_stats SET
           balance = COALESCE((SELECT SUM(amount) FROM points_ledger WHERE client_id = ?1), 0),
           purchases_count = (SELECT COUNT(*) FROM purchases WHERE client_id = ?1 AND status = 'active'),
           last_purchase_at = COALESCE((SELECT MAX(created_at) FROM purchases WHERE client_id = ?1 AND status = 'active'), ''),
           gifts_available = (SELECT COUNT(*) FROM rewards WHERE client_id = ?1 AND status = 'available'),
           level_sum = COALESCE((SELECT SUM(p.amount) FROM purchases p JOIN clients c ON c.id = p.client_id WHERE p.client_id = ?1 AND p.status = 'active'
                                 AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)), 0),
           level_count = (SELECT COUNT(*) FROM purchases p JOIN clients c ON c.id = p.client_id WHERE p.client_id = ?1 AND p.status = 'active'
                          AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at))
         WHERE client_id = ?1`,
      )
      .bind(clientId);
  }

  /** New rules version: recompute level_id (from spent / override) and expires_on (from activity_at) in SQL. */
  private statsRulesStmts(rules: LoyaltyRules): D1PreparedStatement[] {
    const level = `(SELECT json_extract(t.value, '$.id') FROM json_each(?1, '$.levels.tiers') t
        WHERE CAST(json_extract(t.value, '$.threshold') AS INTEGER) <= client_stats.spent
           OR json_extract(t.value, '$.id') = (SELECT level_override FROM clients WHERE id = client_stats.client_id)
        ORDER BY CAST(json_extract(t.value, '$.threshold') AS INTEGER) DESC LIMIT 1)`;
    const exp = `date(activity_at, '+5 hours', '+' || (?1 - 1) || ' days')`;
    return [
      this.db.prepare(`UPDATE client_stats SET level_id = ${level} WHERE level_id IS NOT ${level}`).bind(JSON.stringify(rules)),
      this.db
        .prepare(`UPDATE client_stats SET expires_on = ${exp} WHERE balance > 0 AND activity_at <> '' AND expires_on IS NOT ${exp}`)
        .bind(rules.expiry.expiryDays),
    ];
  }

  /**
   * One page of the owner's client list: clients ⋈ client_stats, keyset pagination on
   * (sort column, id). The join order is forced (CROSS JOIN) so SQLite walks the index of
   * the sort column and stops after `limit` rows: O(page), not O(clients). Free-text filters
   * (name / phone substring) may scan further until the page is full.
   */
  async listClients(q: ClientListQuery): Promise<ClientListRow[]> {
    const sort = SORTS[q.sort];
    const where: string[] = [];
    const vals: unknown[] = [];
    const add = (sql: string, ...v: unknown[]) => {
      where.push(sql);
      vals.push(...v);
    };
    // Filter columns are prefixed with unary "+" so SQLite never picks a filter index and then
    // sorts every match: it always walks the sort index and stops after `limit` matches.
    if (q.code) add('c.code = ?', q.code);
    if (q.phone) add(`c.phone IS NOT NULL AND instr(replace(c.phone, '+', ''), ?) > 0`, q.phone);
    if (q.names?.length) add(`(${q.names.map(() => 'instr(c.name, ?) > 0').join(' OR ')})`, ...q.names);
    if (q.levelId) add('+s.level_id = ?', q.levelId);
    if (q.lastFrom) add('+s.last_purchase_at >= ?', q.lastFrom);
    if (q.lastBefore) add('+s.last_purchase_at < ?', q.lastBefore);
    if (q.expiresFrom) add(`+s.expires_on <> '' AND +s.expires_on >= ?`, q.expiresFrom);
    if (q.expiresTo) add(`+s.expires_on <> '' AND +s.expires_on <= ?`, q.expiresTo);
    if (q.birthdays?.length) add(`substr(c.birthday, 6, 5) IN (${q.birthdays.map(() => '?').join(',')})`, ...q.birthdays);
    if (q.after) add(`(${sort.col}, c.id) ${sort.desc ? '<' : '>'} (?, ?)`, q.after.value, q.after.id);
    const dir = sort.desc ? 'DESC' : 'ASC';
    // The id tie-breaker uses the column of the driving table so the (col, id) index serves the ORDER BY.
    // An exact code matches at most one client: drive from the unique index of clients.code.
    const drive = q.code ? 'clients' : sort.drive;
    const idCol = drive === 'stats' ? 's.client_id' : 'c.id';
    const from = drive === 'stats'
      ? 'client_stats s CROSS JOIN clients c ON c.id = s.client_id'
      : 'clients c CROSS JOIN client_stats s ON s.client_id = c.id';
    const sql = `SELECT c.id, c.name, c.phone, c.code, c.language, c.created_at, c.note,
        s.balance, s.spent, s.purchases_count, s.last_purchase_at, s.level_id, s.gifts_available, s.expires_on
      FROM ${from}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${sort.col} ${dir}, ${idCol} ${dir} LIMIT ?`;
    const { results } = await this.db.prepare(sql).bind(...vals, q.limit).all<Row>();
    return results.map(listRowFromRow);
  }

  /** Client profile + note + stored summary + BOUNDED engine state, one read batch (consistent snapshot). */
  async loadClientCard(id: string, hint: LoadHint = {}): Promise<ClientCard | null> {
    const [client, stats, ...rest] = await this.db.batch<Row>([
      this.db.prepare('SELECT * FROM clients WHERE id = ?').bind(id),
      this.db.prepare('SELECT * FROM client_stats WHERE client_id = ?').bind(id),
      ...boundedStatements(this.db, [id], hint),
    ]);
    const c = client!.results[0];
    if (!c) return null;
    const { states } = assembleBounded(rest as Array<{ results: Row[] }>, D1Repository.ROW_MAPS);
    const versioned = states.get(id) ?? (await this.loadClientState(id));
    return {
      client: clientFromRow(c),
      note: str(c.note),
      stats: stats!.results[0] ? statsFromRow(stats!.results[0]) : null,
      versioned,
    };
  }

  /**
   * Self-healing: rewrite a client's summary computed from the full state of `version`,
   * only if nobody saved a newer version meanwhile (a newer save wrote newer stats).
   */
  async healStats(clientId: string, stats: ClientStats, version: number, now: Date): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at, level_sum, level_count)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, ?13
         WHERE (SELECT COALESCE(MAX(version), 0) FROM client_versions WHERE client_id = ?1) = ?11
         ON CONFLICT(client_id) DO UPDATE SET
           balance = excluded.balance, spent = excluded.spent, purchases_count = excluded.purchases_count,
           last_purchase_at = excluded.last_purchase_at, level_id = excluded.level_id, gifts_available = excluded.gifts_available,
           activity_at = excluded.activity_at, expires_on = excluded.expires_on, updated_at = excluded.updated_at,
           level_sum = excluded.level_sum, level_count = excluded.level_count`,
      )
      .bind(clientId, stats.balance, stats.spent, stats.purchasesCount, stats.lastPurchaseAt, stats.levelId, stats.giftsAvailable, stats.activityAt, stats.expiresOn, iso(now), version, stats.levelSum, stats.levelCount)
      .run();
  }

  /**
   * Rebuild stats_daily from the raw rows (tests / maintenance: fixtures written with raw SQL).
   * O(all rows): never on a request path.
   */
  async rebuildDailyStats(): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM stats_daily'),
      invalidateBuyersStmt(this.db),
      ...contributionStmts(this.db, 1, () => '1'),
    ]);
  }

  /** Returns false if the client does not exist. */
  async setClientNote(id: string, note: string | null): Promise<boolean> {
    const r = await this.db.prepare('UPDATE clients SET note = ? WHERE id = ?').bind(note, id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  // ---------------------------------------------------------------- CSV export

  /** One-time export link; expired links are pruned in the same batch. */
  async createExportLink(token: string, kind: string, params: Record<string, string>, createdBy: string, now: Date, expiresAt: Date): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM export_links WHERE expires_at < ?').bind(iso(now)),
      this.db
        .prepare('INSERT INTO export_links (token, kind, params, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(token, kind, JSON.stringify(params), createdBy, iso(now), iso(expiresAt)),
    ]);
  }

  /**
   * Atomically marks a link used; null if unknown, expired, already used or made for another
   * file (`kind`): a link opened on the wrong export path is NOT consumed.
   */
  async consumeExportLink(token: string, now: Date, kind: string): Promise<{ kind: string; params: Record<string, string> } | null> {
    const r = await this.db
      .prepare('UPDATE export_links SET used_at = ?1 WHERE token = ?2 AND kind = ?3 AND used_at IS NULL AND expires_at > ?1 RETURNING kind, params')
      .bind(iso(now), token, kind)
      .first<{ kind: string; params: string }>();
    return r ? { kind: r.kind, params: JSON.parse(r.params) as Record<string, string> } : null;
  }

  /** Clients for the CSV export in registration order, keyset after (createdAt, id). */
  async exportClientsChunk(after: { createdAt: string; id: string } | null, limit: number): Promise<ClientListRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.code, c.language, c.created_at, c.note,
           s.balance, s.spent, s.purchases_count, s.last_purchase_at, s.level_id, s.gifts_available, s.expires_on
         FROM clients c LEFT JOIN client_stats s ON s.client_id = c.id
         WHERE (c.created_at, c.id) > (?, ?)
         ORDER BY c.created_at, c.id LIMIT ?`,
      )
      .bind(after?.createdAt ?? '', after?.id ?? '', limit)
      .all<Row>();
    return results.map(listRowFromRow);
  }

  /**
   * Operations in [?1, ?2) strictly after (?1, ?3): one SELECT per source, each through its
   * time index. With `limit` every source takes only its first ?4 rows, so a chunk reads
   * O(limit) rows however long the range is.
   */
  private static opsRange(limited: boolean): string {
    const lim = (at: string, id: string) => (limited ? ` ORDER BY ${at}, ${id} LIMIT ?4` : '');
    const wrap = (sql: string) => (limited ? `SELECT * FROM (${sql})` : sql);
    return [
      wrap(`SELECT p.id AS id, p.created_at AS at, 'purchase' AS kind,
        (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type IN ('accrual', 'redeem')) AS points,
        p.client_id AS client_id, p.staff_id AS staff_id, p.amount AS purchase_amount, p.status AS status, NULL AS reason
      FROM purchases p WHERE p.created_at >= ?1 AND p.created_at < ?2 AND (p.created_at > ?1 OR p.id > ?3)${lim('p.created_at', 'p.id')}`),
      wrap(`SELECT 'rev-' || p.id AS id, p.reversed_at AS at, 'reversal' AS kind,
        (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type = 'reversal') AS points,
        p.client_id AS client_id, p.reversed_by AS staff_id, p.amount AS purchase_amount, p.status AS status, p.reversed_reason AS reason
      FROM purchases p WHERE p.status = 'reversed' AND p.reversed_at >= ?1 AND p.reversed_at < ?2
        AND (p.reversed_at > ?1 OR 'rev-' || p.id > ?3)${lim('p.reversed_at', "'rev-' || p.id")}`),
      wrap(`SELECT l.id AS id, l.created_at AS at,
        CASE l.type WHEN 'welcome' THEN 'welcome' WHEN 'redeem' THEN 'redeem' WHEN 'expire' THEN 'expire' ELSE 'manual' END AS kind,
        l.amount AS points, l.client_id AS client_id, l.staff_id AS staff_id, NULL AS purchase_amount, NULL AS status,
        CASE WHEN l.type = 'manual_adjust' THEN l.reason END AS reason
      FROM points_ledger l WHERE l.purchase_id IS NULL AND l.created_at >= ?1 AND l.created_at < ?2
        AND (l.created_at > ?1 OR l.id > ?3)${lim('l.created_at', 'l.id')}`),
      wrap(`SELECT 'gift-' || r.id AS id, r.used_at AS at, 'gift_used' AS kind, 0 AS points, r.client_id AS client_id,
        NULL AS staff_id, NULL AS purchase_amount, NULL AS status, r.title AS reason
      FROM rewards r WHERE r.status = 'used' AND r.used_in_purchase IS NULL AND r.used_at >= ?1 AND r.used_at < ?2
        AND (r.used_at > ?1 OR 'gift-' || r.id > ?3)${lim('r.used_at', "'gift-' || r.id")}`),
      // Gifts the owner granted without a purchase (migration 0006, partial index rewards_granted_idx).
      wrap(`SELECT 'granted-' || r.id AS id, r.unlocked_at AS at, 'gift_granted' AS kind, 0 AS points, r.client_id AS client_id,
        r.granted_by AS staff_id, NULL AS purchase_amount, NULL AS status, r.title || COALESCE(': ' || r.grant_reason, '') AS reason
      FROM rewards r WHERE r.granted_by IS NOT NULL AND r.unlocked_at >= ?1 AND r.unlocked_at < ?2
        AND (r.unlocked_at > ?1 OR 'granted-' || r.id > ?3)${lim('r.unlocked_at', "'granted-' || r.id")}`),
    ].join('\n      UNION ALL\n      ');
  }

  async countOperations(fromIso: string, toIso: string): Promise<number> {
    const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM (${D1Repository.opsRange(false)})`).bind(fromIso, toIso, '').first<{ n: number }>();
    return num(r?.n ?? 0);
  }

  /**
   * One chunk of operations, oldest first, strictly after (afterAt, afterId) and before toIso.
   * Client fields and actor names are joined in, so a chunk is exactly one query.
   */
  async operationsChunk(afterAt: string, afterId: string, toIso: string, limit: number): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT x.*, c.name AS client_name, c.code AS client_code, c.phone AS client_phone,
           COALESCE(st.name, CASE WHEN tu.telegram_id IS NOT NULL THEN COALESCE(tu.first_name, 'Тестер') || ' (тест)' END) AS staff_name
         FROM (${D1Repository.opsRange(true)} ORDER BY at, id LIMIT ?4) x
         JOIN clients c ON c.id = x.client_id
         LEFT JOIN staff st ON st.id = x.staff_id
         LEFT JOIN tg_users tu ON x.staff_id LIKE 'tg:%' AND tu.telegram_id = CAST(substr(x.staff_id, 4) AS INTEGER)
         ORDER BY x.at, x.id`,
      )
      .bind(afterAt, toIso, afterId, limit)
      .all<Row>();
    return results;
  }

  // ---------------------------------------------------------------- reports

  /**
   * Operations of all clients, newest first (staff "recent" list, owner journal).
   * Each source takes only its newest `limit` rows through an index (migrations
   * 0001/0003), so the cost is O(limit), not O(all purchases).
   */
  async operations(limit: number): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM (
           SELECT p.id AS id, p.created_at AS at, 'purchase' AS kind,
             (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type IN ('accrual', 'redeem')) AS points,
             p.client_id AS client_id, c.name AS client_name, p.staff_id AS staff_id, p.id AS purchase_id, p.amount AS purchase_amount, p.status AS status,
             NULL AS reason,
             -- can staff still reverse it (item 8)? the balance after the reversal and "its gift was used"
             (SELECT s.balance FROM client_stats s WHERE s.client_id = p.client_id) + p.points_redeemed - COALESCE(json_extract(p.result, '$.cashback'), 0) AS rev_balance,
             EXISTS (SELECT 1 FROM rewards r WHERE r.unlocked_by_purchase = p.id AND r.status = 'used') AS rev_gift_used
           FROM (SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?1) p JOIN clients c ON c.id = p.client_id
           UNION ALL
           SELECT 'rev-' || p.id, p.reversed_at, 'reversal',
             (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type = 'reversal'),
             p.client_id, c.name, p.reversed_by, p.id, p.amount, p.status, p.reversed_reason, NULL, NULL
           FROM (SELECT * FROM purchases WHERE status = 'reversed' ORDER BY reversed_at DESC LIMIT ?1) p JOIN clients c ON c.id = p.client_id
           UNION ALL
           SELECT l.id, l.created_at,
             CASE l.type WHEN 'welcome' THEN 'welcome' WHEN 'redeem' THEN 'redeem' WHEN 'expire' THEN 'expire' ELSE 'manual' END,
             l.amount, l.client_id, c.name, l.staff_id, NULL, NULL, NULL, CASE l.type WHEN 'manual_adjust' THEN l.reason END, NULL, NULL
           FROM (SELECT * FROM points_ledger WHERE purchase_id IS NULL ORDER BY created_at DESC LIMIT ?1) l JOIN clients c ON c.id = l.client_id
           UNION ALL
           SELECT 'gift-' || r.id, r.used_at, 'gift_used', 0, r.client_id, c.name, NULL, NULL, NULL, NULL, NULL, NULL, NULL
           FROM (SELECT * FROM rewards WHERE status = 'used' AND used_in_purchase IS NULL ORDER BY used_at DESC LIMIT ?1) r JOIN clients c ON c.id = r.client_id
           UNION ALL
           SELECT 'granted-' || r.id, r.unlocked_at, 'gift_granted', 0, r.client_id, c.name, r.granted_by, NULL, NULL, NULL, r.grant_reason, NULL, NULL
           FROM (SELECT * FROM rewards WHERE granted_by IS NOT NULL ORDER BY unlocked_at DESC LIMIT ?1) r JOIN clients c ON c.id = r.client_id
         ) ORDER BY at DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<Row>();
    return results;
  }

  /** Persist bot message attempts, one batch. Never throws. */
  async logNotifications(entries: NotificationLogEntry[]): Promise<void> {
    if (!entries.length) return;
    try {
      const at = iso(new Date());
      await this.db.batch(
        entries.map((entry) =>
          this.db
            .prepare('INSERT INTO notifications_log (client_id, telegram_id, types, text, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(entry.clientId, entry.telegramId, entry.types, entry.text, entry.status, entry.error ?? null, at),
        ),
      );
    } catch (e) {
      console.error('notifications_log insert failed', e);
    }
  }

  /** Persist one bot message attempt. Never throws. */
  async logNotification(entry: NotificationLogEntry): Promise<void> {
    await this.logNotifications([entry]);
  }

  /** Tests / TEST_MODE: wipe all data (keeps the schema and rules version 1). */
  async wipeAll(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_ledger_delete')`),
      ...[
        'points_ledger', 'card_moves', 'rewards', 'purchases', 'client_versions', 'notification_keys',
        'notifications_log', 'outbox', 'important_dates', 'client_stats', 'export_links', 'client_imports', 'import_updates', 'clients', 'staff', 'test_roles', 'tg_users',
        'system_events', 'cron_runs', 'import_batches', 'web_link_tokens', 'web_session_versions', 'stats_daily', 'stats_buyers',
      ].map((t) => this.db.prepare(`DELETE FROM ${t}`)),
      this.db.prepare('DELETE FROM rules_versions WHERE id <> 1'),
      this.db.prepare(`DELETE FROM settings WHERE key NOT IN ('rules_version', 'clock_offset_days')`),
      this.db.prepare(`UPDATE settings SET value = '0' WHERE key = 'clock_offset_days'`),
      this.db.prepare(`UPDATE settings SET value = '1' WHERE key = 'rules_version'`),
      this.db.prepare(`DELETE FROM maintenance WHERE flag = 'allow_ledger_delete'`),
    ]);
    this.rulesCache = null;
  }
}
