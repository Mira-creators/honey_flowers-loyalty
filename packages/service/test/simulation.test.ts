import { describe, expect, it } from 'vitest';
import {
  applyPurchase,
  balanceFromLedger,
  cardPosition,
  defaultRules,
  deriveLevel,
  emptyClientState,
  parseRules,
  redeem,
  registerClient,
  reversePurchase,
  runExpiry,
  type ClientState,
} from '@honey/core';
import { ClientSimulation, InMemoryRepository, LoyaltyService, NullNotifier } from '../src/index.js';

const rules = parseRules({ ...defaultRules, welcomeBonus: 5_000 });
const day = (n: number, hour = 10) => new Date(Date.UTC(2026, 4, 1 + n, hour - 5));

/** Same script through LoyaltyService (a moving clock + storage) and through ClientSimulation. */
type Step = { at: Date; kind: 'register' | 'buy' | 'redeemGift' | 'reverse' | 'expiry'; amount?: number; redeem?: boolean };
const script: Step[] = [
  { at: day(0, 9), kind: 'register' },
  { at: day(1), kind: 'buy', amount: 400_000 },
  { at: day(5), kind: 'buy', amount: 2_100_000 },
  { at: day(9), kind: 'buy', amount: 150_000 }, // cell 3 → gift
  { at: day(9, 11), kind: 'reverse' },
  { at: day(9, 12), kind: 'buy', amount: 160_000 },
  { at: day(12), kind: 'redeemGift' },
  { at: day(20), kind: 'buy', amount: 300_000, redeem: true },
  { at: day(96, 9), kind: 'expiry' }, // 14-day warning
  { at: day(110, 9), kind: 'expiry' }, // burns
];

function summary(s: ClientState) {
  return {
    balance: balanceFromLedger(s.ledger),
    ledger: s.ledger.map((e) => [e.type, e.amount, e.createdAt.toISOString()]),
    card: cardPosition(rules, s),
    level: deriveLevel(rules, s, day(200)).tier.id,
    gifts: s.rewards.map((r) => [r.cycle, r.cell, r.status]),
    purchases: s.purchases.map((p) => [p.amount, p.status, p.createdAt.toISOString()]),
    keys: s.sentNotificationKeys,
  };
}

describe('ClientSimulation: engine with an explicit now per command', () => {
  it('produces exactly the state LoyaltyService stores when the clock moves step by step', async () => {
    let now = day(0, 9);
    const repo = new InMemoryRepository({ rules });
    const svc = new LoyaltyService(repo, new NullNotifier(), () => now, { retryDelayMs: 0 });
    const { client } = await svc.registerWithPhone({ telegramId: 1, name: 'A', phone: '+998900000001', language: 'ru' });

    const sim = new ClientSimulation(rules, emptyClientState(client.id, client.createdAt));
    let seq = 0;
    let lastPurchase = '';
    for (const step of script) {
      now = step.at;
      seq++;
      const key = `k${seq}`;
      const pid = `p${seq}`;
      const giftOf = (s: ClientState) => s.rewards.find((r) => r.status === 'available')!.id;
      const cmd = (r: typeof rules, s: ClientState, n: Date) => {
        switch (step.kind) {
          case 'register':
            return registerClient(r, s, n);
          case 'buy':
            return applyPurchase(r, s, { purchaseId: pid, idempotencyKey: key, staffId: 's', lines: [{ category: 'flowers', amount: step.amount! }], channel: 'store', redeemPoints: step.redeem ? 10_000 : 0 }, n);
          case 'reverse':
            return reversePurchase(r, s, { purchaseId: lastPurchase, reason: 'ошибка в сумме', staffId: 's' }, n);
          case 'redeemGift':
            return redeem(r, s, { idempotencyKey: key, staffId: 's', rewardId: giftOf(s) }, n);
          case 'expiry':
            return runExpiry(r, s, n);
        }
      };
      if (step.kind !== 'register') await svc.execute(client.id, ({ rules: r, state, now: n }) => cmd(r, state, n));
      sim.run(step.at, cmd);
      if (step.kind === 'buy') lastPurchase = pid;
    }
    const stored = repo.peekState(client.id)!;
    expect(summary(sim.state)).toEqual(summary(stored));
    expect(sim.state.ledger.map((e) => e.type)).toEqual(['welcome', 'accrual', 'accrual', 'accrual', 'reversal', 'accrual', 'redeem', 'accrual', 'expire']);
    expect(sim.events.some((e) => e.type === 'expiry_warning')).toBe(true);
    expect(balanceFromLedger(sim.state.ledger)).toBe(0);
  });

  it('refuses to go back in time and skips outcomes without effects', () => {
    const sim = new ClientSimulation(rules, emptyClientState('c', day(0)));
    sim.run(day(1), (r, s, n) => registerClient(r, s, n));
    sim.run(day(2), (r, s, n) => runExpiry(r, s, n)); // nothing to do
    expect(sim.outcomes).toHaveLength(1);
    expect(sim.lastNow).toEqual(day(2));
    expect(() => sim.run(day(1), (r, s, n) => runExpiry(r, s, n))).toThrow(/backwards/);
  });
});
