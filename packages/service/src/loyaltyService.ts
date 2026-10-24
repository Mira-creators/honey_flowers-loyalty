import {
  applyOutcome,
  applyPurchase,
  availableRewards,
  balanceOf,
  cardPosition,
  deriveLevel,
  expiryInfo,
  isGrantedReward,
  LoyaltyError,
  purchasesToNextReward,
  redeem,
  registerClient,
  reversePurchase,
  rewardsForCycle,
  runExpiry,
  settleExpiry,
  type Channel,
  type ClientState,
  type LoyaltyEvent,
  type LoyaltyRules,
  type Outcome,
  type PurchaseLine,
  type PurchaseRecord,
  type Uzs,
} from '@honey/core';
import { ConcurrencyError, type ClientProfile, type LoadHint, type Repository, type StaffMember } from './repository.js';
import type { Notifier } from './notifier.js';
import { isUnlinkedTelegramId } from './phone.js';

export class NotFoundError extends Error {}

/** Phone already belongs to another Telegram account. */
export class PhoneTakenError extends Error {}

export interface ServiceOptions {
  /** How many times a command is re-run after a ConcurrencyError (default 3 → up to 4 runs). */
  maxRetries?: number;
  /**
   * Base delay before a retry, ms. "Full jitter" exponential backoff: a random wait in
   * [0, min(400, base · 2^attempt)), so writers that collided spread out instead of colliding
   * again. Default 20; 0 disables.
   */
  retryDelayMs?: number;
  /**
   * Schedules notification delivery. Default: awaited inline (errors caught).
   * The Worker passes `ctx.waitUntil` so the HTTP response is not delayed.
   */
  defer?: (p: Promise<unknown>) => void;
  /** Called when the notifier throws (never propagates to the command). */
  onNotifyError?: (err: unknown, events: LoyaltyEvent[]) => void;
}

export interface CommandContext {
  rules: LoyaltyRules;
  rulesVersion: number;
  state: ClientState;
  now: Date;
}

export interface CommandResult<T> {
  outcome: Outcome;
  /** State after the outcome was applied (what is now stored). */
  state: ClientState;
  rules: LoyaltyRules;
  now: Date;
  extra: T;
}

/** Does the outcome contain anything to store? */
export function hasEffects(o: Outcome): boolean {
  return (
    !o.replayed &&
    (o.ledger.length > 0 ||
      o.cardMoves.length > 0 ||
      o.cardMovesReverted.length > 0 ||
      o.rewardsUnlocked.length > 0 ||
      o.rewardsUpdated.length > 0 ||
      o.purchase !== null ||
      o.levelOverride !== undefined ||
      o.notificationKeys.length > 0)
  );
}

/**
 * Glue between HTTP routes, storage and the pure engine:
 * load state (+version) → run core command → save outcome iff the version is
 * unchanged → notify. On a concurrent write the command is re-run on fresh
 * state (it is pure, so this is safe), at most `maxRetries` times.
 */
