/**
 * HTTP contract between the Mini App (apps/miniapp) and the Worker (apps/worker).
 * Both sides import these types. All money/points are integer UZS. Dates are ISO strings.
 *
 * Auth: every /api request carries `Authorization: tma <Telegram.WebApp.initData>`.
 * In TEST_MODE only, a request may instead carry `X-Test-User: <id >= 900000000>` together with
 * `X-Test-Key: <TEST_KEY secret>` (browser testing outside Telegram). Errors: non-2xx with body ApiError.
 */

export type Lang = 'ru' | 'uz';
export type Role = 'client' | 'florist' | 'manager' | 'owner';
export type Channel = 'store' | 'delivery';

export interface ApiError {
  error: {
    code:
      | 'unauthorized' | 'expired' | 'forbidden' | 'not_found' | 'validation'
      | 'not_registered' | 'insufficient_points' | 'conflict' | 'already_reversed' | 'internal'
      | 'self_operation';
    // 'self_operation' (403): a staff member tried to charge / redeem / hand out a gift on their OWN card
    // (allowed only for the owner in TEST_MODE).
    // 'expired' (401): Telegram initData is older than the server allows — the app must be
    // closed and reopened from Telegram (initData is refreshed only on reopen).
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
  source?: 'grant';         // 'grant' = given by the owner without a purchase (not tied to a cell); absent = honeycomb gift
  reason?: string;          // owner grant: why ("день рождения")
}

export type HistoryKind = 'purchase' | 'welcome' | 'redeem' | 'expire' | 'reversal' | 'manual' | 'gift_used' | 'gift_granted';
export interface HistoryItemDTO {
  id: string;
  at: string;
  kind: HistoryKind;
  points: number;               // signed change of the points balance (purchase: cashback - redeemed)
  cashback?: number;            // for kind=purchase: points accrued by this purchase, >= 0
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
  expiresOn: string | null;     // LAST day the balance is still valid, 'YYYY-MM-DD' Tashkent (null if balance 0)
  expiresAt: string | null;     // instant the balance burns = start (00:00 Tashkent) of the day AFTER expiresOn;
                                // kept for compatibility — show expiresOn, not this date
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
  /** Show «🧪 Тест»: TEST_MODE is on AND this caller is a tester (TEST_USERS). False for everyone else. */
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

/** GET /api/staff/client?q=<code | phone digits | client id (UUID, e.g. picked from `matches`)> */
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
  reason?: string;              // reversal / manual adjustment / owner grant reason
  /** Active purchases only: may staff still reverse it (window, gift unused, мёд unspent)? */
  reversible?: boolean;
  /** Why not (Russian, shown instead of «Отменить»). */
  reverseBlocked?: string;
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
  /** Staff may reverse a purchase only within this many hours (1..720, default 24). */
  reversalWindowHours: number;
  cells: number;                // 10 fixed for now
  gifts: Record<string, string>; // cell -> gift type
  version: number;
}

/** GET /api/owner/staff ; POST /api/owner/staff { phoneOrTelegramId, role } ; DELETE /api/owner/staff/:id */
export interface StaffDTO { id: string; telegramId: number | null; name: string; role: Exclude<Role, 'client'>; active: boolean }

/** GET /api/owner/operations?limit=100 -> OperationDTO[] */

/**
 * POST /api/owner/clients/:id/grant — owner gives a gift or bonus мёд WITHOUT a purchase.
 * Idempotent: `Idempotency-Key` header or `idempotencyKey` in the body (8..100 chars); a replay
 * returns the original result with replayed=true (200), a new grant answers 201.
 * giftId = a gift type code the rules use on the honeycomb ('card' | 'delivery' | 'disc10' | 'mini' ...).
 * The client gets the usual Telegram message; the operations journal shows it with the reason.
 */
export type OwnerGrantRequest =
  | { kind: 'gift'; giftId: string; reason: string; idempotencyKey?: string }
  | { kind: 'honey'; points: number; reason: string; idempotencyKey?: string };
export interface OwnerGrantResultDTO {
  replayed: boolean;
  gift: GiftDTO | null;         // kind=gift
  points: number;               // kind=honey: мёд credited (0 for a gift)
  client: ClientSummaryDTO;
}

/* ---------------- owner: client base ---------------- */

/** Status filter of the client list (all windows are counted from the server "now"). */
export type ClientStatus =
  | 'active'     // a purchase within the last 90 days
  | 'sleeping'   // last purchase 60–90 days ago (a subset of active: worth a nudge)
  | 'lost'       // no purchase for more than 90 days, or never
  | 'expiring'   // balance > 0 and it burns within 7 days
  | 'birthday';  // birthday within the next 7 days (clients that told the bot their birthday)
export type ClientSort = 'last_purchase_desc' | 'spent_desc' | 'balance_desc' | 'name' | 'created_desc';

/**
 * GET /api/owner/clients?q=&level=&status=&sort=&cursor=&limit=  → ClientListDTO
 *   q       free text: client code ("HF4821"), phone digits (4+), or part of the name
 *   level   LevelInfo.id
 *   status  ClientStatus
 *   sort    ClientSort (default last_purchase_desc)
 *   cursor  opaque, from the previous page's nextCursor (keyset pagination: stable while scrolling)
 *   limit   1..100, default 30
 * Rows come from the client_stats summary table (maintained in the same transaction as every
 * engine write), so a page costs O(limit) rows regardless of the size of the base.
 */
export interface ClientRowDTO {
  id: string;
  name: string;
  phoneMasked: string;
  code: string;
  levelId: string;
  levelName: string;
  balance: number;
  spent: number;                // level metric (sum counted toward the level)
  purchases: number;            // active (not reversed) purchases
  lastPurchaseAt: string | null;
  expiresOn: string | null;     // last day the balance is valid, 'YYYY-MM-DD' Tashkent; null if balance <= 0
  giftsAvailable: number;
  registeredAt: string;
}
export interface ClientListDTO {
  items: ClientRowDTO[];
  nextCursor: string | null;    // null = last page
}

/**
 * GET /api/owner/clients/:id → OwnerClientDTO: the client card as the client sees it
 * (ClientSummaryDTO, newest 50 history items + cursor) plus what only staff may see.
 */
/** GET /api/owner/clients/:id/history?cursor= → the next page of a client's history (50, newest first). */
export interface OwnerHistoryPageDTO {
  items: HistoryItemDTO[];
  next: string | null;
}

export interface OwnerClientDTO extends ClientSummaryDTO {
  /** history = the newest 50 items; more: GET /api/owner/clients/:id/history?cursor=<historyNext> */
  historyNext?: string | null;
  phone: string | null;         // unmasked, E.164
  telegramId: number;
  registeredAt: string;
  language: Lang;
  birthday: string | null;      // 'YYYY-MM-DD'
  note: string | null;          // free text written by the owner / staff (<= 500 chars)
}

/**
 * POST /api/owner/clients/:id/adjust { points, reason } → AdjustResultDTO
 * Manual correction of the balance (signed integer, |points| <= rules.maxPurchaseAmount),
 * recorded in the ledger as manual_adjust with the acting staff id; the client gets a bot message.
 * `idempotencyKey` is optional: repeating a request with the same key does not adjust twice.
 */
export interface AdjustRequest { points: number; reason: string; idempotencyKey?: string }
export interface AdjustResultDTO { client: OwnerClientDTO; replayed: boolean; warnings: string[] }

/** PUT /api/owner/clients/:id/note { note } → { note }  (empty string clears the note) */
export interface NoteRequest { note: string }
export interface NoteDTO { note: string | null }

/**
 * CSV export (owner only). The response is a streamed text/csv file: UTF-8 with BOM,
 * ';' separator (Excel in ru/uz locales), dates as 'YYYY-MM-DD HH:MM' Tashkent,
 * Content-Disposition: attachment.
 *   GET /api/owner/export/clients.csv
 *   GET /api/owner/export/operations.csv?from=YYYY-MM-DD&to=YYYY-MM-DD   (default: last 90 days; at most 50 000 rows → 400 otherwise)
 * Both also accept `?token=` from POST /api/owner/export/link instead of the auth header, so the
 * file can be opened in a normal browser (Telegram's WebView cannot download). A token works once
 * and expires after 10 minutes.
 */
export type ExportKind = 'clients' | 'operations';
export interface ExportLinkRequest { kind: ExportKind; from?: string; to?: string } // dates 'YYYY-MM-DD' (operations only)
export interface ExportLinkDTO { url: string; expiresAt: string }

/* ---------------- TEST_MODE only (404 otherwise) ---------------- */
/** POST /api/test/role { role } — switch the caller's own effective role */
export interface TestRoleRequest { role: Role }
/** POST /api/test/clock { days } — move the global test clock forward by N days (0 resets: { reset: true }) */
export interface TestClockRequest { days?: number; reset?: boolean }
/** POST /api/test/run-expiry — runs the daily expiry/warnings job now; returns counts */
export interface TestRunExpiryDTO { expired: number; warned: number; checked: number; more: boolean }
/** POST /api/test/reset-me — deletes the caller's client data (to replay onboarding) */
/** POST /api/test/register { phone, name } — browser-only registration shortcut */
export interface TestRegisterRequest { phone: string; name: string }

/* ---------------- Owner web console (console.html): DTOs + import helpers ---------------- */
export * from './console.js';
/**
 * POST /api/test/demo-seed { chunk } — fills the program with ~250 realistic demo clients, a few
 * per request (call chunk 0, 1, … until finished). Deterministic and idempotent; demo clients are
 * never messaged. POST /api/test/demo-clear — removes exactly the demo records.
 */
export interface TestDemoSeedRequest { chunk: number }
export interface TestDemoSeedDTO {
  chunk: number;
  chunks: number;               // total number of chunks
  total: number;                // demo clients in the full set
  done: number;                 // demo clients that exist after this chunk (progress)
  created: number;              // clients created by this call (0 on a re-run)
  finished: boolean;
  nextChunk: number | null;
}
export interface TestDemoClearDTO { clients: number; staff: number }
