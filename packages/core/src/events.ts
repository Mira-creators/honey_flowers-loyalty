import type { RewardType, Uzs } from './types.js';

/**
 * Typed notifications produced by commands. The engine only describes what
 * happened; delivery (Telegram bot message, push, log) is done by the caller.
 */
export type LoyaltyEvent =
  | { type: 'welcome_bonus'; clientId: string; amount: Uzs; balance: Uzs }
  | { type: 'points_accrued'; clientId: string; purchaseId: string; amount: Uzs; balance: Uzs }
  | { type: 'points_redeemed'; clientId: string; purchaseId: string | null; amount: Uzs; balance: Uzs }
  | {
      type: 'card_advanced';
      clientId: string;
      purchaseId: string;
      cycle: number;
      cell: number;
      /** Purchases left until the next gift cell (null if no more gifts on this card). */
      purchasesToNextReward: number | null;
      cardCompleted: boolean;
    }
  | {
      type: 'reward_unlocked';
      clientId: string;
      rewardId: string;
      cycle: number;
      cell: number;
      rewardType: RewardType;
      title: string;
    }
  | { type: 'reward_used'; clientId: string; rewardId: string; purchaseId: string | null }
  | { type: 'level_up'; clientId: string; from: string; to: string; cashbackPct: number }
  | { type: 'level_down'; clientId: string; from: string; to: string; reason: 'expiry' | 'reversal' }
  | { type: 'expiry_warning'; clientId: string; daysLeft: number; balance: Uzs; expiresOn: string }
  | { type: 'points_expired'; clientId: string; amount: Uzs }
  | { type: 'card_reset'; clientId: string }
  | { type: 'purchase_reversed'; clientId: string; purchaseId: string; reason: string };

export type LoyaltyEventType = LoyaltyEvent['type'];
