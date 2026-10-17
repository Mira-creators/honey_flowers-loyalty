import { randomUUID } from 'node:crypto';
import {
  applyOutcome,
  applyPurchase,
  availableRewards,
  balanceFromLedger,
  cardPosition,
  deriveLevel,
  expiryInfo,
  LoyaltyError,
  purchasesToNextReward,
  redeem,
  registerClient,
  reversePurchase,
  rewardsForCycle,
  runExpiry,
  settleExpiry,
  type Channel,
  type LoyaltyEvent,
  type Outcome,
  type PurchaseLine,
  type PurchaseRecord,
  type Uzs,
} from '@honey/core';
import type { ClientProfile, Repository, StaffMember } from '../repo/types.js';
import type { Notifier } from './notifier.js';

export class NotFoundError extends Error {}

/**
 * Glue between HTTP routes, storage and the pure engine:
 * load state → run core command → save outcome → send notifications.
 * Every command runs under a per-client lock.
 */
export class LoyaltyService {
  constructor(
    private readonly repo: Repository,
    private readonly notifier: Notifier,
    private readonly clock: () => Date,
  ) {}

  private async commit(clientId: string, outcome: Outcome): Promise<void> {
    if (outcome.replayed) return;
    await this.repo.saveOutcome(clientId, outcome);
    if (outcome.events.length) await this.notifier.send(outcome.events);
  }

  /** Create the client on first open of the Mini App (welcome bonus applies once). */
  async registerOrGet(input: { telegramId: number; name: string | null; language: string }): Promise<{ client: ClientProfile; created: boolean }> {
    const existing = await this.repo.findClientByTelegramId(input.telegramId);
    if (existing) return { client: existing, created: false };
    const now = this.clock();
    const client = await this.repo.createClient({
      telegramId: input.telegramId,
      name: input.name,
      phone: null,
      language: input.language,
      consentAt: null,
      createdAt: now,
    });
    await this.repo.withClientLock(client.id, async () => {
      const { rules } = await this.repo.getActiveRules(now);
      const state = await this.repo.loadClientState(client.id);
      await this.commit(client.id, registerClient(rules, state, now));
    });
    return { client, created: true };
  }

  /** Client dashboard (GET /me). Read-only: overdue expiry is shown, not persisted. */
  async getDashboard(client: ClientProfile) {
    const now = this.clock();
    const { rules } = await this.repo.getActiveRules(now);
    const stored = await this.repo.loadClientState(client.id);
    const state = applyOutcome(stored, settleExpiry(rules, stored, now));

    const balance = balanceFromLedger(state.ledger);
    const level = deriveLevel(rules, state, now);
    const pos = cardPosition(rules, state);
    const layout = rewardsForCycle(rules, pos.cycle);
    const unlockedThisCycle = state.rewards.filter((r) => r.cycle === pos.cycle);
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
      expiry:
        balance > 0
          ? { expiresOn: expiry.expiresOn, daysLeft: expiry.daysLeft }
          : null,
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
    return this.repo.withClientLock(client.id, async () => {
      const now = this.clock();
      const { rules } = await this.repo.getActiveRules(now);
      const state = await this.repo.loadClientState(client.id);
      const outcome = applyPurchase(
        rules,
        state,
        {
          purchaseId: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          staffId: staff.id,
          lines: input.lines,
          channel: input.channel,
          redeemPoints: input.redeemPoints ?? 0,
          useRewardId: input.useRewardId ?? null,
        },
        now,
      );
      await this.commit(client.id, outcome);
      return { replayed: outcome.replayed, purchase: publicPurchase(outcome.purchase!), events: outcome.events };
    });
  }

  async redeem(staff: StaffMember, input: { clientId: string; idempotencyKey: string; points?: Uzs; orderAmount?: Uzs; rewardId?: string | null; reason?: string | null }) {
    const client = await this.repo.findClientById(input.clientId);
    if (!client) throw new NotFoundError('client not found');
    return this.repo.withClientLock(client.id, async () => {
      const now = this.clock();
      const { rules } = await this.repo.getActiveRules(now);
      const state = await this.repo.loadClientState(client.id);
      const outcome = redeem(rules, state, { ...input, staffId: staff.id }, now);
      await this.commit(client.id, outcome);
      const after = await this.repo.loadClientState(client.id);
      return { replayed: outcome.replayed, balance: balanceFromLedger(after.ledger), events: outcome.events };
    });
  }

  async reverse(staff: StaffMember, input: { purchaseId: string; reason: string }) {
    const purchase = await this.repo.findPurchaseById(input.purchaseId);
    if (!purchase) throw new NotFoundError('purchase not found');
    return this.repo.withClientLock(purchase.clientId, async () => {
      const now = this.clock();
      const { rules } = await this.repo.getActiveRules(now);
      const state = await this.repo.loadClientState(purchase.clientId);
      const outcome = reversePurchase(rules, state, { purchaseId: input.purchaseId, reason: input.reason, staffId: staff.id }, now);
      await this.commit(purchase.clientId, outcome);
      return { replayed: outcome.replayed, purchase: publicPurchase(outcome.purchase!), warnings: outcome.warnings, events: outcome.events };
    });
  }

  async searchByPhone(phone: string) {
    const now = this.clock();
    const { rules } = await this.repo.getActiveRules(now);
    const found = await this.repo.searchClientsByPhone(phone, 10);
    return Promise.all(
      found.map(async (c) => {
        const state = await this.repo.loadClientState(c.id);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          balance: balanceFromLedger(state.ledger),
          level: deriveLevel(rules, state, now).tier.id,
          card: cardPosition(rules, state),
          availableGifts: availableRewards(state).map((r) => ({ id: r.id, type: r.type, title: r.title, value: r.value })),
        };
      }),
    );
  }

  /** Scheduler job (not wired to a cron yet): expiry + warnings for every client. */
  async runExpiryForAll(): Promise<LoyaltyEvent[]> {
    const events: LoyaltyEvent[] = [];
    for (const id of await this.repo.allClientIds()) {
      await this.repo.withClientLock(id, async () => {
        const now = this.clock();
        const { rules } = await this.repo.getActiveRules(now);
        const outcome = runExpiry(rules, await this.repo.loadClientState(id), now);
        if (outcome.events.length || outcome.ledger.length || outcome.notificationKeys.length) {
          await this.commit(id, outcome);
          events.push(...outcome.events);
        }
      });
    }
    return events;
  }
}

function publicPurchase(p: PurchaseRecord) {
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
