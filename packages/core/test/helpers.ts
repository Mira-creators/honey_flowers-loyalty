import {
  applyOutcome,
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
  type Category,
  type ClientState,
  type LoyaltyRules,
  type Outcome,
  type PurchaseInput,
  type RedeemInput,
} from '../src/index.js';

/** Local Tashkent time (UTC+5, no DST) → Date. `at('2026-11-01 10:00')`. */
export function at(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+05:00`);
}

/** Add whole days to a Date. */
export function plusDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? merge(b, v as never) : v;
  }
  return out as T;
}

/** Default rules with overrides, validated by the zod schema. */
export function makeRules(patch?: DeepPartial<LoyaltyRules>): LoyaltyRules {
  return parseRules(merge(defaultRules, patch));
}

export const flowers = (amount: number) => [{ category: 'flowers' as Category, amount }];

/**
 * Tiny driver that keeps a client state and applies outcomes, like the
 * repository does. Every call takes an explicit `now`.
 */
export class Sim {
  state: ClientState;
  private seq = 0;
  last!: Outcome;

  constructor(
    public rules: LoyaltyRules = makeRules(),
    registeredAt: Date = at('2026-11-01 09:00'),
  ) {
    this.state = emptyClientState('c1', registeredAt);
  }

  private commit(o: Outcome): Outcome {
    this.last = o;
    this.state = applyOutcome(this.state, o);
    return o;
  }

  register(now: Date): Outcome {
    return this.commit(registerClient(this.rules, this.state, now));
  }

  /** Purchase of flowers by default. */
  buy(amount: number, now: Date, extra: Partial<PurchaseInput> = {}): Outcome {
    this.seq += 1;
    const input: PurchaseInput = {
      purchaseId: `p${this.seq}`,
      idempotencyKey: `k${this.seq}`,
      staffId: 's1',
      lines: flowers(amount),
      channel: 'store',
      ...extra,
    };
    return this.commit(applyPurchase(this.rules, this.state, input, now));
  }

  redeem(input: Partial<RedeemInput>, now: Date): Outcome {
    this.seq += 1;
    return this.commit(redeem(this.rules, this.state, { idempotencyKey: `r${this.seq}`, staffId: 's1', ...input }, now));
  }

  reverse(purchaseId: string, now: Date, reason = 'ошибка флориста'): Outcome {
    return this.commit(reversePurchase(this.rules, this.state, { purchaseId, reason, staffId: 's1' }, now));
  }

  expiry(now: Date): Outcome {
    return this.commit(runExpiry(this.rules, this.state, now));
  }

  get balance(): number {
    return balanceFromLedger(this.state.ledger);
  }

  level(now: Date): string {
    return deriveLevel(this.rules, this.state, now).tier.id;
  }

  get card() {
    return cardPosition(this.rules, this.state);
  }

  gifts(status?: string) {
    return this.state.rewards.filter((r) => !status || r.status === status);
  }

  /** Give the client points via a manual adjustment-free path: a big purchase. */
  seedPoints(points: number, now: Date): void {
    // 1% level → purchase of points*100 gives exactly `points`.
    this.buy(points * 100, now);
  }
}

export function eventTypes(o: Outcome): string[] {
  return o.events.map((e) => e.type);
}
