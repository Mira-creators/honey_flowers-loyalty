import { randomUUID } from 'node:crypto';
import {
  applyOutcome,
  defaultRules,
  emptyClientState,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
  type PurchaseRecord,
} from '@honey/core';
import type { ClientProfile, NewClient, Repository, RulesVersion, StaffMember } from './types.js';

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Last 9 digits = Uzbek national number without +998. */
function nationalPart(digits: string): string {
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * In-memory repository: lets the API run and be tested without a database.
 * Data is lost on restart. Not for production.
 */
export class InMemoryRepository implements Repository {
  private rulesVersions: RulesVersion[] = [];
  private clients = new Map<string, ClientProfile>();
  private staff = new Map<number, StaffMember>();
  private states = new Map<string, ClientState>();
  private locks = new Map<string, Promise<unknown>>();
  private ledgerSeq = 0;

  constructor(opts: { rules?: LoyaltyRules; staff?: Omit<StaffMember, 'id'>[] } = {}) {
    const rules = opts.rules ?? defaultRules;
    this.rulesVersions.push({ id: rules.version, rules, activeFrom: new Date(0), createdBy: null });
    for (const s of opts.staff ?? []) this.addStaff(s);
  }

  addStaff(s: Omit<StaffMember, 'id'>): StaffMember {
    const member = { ...s, id: randomUUID() };
    this.staff.set(s.telegramId, member);
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
    const client: ClientProfile = { id: randomUUID(), birthday: null, ...input };
    this.clients.set(client.id, client);
    this.states.set(client.id, emptyClientState(client.id, input.createdAt));
    return client;
  }

  async updateClient(id: string, patch: Partial<ClientProfile>): Promise<ClientProfile> {
    const c = this.clients.get(id);
    if (!c) throw new Error(`client ${id} not found`);
    const next = { ...c, ...patch, id: c.id, telegramId: c.telegramId };
    this.clients.set(id, next);
    return next;
  }

  async findStaffByTelegramId(telegramId: number): Promise<StaffMember | null> {
    return this.staff.get(telegramId) ?? null;
  }

  async loadClientState(clientId: string): Promise<ClientState> {
    const s = this.states.get(clientId);
    if (!s) throw new Error(`client ${clientId} not found`);
    return structuredClone(s);
  }

  async saveOutcome(clientId: string, outcome: Outcome): Promise<void> {
    const s = this.states.get(clientId);
    if (!s) throw new Error(`client ${clientId} not found`);
    const withIds: Outcome = {
      ...outcome,
      ledger: outcome.ledger.map((e) => ({ ...e, id: e.id ?? String(++this.ledgerSeq) })),
    };
    this.states.set(clientId, applyOutcome(s, structuredClone(withIds)));
  }

  async findPurchaseById(purchaseId: string): Promise<PurchaseRecord | null> {
    for (const s of this.states.values()) {
      const p = s.purchases.find((x) => x.id === purchaseId);
      if (p) return structuredClone(p);
    }
    return null;
  }

  async findPurchaseByIdempotencyKey(key: string): Promise<PurchaseRecord | null> {
    for (const s of this.states.values()) {
      const p = s.purchases.find((x) => x.idempotencyKey === key);
      if (p) return structuredClone(p);
    }
    return null;
  }

  async withClientLock<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(clientId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      clientId,
      run.catch(() => undefined),
    );
    return run;
  }

  async allClientIds(): Promise<string[]> {
    return [...this.clients.keys()];
  }
}
