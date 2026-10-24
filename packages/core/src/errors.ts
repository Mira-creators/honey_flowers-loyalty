export type LoyaltyErrorCode =
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_BALANCE'
  | 'REDEEM_CAP_EXCEEDED'
  | 'DISCOUNT_WITH_POINTS_NOT_ALLOWED'
  | 'REWARD_NOT_FOUND'
  | 'REWARD_NOT_AVAILABLE'
  | 'PURCHASE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVERSAL_WINDOW_EXPIRED'
  | 'REVERSAL_POINTS_SPENT'
  | 'REVERSAL_GIFT_USED';

/** Business rule violation. The API maps it to a 4xx response. */
export class LoyaltyError extends Error {
  constructor(
    public readonly code: LoyaltyErrorCode,
    message: string,
    /** Structured detail for the API's message (e.g. { hours } of the reversal window). */
    public readonly data: Record<string, number> = {},
  ) {
    super(message);
    this.name = 'LoyaltyError';
  }
}
