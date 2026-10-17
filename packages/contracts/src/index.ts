/**
 * HTTP contract between the Mini App (apps/miniapp) and the Worker (apps/worker).
 * Both sides import these types. All money/points are integer UZS. Dates are ISO strings.
 *
 * Auth: every /api request carries `Authorization: tma <Telegram.WebApp.initData>`.
 * In TEST_MODE only, a request may instead carry `X-Test-User: <telegramId>` (browser testing
 * outside Telegram). Errors: non-2xx with body ApiError.
 */

export type Lang = 'ru' | 'uz';
export type Role = 'client' | 'florist' | 'manager' | 'owner';
export type Channel = 'store' | 'delivery';

export interface ApiError {
  error: {
    code:
      | 'unauthorized' | 'forbidden' | 'not_found' | 'validation'
      | 'not_registered' | 'insufficient_points' | 'conflict' | 'already_reversed' | 'internal';
    message: string; // Russian, safe to show to staff
  };
}

export interface LevelInfo { id: string; name: string; pct: number; from: number }
export interface NextLevelInfo extends LevelInfo { left: number }

export interface GiftDTO {
  id: string;
  type: string;            // 'card' | 'delivery' | 'disc10' | 'disc15' | 'mini' | ...
  cycle: number;
  cell: number;
  status: 'available' | 'used' | 'revoked';
  unlockedAt: string;
  usedAt: string | null;
}

export type HistoryKind = 'purchase' | 'welcome' | 'redeem' | 'expire' | 'reversal' | 'manual' | 'gift_used';
export interface HistoryItemDTO {
  id: string;
  at: string;
  kind: HistoryKind;
  points: number;               // signed change of the points balance
  purchaseId?: string;
  purchaseAmount?: number;      // for kind=purchase
  pct?: number;                 // cashback % applied
  cell?: number | null;         // card cell this purchase filled
  redeemed?: number;            // points spent inside this purchase
  status?: 'active' | 'reversed';
  reason?: string;              // reversal / manual reason
  staffName?: string;
}

export interface CardDTO {
  cycle: number;
  filled: number;               // cells filled in the current cycle, 0..cells
  cells: number;
  gifts: Record<string, string>; // cell number -> gift type (positions are public, contents shown as "?" by the UI)
}

export interface ClientSummaryDTO {
  id: string;
  name: string;
  phoneMasked: string;          // "+998 90 ••• •• 67"
  code: string;                 // short code encoded in the QR, e.g. "HF4821"
  lang: Lang;
  balance: number;
  spent: number;                // sum counted toward levels
  level: LevelInfo;
  next: NextLevelInfo | null;
  card: CardDTO;
  expiresAt: string | null;     // when the current balance burns (null if balance 0)
  gifts: GiftDTO[];             // newest first
  history: HistoryItemDTO[];    // newest first, max 50
}

export interface PublicRulesDTO {
  minPurchaseForCell: number;
  maxRedeemPct: number;
  expiryDays: number;
  welcomeBonus: number;
  levels: LevelInfo[];
  cells: number;
}

/** GET /api/me */
export interface MeDTO {
  telegramId: number;
  firstName: string;
  role: Role;                   // effective role (in TEST_MODE the tester can switch it)
  testMode: boolean;
  registered: boolean;          // has a client profile with phone
  client: ClientSummaryDTO | null;
  rules: PublicRulesDTO;
  now: string;                  // server "now" incl. test clock offset
  clockOffsetDays: number;      // TEST_MODE time travel, 0 otherwise
  botUsername: string | null;
}

/** POST /api/me/lang */
export interface SetLangRequest { lang: Lang }

/**
 * Registration happens through the bot: the Mini App calls Telegram.WebApp.requestContact(),
 * Telegram sends the contact to the bot webhook, the Worker creates the client and credits the
 * welcome bonus. The Mini App then polls GET /api/me until registered=true.
 * In TEST_MODE there is also POST /api/test/register { phone, name } for browser testing.
 */

/** GET /api/staff/client?q=<code | phone digits> */
export interface StaffClientLookupDTO { client: ClientSummaryDTO | null; matches: Array<{ id: string; name: string; phoneMasked: string }> }

