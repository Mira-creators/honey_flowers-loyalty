import {
  applyOutcome,
  defaultRules,
  emptyClientState,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
  type PurchaseRecord,
} from '@honey/core';
import {
  ConcurrencyError,
  type ClientProfile,
  type NewClient,
  type Repository,
  type RulesVersion,
  type StaffMember,
  type VersionedState,
} from './repository.js';
import { nationalPart, phoneDigits, placeholderTelegramId } from './phone.js';

/**
 * In-memory repository: lets apps/api run and be tested without a database.
 * Data is lost on restart. Not for production.
 */
export class InMemoryRepository implements Repository {
  private rulesVersions: RulesVersion[] = [];
  private clients = new Map<string, ClientProfile>();
  private staff = new Map<number, StaffMember>();
  private states = new Map<string, VersionedState>();
  private ledgerSeq = 0;
  /** Clients created by a base import (D1: client_imports): the only ones a Telegram user may claim. */
  private imported = new Set<string>();

  constructor(opts: { rules?: LoyaltyRules; staff?: Omit<StaffMember, 'id'>[] } = {}) {
    const rules = opts.rules ?? defaultRules;
    this.rulesVersions.push({ id: rules.version, rules, activeFrom: new Date(0), createdBy: null });
    for (const s of opts.staff ?? []) this.addStaff(s);
  }

  addStaff(s: Omit<StaffMember, 'id'>): StaffMember {
    const member = { ...s, id: crypto.randomUUID() };
    if (s.telegramId !== null) this.staff.set(s.telegramId, member);
    return member;
  }

  addRulesVersion(v: RulesVersion): void {
    this.rulesVersions.push(v);
    this.rulesVersions.sort((a, b) => a.activeFrom.getTime() - b.activeFrom.getTime());
  }

  async getActiveRules(now: Date): Promise<RulesVersion> {
    const active = this.rulesVersions.filter((v) => v.activeFrom.getTime() <= now.getTime()).at(-1);
    if (!active) throw new Error('no active rules version');
    return active;
  }

  async findClientByTelegramId(telegramId: number): Promise<ClientProfile | null> {
    for (const c of this.clients.values()) if (c.telegramId === telegramId) return c;
    return null;
  }

  async findClientById(id: string): Promise<ClientProfile | null> {
    return this.clients.get(id) ?? null;
  }

  async searchClientsByPhone(digits: string, limit: number): Promise<ClientProfile[]> {
    const needle = nationalPart(phoneDigits(digits));
    if (needle.length < 4) return [];
    return [...this.clients.values()]
      .filter((c) => c.phone && nationalPart(phoneDigits(c.phone)).includes(needle))
      .slice(0, limit);
  }

  async createClient(input: NewClient): Promise<ClientProfile> {
    if (await this.findClientByTelegramId(input.telegramId)) throw new Error('telegram_id already registered');
    const client: ClientProfile = { id: crypto.randomUUID(), birthday: null, code: '', ...input };
    this.clients.set(client.id, client);
    this.states.set(client.id, { state: emptyClientState(client.id, input.createdAt), version: 0 });
    return client;
  }

  async updateClient(id: string, patch: Partial<ClientProfile>): Promise<ClientProfile> {
    const c = this.clients.get(id);
    if (!c) throw new Error(`client ${id} not found`);
    const next = { ...c, ...patch, id: c.id, telegramId: c.telegramId };
    this.clients.set(id, next);
    return next;
  }

  async claimClient(
    clientId: string,
    placeholderTelegramId: number,
    patch: { telegramId: number; name: string | null; language: string; consentAt: Date },
  ): Promise<ClientProfile | null> {
    const c = this.clients.get(clientId);
    if (!c || c.demo || !this.imported.has(clientId) || c.telegramId !== placeholderTelegramId || c.telegramId >= 0) return null;
    if (await this.findClientByTelegramId(patch.telegramId)) return null;
    const next: ClientProfile = { ...c, telegramId: patch.telegramId, name: c.name ?? patch.name, language: patch.language, consentAt: c.consentAt ?? patch.consentAt };
    this.clients.set(clientId, next);
    return next;
  }

  /** Tests: add a client imported from the old base (negative placeholder Telegram id). */
  async importClient(input: { phone: string; name: string | null; createdAt: Date }): Promise<ClientProfile> {
    const c = await this.createClient({ telegramId: placeholderTelegramId(input.phone), name: input.name, phone: input.phone, language: 'ru', consentAt: null, createdAt: input.createdAt });
    this.imported.add(c.id);
    return c;
  }

  /** Tests: a TEST_MODE demo client (negative id too, but never claimable). */
  async demoClient(input: { telegramId: number; phone: string; name: string; createdAt: Date }): Promise<ClientProfile> {
    const c = await this.createClient({ ...input, language: 'ru', consentAt: input.createdAt });
    const demo = { ...c, demo: true };
    this.clients.set(c.id, demo);
    return demo;
  }

  async findStaffByTelegramId(telegramId: number): Promise<StaffMember | null> {
    return this.staff.get(telegramId) ?? null;
  }

  async loadClientState(clientId: string): Promise<VersionedState> {
    const s = this.states.get(clientId);
    if (!s) throw new Error(`client ${clientId} not found`);
    return structuredClone(s);
  }

  async saveOutcome(clientId: string, outcome: Outcome, expectedVersion: number): Promise<void> {
    const s = this.states.get(clientId);
    if (!s) throw new Error(`client ${clientId} not found`);
    if (s.version !== expectedVersion) throw new ConcurrencyError();
    const withIds: Outcome = {
      ...outcome,
      ledger: outcome.ledger.map((e) => ({ ...e, id: e.id ?? String(++this.ledgerSeq) })),
    };
    this.states.set(clientId, { state: applyOutcome(s.state, structuredClone(withIds)), version: s.version + 1 });
  }

  async findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null> {
    for (const { state } of this.states.values()) {
      const p = state.purchases.find((x) => x.id === purchaseId);
      if (p) return structuredClone(p);
    }
    return null;
  }

  async findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null> {
    for (const { state } of this.states.values()) {
      const p = state.purchases.find((x) => x.idempotencyKey === key);
      if (p) return structuredClone(p);
    }
    return null;
  }

  async allClientIds(): Promise<string[]> {
    return [...this.clients.keys()];
  }

  /** Raw state (tests). */
  peekState(clientId: string): ClientState | undefined {
    return this.states.get(clientId)?.state;
  }
}
