import { LoyaltyError } from '../errors.js';
import type { LoyaltyRules } from '../rules.js';
import { CATEGORIES, type Category, type ClientState, type PurchaseLine, type Reward, type Uzs } from '../types.js';
import { percentOf } from '../money.js';
import { isUzs } from '../money.js';

export function assert(cond: unknown, code: ConstructorParameters<typeof LoyaltyError>[0], message: string): asserts cond {
  if (!cond) throw new LoyaltyError(code, message);
}

export function validateLines(rules: LoyaltyRules, lines: readonly PurchaseLine[]): Uzs {
  assert(Array.isArray(lines) && lines.length > 0, 'INVALID_INPUT', 'purchase must have at least one line');
  let total = 0;
  for (const l of lines) {
    assert((CATEGORIES as readonly string[]).includes(l.category), 'INVALID_INPUT', `unknown category: ${String(l.category)}`);
    assert(isUzs(l.amount), 'INVALID_INPUT', 'line amount must be a non-negative integer (UZS)');
    total += l.amount;
    assert(Number.isSafeInteger(total), 'INVALID_INPUT', 'purchase amount is too large');
  }
  assert(total > 0, 'INVALID_INPUT', 'purchase amount must be positive');
  assert(total <= rules.maxPurchaseAmount, 'INVALID_INPUT', `purchase amount exceeds the maximum of ${rules.maxPurchaseAmount}`);
  return total;
}

export function categoryTotal(lines: readonly PurchaseLine[], cat: Category): Uzs {
  return lines.filter((l) => l.category === cat).reduce((s, l) => s + l.amount, 0);
}

export function eligibleTotal(rules: LoyaltyRules, lines: readonly PurchaseLine[]): Uzs {
  return lines.filter((l) => rules.cashbackCategories[l.category]).reduce((s, l) => s + l.amount, 0);
}

export function findAvailableReward(state: ClientState, rewardId: string): Reward {
  const reward = state.rewards.find((r) => r.id === rewardId);
  assert(reward, 'REWARD_NOT_FOUND', `reward ${rewardId} not found`);
  assert(reward.status === 'available', 'REWARD_NOT_AVAILABLE', `reward ${rewardId} is ${reward.status}`);
  return reward;
}

export interface RewardEffect {
  /** Discount in UZS that the reward gives on this order. */
  discount: Uzs;
  /** Category the discount targets (free delivery / free card), null = whole order. */
  targetCategory: Category | null;
}

/**
 * Money effect of using a reward on an order.
 * - discount_pct: floor(amount * value%) on the whole order.
 * - free_delivery / free_card: the delivery / cards lines become free
 *   (capped by `value` when set). No such line = 0 discount, gift still used.
 * - custom: handed over physically, no money effect.
 */
export function rewardEffect(reward: Reward | null, lines: readonly PurchaseLine[], amount: Uzs): RewardEffect {
  if (!reward) return { discount: 0, targetCategory: null };
  switch (reward.type) {
    case 'discount_pct':
      return { discount: Math.min(amount, percentOf(amount, reward.value ?? 0)), targetCategory: null };
    case 'free_delivery':
    case 'free_card': {
      const cat: Category = reward.type === 'free_delivery' ? 'delivery' : 'cards';
      const lineTotal = categoryTotal(lines, cat);
      const cap = reward.value && reward.value > 0 ? reward.value : Infinity;
      return { discount: Math.min(lineTotal, cap), targetCategory: cat };
    }
    case 'custom':
      return { discount: 0, targetCategory: null };
  }
}

/** Max points that may be redeemed on an order of `amount` after `discount`. */
export function redeemCap(rules: LoyaltyRules, amount: Uzs, discount: Uzs): Uzs {
  return Math.max(0, Math.min(percentOf(amount, rules.maxRedeemPct), amount - discount));
}