/** POST /api/staff/purchase/preview — nothing is saved */
export interface PurchasePreviewRequest { clientId: string; amount: number; redeem: boolean; giftId?: string | null; channel?: Channel }
export interface PurchasePreviewDTO {
  amount: number;
  maxRedeem: number;
  redeemed: number;
  discount: number;             // from an applied gift (e.g. disc10)
  paid: number;                 // money part
  cashback: number;
  pct: number;
  cell: number | null;          // which cell would be filled, null if below minimum / daily limit
  cellBlockedReason: 'below_min' | 'daily_limit' | null;
  unlocksGift: boolean;         // the filled cell holds a gift (type not revealed to staff? — revealed: staff may see it)
  giftType: string | null;
}

/** POST /api/staff/purchase */
export interface PurchaseRequest extends PurchasePreviewRequest { idempotencyKey: string }
export interface PurchaseResultDTO {
  purchaseId: string;
  replayed: boolean;            // same idempotencyKey seen before -> original result
  preview: PurchasePreviewDTO;  // what was actually applied
  giftsUnlocked: GiftDTO[];
  levelUp: LevelInfo | null;
  newCard: boolean;             // the card was completed and restarted
  client: ClientSummaryDTO;
  warnings: string[];
}

/** POST /api/staff/purchase/:id/reverse */
export interface ReverseRequest { reason: string }
export interface ReverseResultDTO { client: ClientSummaryDTO; warnings: string[] }

/** POST /api/staff/gift/:id/use  (marks a gift used outside a purchase, e.g. free card handed over) */
export interface UseGiftResultDTO { client: ClientSummaryDTO }

/** GET /api/staff/recent — last 20 operations by anyone (for the florist "recent" list) */
export interface OperationDTO {
  id: string; at: string; kind: HistoryKind; points: number;
  clientId: string; clientName: string; staffName: string | null;
  purchaseId?: string; purchaseAmount?: number; status?: 'active' | 'reversed';
}

/** GET /api/owner/stats */
export interface OwnerStatsDTO {
  clients: number;
  clientsNew7d: number;
  purchases: number;
  purchases7d: number;
  revenueWithCard: number;
  repeatRate90d: number;        // share of clients with >=2 purchases within 90 days, 0..1
  points: { accrued: number; redeemed: number; expired: number; outstanding: number };
  giftsUnlocked: number;
  giftsUsed: number;
  perWeek: Array<{ weekStart: string; purchases: number }>; // last 8 weeks
}

/** GET /api/owner/rules -> EditableRulesDTO ; PUT /api/owner/rules (same body) -> EditableRulesDTO */
export interface EditableRulesDTO {
  levels: Array<{ id: string; name: string; pct: number; from: number }>; // 1..5 levels, first from=0
  minPurchaseForCell: number;
  maxCellsPerDay: number;
  maxRedeemPct: number;
  expiryDays: number;
  expiryWarnDays: number[];
  welcomeBonus: number;
  cells: number;                // 10 fixed for now
  gifts: Record<string, string>; // cell -> gift type
  version: number;
}

/** GET /api/owner/staff ; POST /api/owner/staff { phoneOrTelegramId, role } ; DELETE /api/owner/staff/:id */
export interface StaffDTO { id: string; telegramId: number | null; name: string; role: Exclude<Role, 'client'>; active: boolean }

/** GET /api/owner/operations?limit=100 -> OperationDTO[] */

/* ---------------- TEST_MODE only (404 otherwise) ---------------- */
/** POST /api/test/role { role } — switch the caller's own effective role */
export interface TestRoleRequest { role: Role }
/** POST /api/test/clock { days } — move the global test clock forward by N days (0 resets: { reset: true }) */
export interface TestClockRequest { days?: number; reset?: boolean }
/** POST /api/test/run-expiry — runs the daily expiry/warnings job now; returns counts */
export interface TestRunExpiryDTO { expired: number; warned: number }
/** POST /api/test/reset-me — deletes the caller's client data (to replay onboarding) */
/** POST /api/test/register { phone, name } — browser-only registration shortcut */
export interface TestRegisterRequest { phone: string; name: string }
