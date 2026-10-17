/**
 * Domain types of the loyalty engine.
 *
 * Money and points are integer UZS (1 "мёд" = 1 сум). JavaScript numbers are
 * exact up to 2^53, which is far beyond any realistic balance; the database
 * stores them as BIGINT.
 */

/** Integer amount in UZS (сум). Points use the same unit. */
export type Uzs = number;

export const CATEGORIES = ['flowers', 'delivery', 'cards', 'wedding'] as const;
/** Sales category of a purchase line. Cashback can be enabled per category. */
export type Category = (typeof CATEGORIES)[number];

export interface PurchaseLine {
  category: Category;
  amount: Uzs;
}

export type Channel = 'store' | 'delivery';

export type LedgerType =
  | 'accrual'
  | 'redeem'
  | 'expire'
  | 'reversal'
  | 'welcome'
  | 'manual_adjust';

/**
 * One row of the points ledger. The balance is always the sum of `amount`
 * over all entries (see `balanceFromLedger`). `id` is assigned by storage.
 */
export interface LedgerEntry {
  id?: string;
  clientId: string;
  type: LedgerType;
  /** Signed: positive credits points, negative debits them. */
  amount: Uzs;
  purchaseId: string | null;
  staffId: string | null;
  reason: string | null;
  /** Dedupe key for operations without a purchase (standalone redeem, manual adjust). */
  idempotencyKey?: string | null;
  createdAt: Date;
}

export const REWARD_TYPES = ['free_card', 'free_delivery', 'discount_pct', 'custom'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

/** A reward placed into a honeycomb cell by the rules. */
export interface CellReward {
  cell: number;
  type: RewardType;
  /**
   * discount_pct: percent of the order (e.g. 10).
   * free_delivery / free_card: optional cap in UZS for the covered line(s).
   * custom: unused.
   */
  value?: number;
  title: string;
}

export type RewardStatus = 'available' | 'used' | 'revoked';

/** A reward unlocked for a client ("Подарки"). Identified by cycle + cell. */
export interface Reward {
  /** `${cycle}-${cell}-${unlockingPurchaseId}`: unique even if a cell is re-unlocked after a reversal. */
  id: string;
  clientId: string;
  cycle: number;
  cell: number;
  type: RewardType;
  value: number | null;
  title: string;
  status: RewardStatus;
  unlockedByPurchase: string | null;
  usedInPurchase: string | null;
  /** Idempotency key of a standalone redeem that used this reward. */
  usedIdempotencyKey?: string | null;
  unlockedAt: Date;
  usedAt: Date | null;
}

export type CardMoveReason = 'purchase' | 'expiry_reset';

/** One step of the honeycomb card. The latest move is the current position. */
export interface CardMove {
  clientId: string;
  purchaseId: string | null;
  cycle: number;
  /** 1..cells for purchases; 0 for a reset to an empty card. */
  cell: number;
  reason: CardMoveReason;
  createdAt: Date;
  /** Set when a reversal rolled this move back; reverted moves are ignored. */
  revertedAt?: Date | null;
}

/**
 * Manual level floor/reset. Effective level is
 * max(override level, level derived from purchases made AFTER `setAt`).
 * Set by expiry modes 'balance_and_level_down' and 'reset_all'.
 */
export interface LevelOverride {
  levelId: string;
  setAt: Date;
  /** Tier index at the time the override was set; used if the id is renamed by a rules edit. */
  levelIndex?: number;
}

export type PurchaseStatus = 'active' | 'reversed';

/** What happened to a purchase, stored for idempotent replays. */
export interface PurchaseSummary {
  amount: Uzs;
  discountApplied: Uzs;
  pointsRedeemed: Uzs;
  paid: Uzs;
  cashbackBase: Uzs;
  cashbackPct: number;
  cashback: Uzs;
  levelBefore: string;
  levelAfter: string;
  cellAdvanced: boolean;
  /** Why the card did not move (when cellAdvanced is false). */
  cellSkipReason: 'below_min_amount' | 'daily_limit' | null;
  cycle: number;
  cell: number;
  rewardsUnlocked: string[];
  balanceAfter: Uzs;
}

export interface PurchaseRecord {
  id: string;
  clientId: string;
  staffId: string | null;
  idempotencyKey: string;
  amount: Uzs;
  lines: PurchaseLine[];
  channel: Channel;
  pointsRedeemed: Uzs;
  discountApplied: Uzs;
  rewardUsedId: string | null;
  rulesVersion: number;
  status: PurchaseStatus;
  reversedReason: string | null;
  reversedBy: string | null;
  reversedAt: Date | null;
  createdAt: Date;
  result: PurchaseSummary | null;
}

/**
 * Everything the engine needs to know about one client. It is a plain
 * snapshot of stored facts (ledger, purchases, card moves, rewards); all
 * derived values (balance, level, card position, expiry) are computed from it.
 */
export interface ClientState {
  clientId: string;
  registeredAt: Date;
  levelOverride: LevelOverride | null;
  purchases: PurchaseRecord[];
  ledger: LedgerEntry[];
  cardMoves: CardMove[];
  rewards: Reward[];
  /** Dedupe keys of notifications already sent (e.g. expiry warnings). */
  sentNotificationKeys: string[];
}

export function emptyClientState(clientId: string, registeredAt: Date): ClientState {
  return {
    clientId,
    registeredAt,
    levelOverride: null,
    purchases: [],
    ledger: [],
    cardMoves: [],
    rewards: [],
    sentNotificationKeys: [],
  };
}
