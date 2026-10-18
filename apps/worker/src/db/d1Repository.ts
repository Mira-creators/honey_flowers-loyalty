import {
  defaultRules,
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

  /** TEST_MODE: set the clock offset; every client goes back to the daily job's queue. */
  async setClockOffsetDays(days: number): Promise<void> {
    await this.db.batch([
      this.setSettingStmt('clock_offset_days', String(days)),
      this.db.prepare('UPDATE clients SET next_check_on = NULL WHERE next_check_on IS NOT NULL'),
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
    try {
      await this.db.batch([
        this.db
          .prepare('INSERT INTO rules_versions (id, rules, active_from, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(rules.version, JSON.stringify(rules), iso(now), createdBy, iso(new Date())),
        this.setSettingStmt('rules_version', String(rules.version)),
        // Expiry days / warning days may have changed: every client is re-checked by the next daily run.
        this.db.prepare('UPDATE clients SET next_check_on = NULL WHERE next_check_on IS NOT NULL'),
        // client_stats: level thresholds / expiry days may have changed (only changed rows are written).
        ...this.statsRulesStmts(rules),
      ]);
    } catch (e) {
      if (isUniqueViolation(e, 'rules_versions')) throw new ConcurrencyError('rules were changed concurrently');
      throw e;
    }
    this.rulesCache = null;
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
    for (let attempt = 0; attempt < 15; attempt++) {
      const digits = attempt < 6 ? 4 : attempt < 11 ? 5 : 6;
      const code = `HF${randomDigits(digits)}`;
      try {
        await this.db.batch([
          this.db
            .prepare(
              `INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(id, input.telegramId, code, input.phone, input.name, input.language === 'uz' ? 'uz' : 'ru', isoOrNull(input.consentAt), iso(input.createdAt)),
          this.statsUpsertStmt(id, stats, input.createdAt),
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

  /** TEST_MODE: remove a client with all its facts (ledger delete guard lifted inside the batch). */
  async deleteClient(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_ledger_delete')`),
      this.db.prepare('DELETE FROM points_ledger WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM card_moves WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM rewards WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM purchases WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM notification_keys WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM notifications_log WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM important_dates WHERE client_id = ?').bind(id),
      this.db.prepare('DELETE FROM client_versions WHERE client_id = ?').bind(id),
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
    return new Map(clients.map((c) => [c.id, { id: c.id, telegramId: c.telegramId, language: c.language, name: c.name }]));
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

  /** One round trip (a read batch = a consistent snapshot). */
  async loadClientState(clientId: string): Promise<VersionedState> {
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
   * Daily job: clients due on `today` (clients.next_check_on IS NULL or <= today),
   * oldest first, at most `limit`. See migrations/0003 and lib/expirySchedule.ts.
   */
  async expiryCandidates(today: string, limit: number): Promise<string[]> {
    // Two index ranges (IS NULL, <= today) instead of an OR, so SQLite never scans the table.
    const { results } = await this.db
      .prepare(
        `SELECT id FROM (
           SELECT id, next_check_on, created_at FROM clients WHERE next_check_on IS NULL
           UNION ALL
           SELECT id, next_check_on, created_at FROM clients WHERE next_check_on <= ?
         ) ORDER BY next_check_on, created_at LIMIT ?`,
      )
      .bind(today, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  /** Daily job: remember when each client must be looked at next (one batch). */
  async setNextChecks(items: Array<{ clientId: string; on: string }>): Promise<void> {
    if (!items.length) return;
    await this.db.batch(items.map((i) => this.db.prepare('UPDATE clients SET next_check_on = ? WHERE id = ?').bind(i.on, i.clientId)));
  }

  /** Bulk load of several clients' states in one round trip (daily job; <= 90 ids per call). */
  async loadClientStates(ids: string[]): Promise<Map<string, VersionedState>> {
    const out = new Map<string, VersionedState>();
    if (!ids.length) return out;
    if (ids.length > 90) throw new Error('loadClientStates: at most 90 ids per call (D1 bound parameter limit)');
    const ph = ids.map(() => '?').join(',');
    const [clients, versions, purchases, ledger, moves, rewards, keys] = await this.db.batch<Row>([
      this.db.prepare(`SELECT id, created_at, level_override, level_override_at, level_override_index FROM clients WHERE id IN (${ph})`).bind(...ids),
      this.db.prepare(`SELECT client_id, MAX(version) AS v FROM client_versions WHERE client_id IN (${ph}) GROUP BY client_id`).bind(...ids),
      this.db.prepare(`SELECT * FROM purchases WHERE client_id IN (${ph}) ORDER BY created_at, rowid`).bind(...ids),
      this.db.prepare(`SELECT * FROM points_ledger WHERE client_id IN (${ph}) ORDER BY rowid`).bind(...ids),
      this.db.prepare(`SELECT * FROM card_moves WHERE client_id IN (${ph}) ORDER BY id`).bind(...ids),
      this.db.prepare(`SELECT * FROM rewards WHERE client_id IN (${ph}) ORDER BY rowid`).bind(...ids),
      this.db.prepare(`SELECT client_id, key FROM notification_keys WHERE client_id IN (${ph}) ORDER BY rowid`).bind(...ids),
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
    const db = this.db;
    const stmts: D1PreparedStatement[] = [
      db.prepare('INSERT INTO client_versions (client_id, version) VALUES (?, ?)').bind(clientId, expectedVersion + 1),
    ];
    if (o.purchase) {
      const p = o.purchase;
      stmts.push(
        db
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
          ),
      );
    }
    for (const e of o.ledger) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO points_ledger (id, client_id, type, amount, purchase_id, staff_id, reason, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(e.id ?? crypto.randomUUID(), clientId, e.type, e.amount, e.purchaseId, e.staffId, e.reason, e.idempotencyKey ?? null, iso(e.createdAt)),
      );
    }
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
    for (const m of o.cardMoves) {
      stmts.push(
        db
          .prepare('INSERT INTO card_moves (client_id, purchase_id, cycle, cell, reason, reverted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(clientId, m.purchaseId, m.cycle, m.cell, m.reason, isoOrNull(m.revertedAt), iso(m.createdAt)),
      );
    }
    for (const r of o.rewardsUpdated) {
      stmts.push(
        db
          .prepare('UPDATE rewards SET status = ?, used_in_purchase = ?, used_idempotency_key = ?, used_at = ? WHERE id = ? AND client_id = ?')
          .bind(r.status, r.usedInPurchase, r.usedIdempotencyKey ?? null, isoOrNull(r.usedAt), r.id, clientId),
      );
    }
    for (const r of o.rewardsUnlocked) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO rewards (id, client_id, cycle, cell, type, value, title, status, unlocked_by_purchase, used_in_purchase,
               used_idempotency_key, unlocked_at, used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      );
    }
    if (o.levelOverride !== undefined) {
      stmts.push(
        db
          .prepare('UPDATE clients SET level_override = ?, level_override_at = ?, level_override_index = ? WHERE id = ?')
          .bind(o.levelOverride?.levelId ?? null, isoOrNull(o.levelOverride?.setAt ?? null), o.levelOverride?.levelIndex ?? null, clientId),
      );
    }
    const keyAt = iso(new Date());
    for (const k of o.notificationKeys) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO notification_keys (client_id, key, created_at) VALUES (?, ?, ?)').bind(clientId, k, keyAt));
    }
    // Any change of the facts that drive expiry (purchase, credit, refund, reset) sends the
    // client back to the daily job's queue; the job then stores the next relevant date.
    if (o.purchase || o.ledger.length || o.cardMoves.length || o.levelOverride !== undefined) {
      stmts.push(db.prepare('UPDATE clients SET next_check_on = NULL WHERE id = ?').bind(clientId));
    }
    // Denormalized summary for the owner's client list, in the SAME transaction as the facts.
    if (after) stmts.push(this.statsUpsertStmt(clientId, computeClientStats(after.rules, after.state, after.now), after.now));
    else stmts.push(this.statsFromSqlStmt(clientId));
    try {
      await db.batch(stmts);
    } catch (e) {
      if (isVersionConflict(e)) throw new ConcurrencyError();
      if (isUniqueViolation(e, 'purchases.idempotency_key')) {
        throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for another client');
      }
      throw e;
    }
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
        `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           balance = excluded.balance, spent = excluded.spent, purchases_count = excluded.purchases_count,
           last_purchase_at = excluded.last_purchase_at, level_id = excluded.level_id, gifts_available = excluded.gifts_available,
           activity_at = excluded.activity_at, expires_on = excluded.expires_on, updated_at = excluded.updated_at`,
      )
      .bind(clientId, st.balance, st.spent, st.purchasesCount, st.lastPurchaseAt, st.levelId, st.giftsAvailable, st.activityAt, st.expiresOn, iso(now));
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
           gifts_available = (SELECT COUNT(*) FROM rewards WHERE client_id = ?1 AND status = 'available')
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

  /** Client profile + note + stored summary + full engine state, one read batch (consistent snapshot). */
  async loadClientCard(id: string): Promise<ClientCard | null> {
    const [client, stats, ...rest] = await this.db.batch<Row>([
      this.db.prepare('SELECT * FROM clients WHERE id = ?').bind(id),
      this.db.prepare('SELECT * FROM client_stats WHERE client_id = ?').bind(id),
      ...this.stateStatements(id),
    ]);
    const c = client!.results[0];
    if (!c) return null;
    const [cs, ver, purchases, ledger, moves, rewards, keys] = rest;
    const st = cs!.results[0]!;
    const state: ClientState = {
      clientId: id,
      registeredAt: date(st.created_at),
      levelOverride: overrideFromRow(st),
      purchases: purchases!.results.map(purchaseFromRow),
      ledger: ledger!.results.map(ledgerFromRow),
      cardMoves: moves!.results.map(moveFromRow),
      rewards: rewards!.results.map(rewardFromRow),
      sentNotificationKeys: keys!.results.map((r) => String(r.key)),
    };
    return {
      client: clientFromRow(c),
      note: str(c.note),
      stats: stats!.results[0] ? statsFromRow(stats!.results[0]) : null,
      versioned: { state, version: num(ver!.results[0]?.v ?? 0) },
    };
  }

  /**
   * Self-healing: rewrite a client's summary computed from the full state of `version`,
   * only if nobody saved a newer version meanwhile (a newer save wrote newer stats).
   */
  async healStats(clientId: string, stats: ClientStats, version: number, now: Date): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE (SELECT COALESCE(MAX(version), 0) FROM client_versions WHERE client_id = ?1) = ?11
         ON CONFLICT(client_id) DO UPDATE SET
           balance = excluded.balance, spent = excluded.spent, purchases_count = excluded.purchases_count,
           last_purchase_at = excluded.last_purchase_at, level_id = excluded.level_id, gifts_available = excluded.gifts_available,
           activity_at = excluded.activity_at, expires_on = excluded.expires_on, updated_at = excluded.updated_at`,
      )
      .bind(clientId, stats.balance, stats.spent, stats.purchasesCount, stats.lastPurchaseAt, stats.levelId, stats.giftsAvailable, stats.activityAt, stats.expiresOn, iso(now), version)
      .run();
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

  /** Atomically marks a link used; null if unknown, expired or already used. */
  async consumeExportLink(token: string, now: Date): Promise<{ kind: string; params: Record<string, string> } | null> {
    const r = await this.db
      .prepare('UPDATE export_links SET used_at = ?1 WHERE token = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING kind, params')
      .bind(iso(now), token)
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
             p.client_id AS client_id, c.name AS client_name, p.staff_id AS staff_id, p.id AS purchase_id, p.amount AS purchase_amount, p.status AS status
           FROM (SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?1) p JOIN clients c ON c.id = p.client_id
           UNION ALL
           SELECT 'rev-' || p.id, p.reversed_at, 'reversal',
             (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type = 'reversal'),
             p.client_id, c.name, p.reversed_by, p.id, p.amount, p.status
           FROM (SELECT * FROM purchases WHERE status = 'reversed' ORDER BY reversed_at DESC LIMIT ?1) p JOIN clients c ON c.id = p.client_id
           UNION ALL
           SELECT l.id, l.created_at,
             CASE l.type WHEN 'welcome' THEN 'welcome' WHEN 'redeem' THEN 'redeem' WHEN 'expire' THEN 'expire' ELSE 'manual' END,
             l.amount, l.client_id, c.name, l.staff_id, NULL, NULL, NULL
           FROM (SELECT * FROM points_ledger WHERE purchase_id IS NULL ORDER BY created_at DESC LIMIT ?1) l JOIN clients c ON c.id = l.client_id
           UNION ALL
           SELECT 'gift-' || r.id, r.used_at, 'gift_used', 0, r.client_id, c.name, NULL, NULL, NULL, NULL
           FROM (SELECT * FROM rewards WHERE status = 'used' AND used_in_purchase IS NULL ORDER BY used_at DESC LIMIT ?1) r JOIN clients c ON c.id = r.client_id
         ) ORDER BY at DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<Row>();
    return results;
  }

  /**
   * Owner statistics. Aggregates run in SQL (the weekly histogram is grouped by
   * the Monday of the Tashkent-local week, UTC+5 without DST), so the Worker
   * never materialises purchase rows.
   */
  async statsRows(nowIso: string, since7d: string, since90d: string, since8w: string) {
    const [counts, points, gifts, repeat, weekly] = await this.db.batch<Row>([
      this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM clients) AS clients,
             (SELECT COUNT(*) FROM clients WHERE created_at >= ?) AS clients_new_7d,
             (SELECT COUNT(*) FROM purchases WHERE status = 'active') AS purchases,
             (SELECT COUNT(*) FROM purchases WHERE status = 'active' AND created_at >= ? AND created_at <= ?) AS purchases_7d,
             (SELECT COALESCE(SUM(amount), 0) FROM purchases WHERE status = 'active') AS revenue`,
        )
        .bind(since7d, since7d, nowIso),
      // accrued - redeemed - expired = outstanding (reversals net into the side they undo).
      this.db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type IN ('accrual', 'welcome') OR (type = 'manual_adjust' AND amount > 0) OR (type = 'reversal' AND amount < 0)
                             THEN amount ELSE 0 END), 0) AS accrued,
           COALESCE(SUM(CASE WHEN type = 'redeem' OR (type = 'manual_adjust' AND amount < 0) OR (type = 'reversal' AND amount > 0)
                             THEN -amount ELSE 0 END), 0) AS redeemed,
           COALESCE(SUM(CASE WHEN type = 'expire' THEN -amount ELSE 0 END), 0) AS expired,
           COALESCE(SUM(amount), 0) AS outstanding
         FROM points_ledger`,
      ),
      this.db.prepare(
        `SELECT COALESCE(SUM(status <> 'revoked'), 0) AS unlocked, COALESCE(SUM(status = 'used'), 0) AS used FROM rewards`,
      ),
      this.db
        .prepare(
          `SELECT COUNT(*) AS buyers, COALESCE(SUM(n >= 2), 0) AS repeaters FROM (
             SELECT client_id, COUNT(*) AS n FROM purchases
             WHERE status = 'active' AND created_at >= ? AND created_at <= ? GROUP BY client_id)`,
        )
        .bind(since90d, nowIso),
      // Monday of the local week: shift to Tashkent (+5h), go back 6 days, then forward to the next Monday.
      this.db
        .prepare(
          `SELECT date(created_at, '+5 hours', '-6 days', 'weekday 1') AS week_start, COUNT(*) AS n
           FROM purchases WHERE status = 'active' AND created_at >= ? AND created_at <= ?
           GROUP BY week_start`,
        )
        .bind(since8w, nowIso),
    ]);
    return {
      counts: counts!.results[0]!,
      points: points!.results[0]!,
      gifts: gifts!.results[0]!,
      repeat: repeat!.results[0]!,
      weekly: weekly!.results.map((r) => ({ weekStart: String(r.week_start), purchases: num(r.n) })),
    };
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
        'notifications_log', 'important_dates', 'client_stats', 'export_links', 'clients', 'staff', 'test_roles', 'tg_users',
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
