import type { ClientState, LoyaltyRules, Outcome, PurchaseRecord } from '@honey/core';

/**
 * Storage boundary of the API. Routes and services depend only on this
 * interface; `InMemoryRepository` implements it for dev/tests, a Postgres
 * implementation (db/migrations/001_init.sql) is the next step.
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
}

export interface StaffMember {
  id: string;
  telegramId: number;
  name: string;
  role: StaffRole;
  active: boolean;
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

export interface Repository {
  /** Rules version in force at `now` (latest with active_from <= now). */
  getActiveRules(now: Date): Promise<RulesVersion>;

  findClientByTelegramId(telegramId: number): Promise<ClientProfile | null>;
  findClientById(id: string): Promise<ClientProfile | null>;
  /** Phone search by digits; matches the national part (last 9 digits for +998). */
  searchClientsByPhone(phoneDigits: string, limit: number): Promise<ClientProfile[]>;
  createClient(input: NewClient): Promise<ClientProfile>;
  updateClient(id: string, patch: Partial<Pick<ClientProfile, 'name' | 'phone' | 'language' | 'consentAt' | 'birthday'>>): Promise<ClientProfile>;

  findStaffByTelegramId(telegramId: number): Promise<StaffMember | null>;

  /** Full engine snapshot of one client (ledger, purchases, card, rewards). */
  loadClientState(clientId: string): Promise<ClientState>;
  /** Persist all facts of an outcome atomically (one transaction). */
  saveOutcome(clientId: string, outcome: Outcome): Promise<void>;

  findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null>;
  /** idempotency_key is globally unique in the DB. */
  findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null>;

  /**
   * Serialize commands per client (Postgres: transaction + SELECT ... FOR
   * UPDATE on the client row). Prevents double spending by parallel requests.
   */
  withClientLock<T>(clientId: string, fn: () => Promise<T>): Promise<T>;

  allClientIds(): Promise<string[]>;
}
