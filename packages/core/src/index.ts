/**
 * @honey/core — pure rules engine of the Honey Flowers loyalty program.
 * No IO and no clock: every command receives `now` explicitly.
 */
export * from './types.js';
export * from './errors.js';
export * from './events.js';
export * from './rules.js';
export { defaultRules, RULES_V1_PLACEHOLDER } from './defaultRules.js';
export * from './time.js';
export * from './money.js';
export * from './outcome.js';
export * from './state.js';
export { registerClient } from './commands/register.js';
export { applyPurchase, maxRedeemable, cellMovesOnDay, rewardId, type PurchaseInput } from './commands/purchase.js';
export { redeem, type RedeemInput } from './commands/redeem.js';
export { reversePurchase, reversalBlock, type ReverseInput, type ReversalBlock } from './commands/reverse.js';
export { runExpiry, settleExpiry, levelTimer } from './commands/expiry.js';
export {
  birthdayCheck,
  birthdayWindow,
  birthdayRewardId,
  birthdayIn,
  birthdayGiftTitle,
  isBirthdayReward,
  parseBirthday,
  BIRTHDAY_REWARD_PREFIX,
  type BirthdayWindow,
} from './commands/birthday.js';
export { manualAdjust, type ManualAdjustInput } from './commands/manualAdjust.js';
export {
  grantGift,
  grantPoints,
  grantRewardId,
  isGrantedReward,
  GRANT_REWARD_PREFIX,
  type GrantGiftInput,
  type GrantPointsInput,
} from './commands/grant.js';
