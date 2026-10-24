import { applyOutcome, type ClientState, type LoyaltyEvent, type LoyaltyRules, type Outcome } from '@honey/core';
import { hasEffects } from './loyaltyService.js';

/** One engine command (registerClient, applyPurchase, redeem, reversePurchase, runExpiry, grant…). */
export type EngineCommand = (rules: LoyaltyRules, state: ClientState, now: Date) => Outcome;

/**
 * Replays a client's history through the real engine, every command at its
 * OWN explicit `now` (the per-call clock of the pure engine), in memory —
 * exactly what LoyaltyService.execute does per command (run → applyOutcome),
 * minus the storage round trip. Used to build demo data whose balances,
 * cells, levels, gifts and expiry are by construction what the rules produce;
 * the final state is then persisted in one write.
 *
 * Time must not go backwards: commands are applied in chronological order.
 */
export class ClientSimulation {
  /** Outcomes with effects, in the order they were applied. */
  readonly outcomes: Outcome[] = [];
  /** All events the commands produced (not delivered: nothing is sent). */
  readonly events: LoyaltyEvent[] = [];
  private last: Date | null = null;

  constructor(
    readonly rules: LoyaltyRules,
    public state: ClientState,
  ) {}

  /** Time of the latest applied command (or null). */
  get lastNow(): Date | null {
    return this.last;
  }

  run(now: Date, command: EngineCommand): Outcome {
    if (this.last && now.getTime() < this.last.getTime()) {
      throw new Error(`simulation time went backwards: ${now.toISOString()} < ${this.last.toISOString()}`);
    }
    const outcome = command(this.rules, this.state, now);
    this.last = now;
    if (hasEffects(outcome)) {
      this.outcomes.push(outcome);
      this.state = applyOutcome(this.state, outcome);
      this.events.push(...outcome.events);
    }
    return outcome;
  }
}
