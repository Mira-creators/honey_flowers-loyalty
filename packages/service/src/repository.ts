import type { ClientState, LoyaltyRules, Outcome, PurchaseRecord } from '@honey/core';

/**
 * Storage boundary. Services depend only on this interface:
 *  - `InMemoryRepository` (this package) for apps/api dev and tests;
 *  - `D1Repository` (apps/worker) on Cloudflare D1.
 *
 * Concurrency is OPTIMISTIC: `loadClientState` returns the client's state
 * version, `saveOutcome` persists all facts atomically only if nobody else
 * saved a newer version meanwhile, otherwise it throws `ConcurrencyError` and
 * the service re-runs the (pure) engine command on fresh state.
 */

export type StaffRole = 'florist' | 'manager' | 'owner';

export interface ClientProfile {
  id: string;
  /**
   * Telegram user id. NEGATIVE for a client imported from the shop's old base who has not
   * opened the bot yet (see `isUnlinkedTelegramId`); never send messages to such an id.
   */
  telegramId: number;
  phone: string | null;
  name: string | null;
  birthday: string | null; // YYYY-MM-DD
  language: string;
  consentAt: Date | null;
  createdAt: Date;
  /** Short code shown as QR on the client card, e.g. "HF4821" (D1 only; '' in memory). */
  code: string;
  /** TEST_MODE demo record (apps/worker demo seeding): never messaged, removed by «Удалить демо-данные». */
  demo?: boolean;
}

export interface StaffMember {
  id: string;
  telegramId: number | null;
  name: string;
  role: StaffRole;
  active: boolean;
  phone?: string | null;
}

export interface RulesVersion {
  id: number;
  rules: LoyaltyRules;
  activeFrom: Date;
  createdBy: string | null;
}

export interface NewClient {
  telegramId: number;
  name: string | null;
  phone: string | null;
  language: string;
  consentAt: Date | null;
  createdAt: Date;
}

/**
 * What the state looks like AFTER an outcome is applied, handed to `saveOutcome`
 * so a repository can maintain denormalized per-client summaries (apps/worker:
 * client_stats) in the same transaction as the facts. Optional for repositories
 * that derive everything on read (in-memory).
 */
export interface SavedState {
  rules: LoyaltyRules;
  state: ClientState;
  now: Date;
}

/**
 * What a command will look at, so a repository may load a BOUNDED state (apps/worker: the latest
 * purchases + these rows + ClientState.folded aggregates) instead of the whole history.
 * Without a hint a repository returns the full state.
 */
export interface LoadHint {
  now?: Date;
  rules?: LoyaltyRules;
  /** A purchase the command works on (reversal): it, its ledger rows, card moves and gifts are loaded. */
  purchaseId?: string | null;
  /** Idempotency keys the command checks (purchases, ledger rows and gift hand-outs with these keys). */
  keys?: string[];
  /** Gifts the command uses / checks by id. */
  rewardIds?: string[];
}

export interface VersionedState {
  state: ClientState;
  /** Monotonic per-client version of the stored facts (0 = nothing saved yet). */
  version: number;
}

/** Another writer saved this client's state after we loaded it. Retry. */
export class ConcurrencyError extends Error {
  constructor(message = 'client state was modified concurrently') {
    super(message);
    this.name = 'ConcurrencyError';
  }
}

export interface Repository {
  /** Rules version in force at `now`. */
  getActiveRules(now: Date): Promise<RulesVersion>;

  findClientByTelegramId(telegramId: number): Promise<ClientProfile | null>;
  findClientById(id: string): Promise<ClientProfile | null>;
  /** Phone search by digits; matches the national part (last 9 digits for +998). */
  searchClientsByPhone(phoneDigits: string, limit: number): Promise<ClientProfile[]>;
  createClient(input: NewClient): Promise<ClientProfile>;
  updateClient(id: string, patch: Partial<Pick<ClientProfile, 'name' | 'phone' | 'language' | 'consentAt' | 'birthday'>>): Promise<ClientProfile>;

  findStaffByTelegramId(telegramId: number): Promise<StaffMember | null>;

  /**
   * Engine snapshot of one client + its version. Without `hint`: the full history. With a hint a
   * repository may return a bounded state (ClientState.folded) that gives the command identical results.
   */
  loadClientState(clientId: string, hint?: LoadHint): Promise<VersionedState>;
  /**
   * Persist all facts of an outcome atomically, iff the stored version is
   * still `expectedVersion` (then it becomes expectedVersion + 1).
   * Throws ConcurrencyError otherwise; nothing is written in that case.
   * `after` (state with the outcome applied, rules, now) lets the repository
   * update per-client summary rows atomically with the facts.
   */
  saveOutcome(clientId: string, outcome: Outcome, expectedVersion: number, after?: SavedState): Promise<void>;

  findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null>;
  /** idempotency_key is globally unique in the DB. */
  findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null>;

  allClientIds(): Promise<string[]>;
  /**
   * Imported-client claim (optional; D1 and in-memory implement it). Attach a real Telegram
   * account to a client created by a base import (telegram_id is still the negative
   * placeholder, see `placeholderTelegramId`). Must be atomic: returns null if the row is
   * no longer unlinked (someone else claimed it first).
   */
  claimClient?(
    clientId: string,
    placeholderTelegramId: number,
    patch: { telegramId: number; name: string | null; language: string; consentAt: Date },
  ): Promise<ClientProfile | null>;
  /** Optional bulk load for the daily job (fewer round trips than one load per client). */
  loadAllClientStates?(): Promise<Map<string, VersionedState>>;
}
