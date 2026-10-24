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
  /**
   * Owner grant without a purchase (commands/grant.ts): who granted the gift
   * and why. Absent / null for gifts unlocked on the honeycomb.
   */
  grantedBy?: string | null;
  grantReason?: string | null;
}

/**
 * 'import': the owner imported the old client base with "past purchases count on the card":
 * the bee is placed on a cell without unlocking the gifts it passed (no purchase attached).
 */
export type CardMoveReason = 'purchase' | 'expiry_reset' | 'import';

/** One step of the honeycomb card. The latest move is the current position. */
export interface CardMove {
  clientId: string;
  purchaseId: string | null;
  cycle: number;
  /** 1..cells for purchases and imports; 0 for a reset to an empty card. */
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
  /**
   * Storage may load only a BOUNDED part of a long history (apps/worker: the latest purchases, the
   * rows a command needs). `folded` sums up what is NOT in the arrays above, so every derived value
   * stays exact: balance (balanceOf), the level metric (deriveLevel) and the active purchase count.
   * Absent = the arrays hold the whole history.
   */
  folded?: FoldedHistory;
}

/** Aggregates of the facts a bounded state does not carry (see ClientState.folded). */
export interface FoldedHistory {
  /** Σ amount of the ledger entries not in `ledger`. */
  ledgerSum: Uzs;
  /** Active purchases not in `purchases`. */
  activeCount: number;
  /**
   * Active purchases not in `purchases` created at/after the level override's setAt (all of them
   * without an override): their amount sum and count — what deriveLevel adds (no level window).
   */
  levelSum: Uzs;
  levelCount: number;
  /** setAt of the override `levelSum` / `levelCount` were computed for (null = no override). */
  levelSince: Date | null;
  /**
   * Available gifts not in `rewards` (display / counts only: storage loads every available gift
   * when an expiry may reset the card, and any gift a command uses by id).
   */
  availableGifts?: number;
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