export class LoyaltyService {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    readonly repo: Repository,
    private readonly notifier: Notifier,
    readonly clock: () => Date,
    private readonly opts: ServiceOptions = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 20;
  }

  /** Send events after commit; never throws. */
  async notify(events: LoyaltyEvent[]): Promise<void> {
    if (!events.length) return;
    const p = this.notifier.send(events).catch((err) => {
      if (this.opts.onNotifyError) this.opts.onNotifyError(err, events);
      else console.error('notification failed', err);
    });
    if (this.opts.defer) this.opts.defer(p);
    else await p;
  }

  /**
   * Run one engine command for a client with optimistic concurrency.
   * `fn` may return an Outcome or `{ outcome, extra }`.
   */
  async execute<T = undefined>(
    clientId: string,
    fn: (ctx: CommandContext) => Outcome | { outcome: Outcome; extra: T },
    /** Rows the command needs beyond the latest history (bounded load); see Repository.loadClientState. */
    hint: Omit<LoadHint, 'now' | 'rules'> = {},
  ): Promise<CommandResult<T>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        // Full-jitter exponential backoff so parallel writers do not collide again immediately.
        await new Promise((r) => setTimeout(r, Math.random() * Math.min(400, this.retryDelayMs * 2 ** attempt)));
      }
      const now = this.clock();
      const rv = await this.repo.getActiveRules(now);
      const { state, version } = await this.repo.loadClientState(clientId, { ...hint, now, rules: rv.rules });
      const res = fn({ rules: rv.rules, rulesVersion: rv.id, state, now });
      const { outcome, extra } = 'outcome' in res ? res : { outcome: res, extra: undefined as T };
      if (hasEffects(outcome)) {
        try {
          await this.repo.saveOutcome(clientId, outcome, version, { rules: rv.rules, state: applyOutcome(state, outcome), now });
        } catch (e) {
          if (e instanceof ConcurrencyError) {
            lastError = e;
            continue;
          }
          throw e;
        }
      }
      await this.notify(outcome.replayed ? [] : outcome.events);
      return { outcome, state: applyOutcome(state, outcome), rules: rv.rules, now, extra };
    }
    throw lastError ?? new ConcurrencyError();
  }

  // ------------------------------------------------------------ registration

  /** Create the client on first open of the Mini App (apps/api flow; welcome bonus applies once). */
  async registerOrGet(input: { telegramId: number; name: string | null; language: string }): Promise<{ client: ClientProfile; created: boolean }> {
    const existing = await this.repo.findClientByTelegramId(input.telegramId);
    if (existing) return { client: existing, created: false };
    const client = await this.repo.createClient({
      telegramId: input.telegramId,
      name: input.name,
      phone: null,
      language: input.language,
      consentAt: null,
      createdAt: this.clock(),
    });
    await this.execute(client.id, ({ rules, state, now }) => registerClient(rules, state, now));
    return { client, created: true };
  }

  /**
   * Registration with a phone (Telegram contact / test register): creates the
   * client or attaches the phone. The welcome bonus is credited only when the
   * client is created (or when the phone is attached for the first time — the
   * moment registration actually completes); re-sharing the contact later
   * never credits a bonus enabled after signup.
   * Returns the welcome bonus credited by THIS call (0 if none / already).
   */
  async registerWithPhone(input: { telegramId: number; name: string | null; phone: string; language: string }): Promise<{
    client: ClientProfile;
    created: boolean;
    /** The phone matched a client imported from the shop's old base: this account took it over. */
    claimed: boolean;
    welcomeBonus: Uzs;
  }> {
    const holder = (await this.repo.searchClientsByPhone(input.phone, 5)).find(
      (c) => c.phone === input.phone && c.telegramId !== input.telegramId,
    );
    if (holder) return this.claimImported(holder, input);

    let client = await this.repo.findClientByTelegramId(input.telegramId);
    let created = false;
    let completesRegistration = false;
    if (!client) {
      try {
        client = await this.repo.createClient({
          telegramId: input.telegramId,
          name: input.name,
          phone: input.phone,
          language: input.language,
          consentAt: this.clock(),
          createdAt: this.clock(),
        });
        created = true;
        completesRegistration = true;
      } catch (e) {
        // A parallel request of the SAME user (double tap, retried contact) created the client a
        // moment ago: its insert won the unique key (telegram id or phone). That is not "the phone
        // belongs to another account" — answer with the same client (idempotent).
        const again = await this.repo.findClientByTelegramId(input.telegramId);
        if (!again) throw e;
        if (again.phone === input.phone) return { client: again, created: false, claimed: false, welcomeBonus: 0 };
        client = again;
      }
    }
    if (!created && (client.phone !== input.phone || (!client.name && input.name))) {
      completesRegistration = client.phone === null;
      client = await this.repo.updateClient(client.id, {
        phone: input.phone,
        name: client.name ?? input.name,
        consentAt: client.consentAt ?? this.clock(),
      });
    }
    if (!completesRegistration) return { client, created, claimed: false, welcomeBonus: 0 };
    const res = await this.execute(client.id, ({ rules, state, now }) => registerClient(rules, state, now));
    const welcome = res.outcome.ledger.find((e) => e.type === 'welcome')?.amount ?? 0;
    return { client, created, claimed: false, welcomeBonus: welcome };
  }

  /**
   * The phone already belongs to a client. If that client was imported from the old base
   * and is not linked to Telegram yet, this Telegram account CLAIMS it: same client row,
   * balance, history and card; registration completes now (welcome bonus once, if enabled).
   * A phone of a real Telegram account, or a caller who already has a card of their own
   * (two cards would have to be merged by hand), is refused as before.
   */
  private async claimImported(
    holder: ClientProfile,
    input: { telegramId: number; name: string | null; language: string },
  ): Promise<{ client: ClientProfile; created: boolean; claimed: boolean; welcomeBonus: Uzs }> {
    const taken = () => new PhoneTakenError('этот номер уже привязан к другому аккаунту Telegram');
    // Demo clients (TEST_MODE seeding) also have negative ids: they are never handed to a real person.
    // The repository additionally requires an explicit import record (D1: client_imports).
    if (holder.demo || !isUnlinkedTelegramId(holder.telegramId) || !this.repo.claimClient) throw taken();
    if (await this.repo.findClientByTelegramId(input.telegramId)) throw taken();
    const client = await this.repo.claimClient(holder.id, holder.telegramId, {
      telegramId: input.telegramId,
      name: input.name,
      language: input.language,
      consentAt: this.clock(),
    });
    if (!client) throw taken(); // claimed by someone else a moment ago
    const res = await this.execute(client.id, ({ rules, state, now }) => registerClient(rules, state, now));
    const welcome = res.outcome.ledger.find((e) => e.type === 'welcome')?.amount ?? 0;
    return { client, created: false, claimed: true, welcomeBonus: welcome };
  }

  // ------------------------------------------------------------ commands (apps/api shapes)

  /** Client dashboard (apps/api GET /me). Read-only: overdue expiry is shown, not persisted. */
  async getDashboard(client: ClientProfile) {
    const now = this.clock();
    const { rules } = await this.repo.getActiveRules(now);
    const { state: stored } = await this.repo.loadClientState(client.id);
    const state = applyOutcome(stored, settleExpiry(rules, stored, now));

    const balance = balanceOf(state);
    const level = deriveLevel(rules, state, now);
    const pos = cardPosition(rules, state);
    const layout = rewardsForCycle(rules, pos.cycle);
    // Gifts granted by the owner are not tied to a cell.
    const unlockedThisCycle = state.rewards.filter((r) => r.cycle === pos.cycle && !isGrantedReward(r));
    const expiry = expiryInfo(rules, state, now);

    return {
      client: { id: client.id, name: client.name, language: client.language, hasPhone: client.phone !== null },
      balance,
      level: {
        id: level.tier.id,
        title: level.tier.title,
        cashbackPct: level.tier.cashbackPct,
        criterion: rules.levels.criterion,
        metric: level.metric,
        countedFrom: level.countedFrom,
        next: level.next
          ? {
              id: level.next.tier.id,
              title: level.next.tier.title,
              cashbackPct: level.next.tier.cashbackPct,
              threshold: level.next.tier.threshold,
              remaining: level.next.remaining,
              progress: Math.min(1, level.metric / level.next.tier.threshold),
            }
          : null,
      },
      card: {
        cycle: pos.cycle,
        cellsTotal: rules.honeycomb.cells,
        filled: pos.filled,
        purchasesToNextReward: purchasesToNextReward(rules, pos),
        // Gift cells stay a surprise ("?") until the bee reaches them.
        cells: Array.from({ length: rules.honeycomb.cells }, (_, i) => {
          const cell = i + 1;
          const unlocked = unlockedThisCycle.find((r) => r.cell === cell && r.status !== 'revoked');
          return {
            cell,
            filled: cell <= pos.filled,
            hasGift: layout.some((r) => r.cell === cell),
            gift: unlocked ? { type: unlocked.type, title: unlocked.title } : null,
          };
        }),
      },
      gifts: state.rewards
        .filter((r) => r.status !== 'revoked')
        .map((r) => ({ id: r.id, type: r.type, title: r.title, value: r.value, status: r.status, unlockedAt: r.unlockedAt, usedAt: r.usedAt })),
      expiry: balance > 0 ? { expiresOn: expiry.expiresOn, daysLeft: expiry.daysLeft } : null,
    };
  }

  async purchase(
    staff: StaffMember,
    input: {
      clientId: string;
      idempotencyKey: string;
      lines: PurchaseLine[];
      channel: Channel;
      redeemPoints?: Uzs;
      useRewardId?: string | null;
    },
  ) {
    const client = await this.repo.findClientById(input.clientId);
    if (!client) throw new NotFoundError('client not found');
    // idempotency_key is globally unique: reject reuse across clients.
    const other = await this.repo.findPurchaseByIdempotencyKey(input.idempotencyKey);
    if (other && other.clientId !== client.id) {
      throw new LoyaltyError('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for another client');
    }
    const purchaseId = crypto.randomUUID();
    const { outcome } = await this.execute(
      client.id,
      ({ rules, state, now }) =>
      applyPurchase(
        rules,
        state,
        {
          purchaseId,
          idempotencyKey: input.idempotencyKey,
          staffId: staff.id,
          lines: input.lines,
          channel: input.channel,
          redeemPoints: input.redeemPoints ?? 0,
          useRewardId: input.useRewardId ?? null,
        },
        now,
      ),
      { keys: [input.idempotencyKey], rewardIds: input.useRewardId ? [input.useRewardId] : [] },
    );
    const purchase = outcome.purchase!;
    // A replay of a purchase that was reversed meanwhile is surfaced explicitly.
    return { replayed: outcome.replayed, status: purchase.status, purchase: publicPurchase(purchase), events: outcome.events };
  }

  async redeem(staff: StaffMember, input: { clientId: string; idempotencyKey: string; points?: Uzs; orderAmount?: Uzs; rewardId?: string | null; reason?: string | null }) {
    const client = await this.repo.findClientById(input.clientId);
    if (!client) throw new NotFoundError('client not found');
    const { outcome, state } = await this.execute(
      client.id,
      ({ rules, state, now }) => redeem(rules, state, { ...input, staffId: staff.id }, now),
      { keys: [input.idempotencyKey], rewardIds: input.rewardId ? [input.rewardId] : [] },
    );
    return { replayed: outcome.replayed, balance: balanceOf(state), events: outcome.events };
  }

  async reverse(staff: StaffMember, input: { purchaseId: string; reason: string }) {
    const purchase = await this.repo.findPurchaseById(input.purchaseId);
    if (!purchase) throw new NotFoundError('purchase not found');
    const { outcome } = await this.execute(
      purchase.clientId,
      ({ rules, state, now }) => reversePurchase(rules, state, { purchaseId: input.purchaseId, reason: input.reason, staffId: staff.id }, now),
      { purchaseId: input.purchaseId },
    );
    return { replayed: outcome.replayed, purchase: publicPurchase(outcome.purchase!), warnings: outcome.warnings, events: outcome.events };
  }

  async searchByPhone(phone: string) {
    const now = this.clock();
    const { rules } = await this.repo.getActiveRules(now);
    const found = await this.repo.searchClientsByPhone(phone, 10);
    return Promise.all(
      found.map(async (c) => {
        const { state } = await this.repo.loadClientState(c.id);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          balance: balanceOf(state),
          level: deriveLevel(rules, state, now).tier.id,
          card: cardPosition(rules, state),
          availableGifts: availableRewards(state).map((r) => ({ id: r.id, type: r.type, title: r.title, value: r.value })),
        };
      }),
    );
  }

  /**
   * Daily job: expiry + warnings for every client. Returns the events produced.
   * One failing client (e.g. permanently busy) never stops the others: the
   * error is reported via `onClientError` (default: console.error) and the
   * loop continues.
   */
  async runExpiryForAll(onClientError?: (clientId: string, err: unknown) => void): Promise<LoyaltyEvent[]> {
    const events: LoyaltyEvent[] = [];
    const now = this.clock();
    const { rules } = await this.repo.getActiveRules(now);
    // Bulk pre-check: only clients whose run would change something are re-run
    // through execute() (which reloads and saves with the version check).
    const bulk = this.repo.loadAllClientStates ? await this.repo.loadAllClientStates() : null;
    const ids = bulk ? [...bulk.keys()] : await this.repo.allClientIds();
    for (const id of ids) {
      try {
        const pre = bulk?.get(id);
        if (pre && !hasEffects(runExpiry(rules, pre.state, now))) continue;
        const { outcome } = await this.execute(id, ({ rules: r, state, now: n }) => runExpiry(r, state, n));
        events.push(...outcome.events);
      } catch (err) {
        if (onClientError) onClientError(id, err);
        else console.error(`daily expiry failed for client ${id}`, err);
      }
    }
    return events;
  }
}

export function publicPurchase(p: PurchaseRecord) {
  return {
    id: p.id,
    clientId: p.clientId,
    amount: p.amount,
    lines: p.lines,
    channel: p.channel,
    status: p.status,
    rulesVersion: p.rulesVersion,
    createdAt: p.createdAt,
    reversedReason: p.reversedReason,
    result: p.result,
  };
}
