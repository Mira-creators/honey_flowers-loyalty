export type LoyaltyErrorCode =
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_BALANCE'
  | 'REDEEM_CAP_EXCEEDED'
  | 'DISCOUNT_WITH_POINTS_NOT_ALLOWED'
  | 'REWARD_NOT_FOUND'
  | 'REWARD_NOT_AVAILABLE'
  | 'PURCHASE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT';

/** Business rule violation. The API maps it to a 4xx response. */
export class LoyaltyError extends Error {
  constructor(
    public readonly code: LoyaltyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoyaltyError';
  }
}
