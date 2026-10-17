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
  telegramId: number;
  phone: string | null;
  name: string | null;
  birthday: string | null; // YYYY-MM-DD
  language: string;
  consentAt: Date | null;
  createdAt: Date;
  /** Short code shown as QR on the client card, e.g. "HF4821" (D1 only; '' in memory). */
  code: string;
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

  /** Full engine snapshot of one client (ledger, purchases, card, rewards) + its version. */
  loadClientState(clientId: string): Promise<VersionedState>;
  /**
   * Persist all facts of an outcome atomically, iff the stored version is
   * still `expectedVersion` (then it becomes expectedVersion + 1).
   * Throws ConcurrencyError otherwise; nothing is written in that case.
   */
  saveOutcome(clientId: string, outcome: Outcome, expectedVersion: number): Promise<void>;

  findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null>;
  /** idempotency_key is globally unique in the DB. */
  findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null>;

  allClientIds(): Promise<string[]>;
  /** Optional bulk load for the daily job (fewer round trips than one load per client). */
  loadAllClientStates?(): Promise<Map<string, VersionedState>>;
}
