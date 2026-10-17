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
  type ClientProfile,
  type NewClient,
  type Repository,
  type RulesVersion,
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

export interface ClientContact {
  id: string;
  telegramId: number;
  language: string;
  name: string | null;
}

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

  async getClockOffsetDays(): Promise<number> {
    const v = Number(await this.getSetting('clock_offset_days'));
    return Number.isFinite(v) ? v : 0;
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
      ]);
    } catch (e) {
      if (isUniqueViolation(e, 'rules_versions')) throw new ConcurrencyError('rules were changed concurrently');
      throw e;
    }
    this.rulesCache = null;
  }

  // ---------------------------------------------------------------- telegram users

  async touchTgUser(u: { telegramId: number; firstName: string | null; username?: string | null; language?: string | null }, now: Date): Promise<void> {
    const lang = u.language === 'uz' ? 'uz' : 'ru';
    await this.db
      .prepare(
        `INSERT INTO tg_users (telegram_id, first_name, username, language, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, tg_users.first_name),
           username = COALESCE(excluded.username, tg_users.username),
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(u.telegramId, u.firstName, u.username ?? null, lang, iso(now), iso(now))
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
    for (let attempt = 0; attempt < 15; attempt++) {
      const digits = attempt < 6 ? 4 : attempt < 11 ? 5 : 6;
      const code = `HF${randomDigits(digits)}`;
      try {
        await this.db
          .prepare(
            `INSERT INTO clients (id, telegram_id, code, phone, name, language, consent_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, input.telegramId, code, input.phone, input.name, input.language === 'uz' ? 'uz' : 'ru', isoOrNull(input.consentAt), iso(input.createdAt))
          .run();
        return (await this.findClientById(id))!;
      } catch (e) {
        if (isUniqueViolation(e, 'clients.code')) continue;
        if (isUniqueViolation(e, 'clients.telegram_id')) throw new Error('telegram_id already registered');
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
      await this.db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
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

  /** Staff added by phone gets its telegram_id when that person shares the phone with the bot. */
  async linkStaffByPhone(phone: string, telegramId: number): Promise<void> {
    await this.db
      .prepare('UPDATE staff SET telegram_id = ? WHERE phone = ? AND telegram_id IS NULL AND NOT EXISTS (SELECT 1 FROM staff WHERE telegram_id = ?)')
      .bind(telegramId, phone, telegramId)
      .run();
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

  /** Bulk load for the daily job. */
  async loadAllClientStates(): Promise<Map<string, VersionedState>> {
    const [clients, versions, purchases, ledger, moves, rewards, keys] = await this.db.batch<Row>([
      this.db.prepare('SELECT id, created_at, level_override, level_override_at, level_override_index FROM clients ORDER BY created_at'),
      this.db.prepare('SELECT client_id, MAX(version) AS v FROM client_versions GROUP BY client_id'),
      this.db.prepare('SELECT * FROM purchases ORDER BY created_at, rowid'),
      this.db.prepare('SELECT * FROM points_ledger ORDER BY rowid'),
      this.db.prepare('SELECT * FROM card_moves ORDER BY id'),
      this.db.prepare('SELECT * FROM rewards ORDER BY rowid'),
      this.db.prepare('SELECT client_id, key FROM notification_keys ORDER BY rowid'),
    ]);
    const out = new Map<string, VersionedState>();
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
  async saveOutcome(clientId: string, o: Outcome, expectedVersion: number): Promise<void> {
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

  // ---------------------------------------------------------------- reports

  /** Operations of all clients, newest first (staff "recent" list, owner journal). */
  async operations(limit: number): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM (
           SELECT p.id AS id, p.created_at AS at, 'purchase' AS kind,
             (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type IN ('accrual', 'redeem')) AS points,
             p.client_id AS client_id, c.name AS client_name, p.staff_id AS staff_id, p.id AS purchase_id, p.amount AS purchase_amount, p.status AS status
           FROM purchases p JOIN clients c ON c.id = p.client_id
           UNION ALL
           SELECT 'rev-' || p.id, p.reversed_at, 'reversal',
             (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type = 'reversal'),
             p.client_id, c.name, p.reversed_by, p.id, p.amount, p.status
           FROM purchases p JOIN clients c ON c.id = p.client_id WHERE p.status = 'reversed'
           UNION ALL
           SELECT l.id, l.created_at,
             CASE l.type WHEN 'welcome' THEN 'welcome' WHEN 'redeem' THEN 'redeem' WHEN 'expire' THEN 'expire' ELSE 'manual' END,
             l.amount, l.client_id, c.name, l.staff_id, NULL, NULL, NULL
           FROM points_ledger l JOIN clients c ON c.id = l.client_id WHERE l.purchase_id IS NULL
           UNION ALL
           SELECT 'gift-' || r.id, r.used_at, 'gift_used', 0, r.client_id, c.name, NULL, NULL, NULL, NULL
           FROM rewards r JOIN clients c ON c.id = r.client_id WHERE r.status = 'used' AND r.used_in_purchase IS NULL
         ) ORDER BY at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return results;
  }

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
      this.db
        .prepare(`SELECT created_at FROM purchases WHERE status = 'active' AND created_at >= ? AND created_at <= ?`)
        .bind(since8w, nowIso),
    ]);
    return {
      counts: counts!.results[0]!,
      points: points!.results[0]!,
      gifts: gifts!.results[0]!,
      repeat: repeat!.results[0]!,
      weekly: weekly!.results.map((r) => String(r.created_at)),
    };
  }

  /** Persist a bot message attempt. Never throws. */
  async logNotification(entry: { clientId: string | null; telegramId: number | null; types: string; text: string; status: 'sent' | 'failed' | 'skipped'; error?: string | null }): Promise<void> {
    try {
      await this.db
        .prepare('INSERT INTO notifications_log (client_id, telegram_id, types, text, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(entry.clientId, entry.telegramId, entry.types, entry.text, entry.status, entry.error ?? null, iso(new Date()))
        .run();
    } catch (e) {
      console.error('notifications_log insert failed', e);
    }
  }

  /** Tests / TEST_MODE: wipe all data (keeps the schema and rules version 1). */
  async wipeAll(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO maintenance (flag) VALUES ('allow_ledger_delete')`),
      ...[
        'points_ledger', 'card_moves', 'rewards', 'purchases', 'client_versions', 'notification_keys',
        'notifications_log', 'important_dates', 'clients', 'staff', 'test_roles', 'tg_users',
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
