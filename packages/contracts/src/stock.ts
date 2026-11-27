/**
 * «Склад» (stock module, prototype) — HTTP contract. Behind the STOCK_ENABLED flag: when it is off
 * every /api/stock/* and /api/owner/stock/* route answers 404.
 * Money: integer сум (`*_uzs` / plain numbers); lot unit costs in milli-сум (`*Mu`, 1 сум = 1000 mu).
 * Quantities: integer base units (stems, pieces, cm).
 * See docs/Склад — архитектура.md §5.
 */

export type StockKind = 'flower' | 'greenery' | 'supply' | 'service';
export type StockBaseUnit = 'stem' | 'pcs' | 'cm' | 'sheet' | 'g';
export type StockFreshness = 'overdue' | 'today' | 'soon' | 'fresh';
export type WriteoffReason = 'wilt' | 'damage' | 'supplier' | 'other';
export type BouquetStatus = 'assembled' | 'on_showcase' | 'sold' | 'disassembled' | 'written_off' | 'cancelled';

/** GET /api/stock/status → 200 when the module is on (404 otherwise). */
export interface StockStatusDTO {
  enabled: true;
  role: 'florist' | 'manager' | 'owner';
  canReceive: boolean;
  canEditCatalog: boolean;
  canApprove: boolean;
}

export interface StockPricingDTO {
  flowersMultiplier: number;
  suppliesMultiplier: number;
  labourPct: number;
  round: { step: number; offset: number };
  targets: { costShare: number; flowersShare: number; amberBandPp: number };
  priceMode: 'suggest' | 'fixed';
}

export interface PublicStockConfigDTO {
  pricing: StockPricingDTO;
  negativePolicy: 'block' | 'warn' | 'allow';
  writeoffApprovalUzs: number;
  assemblyCancelHours: number;
  receiptRoles: Array<'florist' | 'manager' | 'owner'>;
  backdateDays: number;
}

export interface StockLadderStepDTO { lotId: string; qty: number; unitCostMu: number; freshness: StockFreshness; receivedOn: string }

export interface StockItemDTO {
  id: string;
  sku: string;
  name: string;
  kind: StockKind;
  group: string;
  unit: { base: StockBaseUnit; display: string; factor: number; pack: { name: string; size: number } | null };
  emoji: string | null;
  color: string | null;
  trackStock: boolean;
  active: boolean;
  /** Base units on hand; may be < 0 (sold «в минус»). */
  qty: number;
  valueMu: number;
  /** First open lots in picking order (FIFO/FEFO), for the phone-side cost preview. */
  ladder: StockLadderStepDTO[];
  /** Σ positive lots: what can be picked without going «в минус» (qty also counts a negative deficit lot). */
  available: number;
  /** Cost of a unit sold «в минус» / of an untracked supply: last receipt cost → std cost. */
  lastCostMu: number | null;
  stdCostMu: number | null;
  markupX100: number | null;
  vaseLifeDays: number | null;
  sellDays: number | null;
  warnDays: number;
  ikpu: string | null;
  version: number;
  /** Assemblies with this item in the last 30 days (tile order «most used first»). */
  uses30d: number;
}

/** GET /api/stock/catalog (If-None-Match → 304). */
export interface StockCatalogDTO {
  rev: string;
  today: string;
  items: StockItemDTO[];
  config: PublicStockConfigDTO;
}

export interface StockTemplateDTO { id: string; name: string; lines: Array<{ itemId: string; qty: number }>; price: number | null }

export interface StockSupplierDTO { id: string; name: string; phone: string | null }

/** POST /api/owner/stock/items, PUT /api/owner/stock/items/:id (with version). */
export interface StockItemInput {
  sku: string;
  name: string;
  kind: StockKind;
  group: string;
  baseUnit: StockBaseUnit;
  displayUnit: string;
  displayFactor?: number;
  packName?: string | null;
  packSize?: number | null;
  vaseLifeDays?: number | null;
  sellDays?: number | null;
  warnDays?: number;
  trackStock?: boolean;
  stdCost?: number | null;           // сум per base unit (stored as mu)
  markupX100?: number | null;
  loosePrice?: number | null;
  ikpu?: string | null;
  emoji?: string | null;
  color?: string | null;
  sortOrder?: number;
  active?: boolean;
  version?: number;
}

// ------------------------------------------------------------------ receipts

export interface ReceiptLineRequest {
  itemId: string;
  qty: number;
  unit: 'base' | 'pack';
  /** Price in the receipt currency: сум (integer) or dollars (≤ 2 decimals). In 'total' mode only a manual override. */
  price?: number | null;
  per?: 'unit' | 'pack' | 'line';
}

export interface ReceiptRequest {
  idempotencyKey: string;
  docDate?: string | null;            // default today (Tashkent); back ≤ backdateDays, owner only
  supplierId?: string | null;
  currency: 'UZS' | 'USD';
  fxRate?: number | null;             // сум for 1 USD, ≤ 2 decimals
  priceMode: 'lines' | 'total';
  total?: number | null;              // 'total' mode: the delivery in the receipt currency
  extraCost?: number;                 // сум (delivery, customs) → spread over lines by value
  lines: ReceiptLineRequest[];
  note?: string | null;
  confirm?: boolean;                  // warnings acknowledged (required to post when there are warnings)
}

export interface ReceiptPreviewLineDTO {
  lineNo: number;
  itemId: string;
  name: string;
  qtyBase: number;
  manual: boolean;
  /** Line value in the receipt currency (сум or dollars), before extra costs. */
  lineValue: number;
  /** Unit cost with extra costs: in сум and (USD receipts) in dollars. */
  unitCostUzs: number;
  unitCostCur: number;
  unitCostMu: number;
  landedUzs: number;
  lastCostUzs: number | null;
}

export interface ReceiptPreviewDTO {
  currency: 'UZS' | 'USD';
  fxRate: number | null;
  lines: ReceiptPreviewLineDTO[];
  goodsUzs: number;
  goodsCur: number;
  extraUzs: number;
  totalUzs: number;
  warnings: Array<{ code: string; lineNo?: number; message: string }>;
}

export interface ReceiptResultDTO { receiptId: string; number: number; replayed: boolean; preview: ReceiptPreviewDTO; settledDeficit: number }

export interface ReceiptListItemDTO {
  id: string; number: number; docDate: string; status: 'posted' | 'cancelled'; currency: 'UZS' | 'USD'; fxRate: number | null;
  priceMode: 'lines' | 'total'; totalUzs: number; extraUzs: number; lines: number; supplier: string | null; actor: string; createdAt: string;
  cancellable: boolean;
}

/** GET /api/stock/receipts/form — what the receipt form needs. */
export interface ReceiptFormDTO { lastFxRate: number | null; suppliers: StockSupplierDTO[]; today: string; backdateDays: number; canBackdate: boolean; nextNumber: number }

// ------------------------------------------------------------------ bouquets

export interface AssembleRequest {
  idempotencyKey: string;
  kind: 'order' | 'showcase';
  templateId?: string | null;
  lines: Array<{ itemId: string; qty: number; plannedQty?: number | null }>;
  price?: number | null;              // null → suggested
  allowShort?: boolean;
  shortComment?: string | null;
  /** Cost the phone showed (сум); the answer says costChanged when the server's FIFO differs. */
  expectedCost?: number | null;
}

export interface BouquetLineDTO {
  itemId: string; name: string; kind: StockKind; qty: number; plannedQty: number | null; cost: number;
  lots: Array<{ lotId: string; receivedOn: string; qty: number; deficit: boolean }>;
}

export interface BouquetDTO {
  id: string; number: number; kind: 'order' | 'showcase'; status: BouquetStatus;
  cost: number; flowersCost: number; suppliesCost: number;
  suggestedPrice: number; price: number; priceCurrent: number;
  costShare: number; flowersShare: number;
  lines: BouquetLineDTO[];
  usedDeficit: boolean; deficitComment: string | null; florist: string; createdAt: string; saleId: string | null;
  ageDays: number;
}

export interface AssembleResultDTO { bouquet: BouquetDTO; replayed: boolean; warnings: string[]; costChanged: boolean }

/** error.details of a 409 stock_short. */
export interface StockShortDetails { short: Array<{ itemId: string; name: string; need: number; have: number }>; canForce: boolean }

export interface DisassembleRequest { idempotencyKey: string; good: Array<{ itemId: string; qty: number }> }
export interface DisassembleResultDTO { bouquet: BouquetDTO; returned: number; wasted: number; wasteUzs: number; replayed: boolean }

export interface SaveTemplateRequest { name: string; lines: Array<{ itemId: string; qty: number }>; price?: number | null }

// ------------------------------------------------------------------ sales (bouquet → loyalty)

export interface StockSaleRequest {
  idempotencyKey: string;
  clientId?: string | null;
  bouquets: Array<{ id: string; price?: number | null }>;
  /** Services (delivery): earn no honey (cashback category 'delivery'). */
  services?: Array<{ itemId: string; price: number }>;
  channel?: 'store' | 'delivery';
  redeem?: boolean;
  /** Honey amount shown in the preview; the sale takes exactly this or fails with a clear reason. */
  redeemPoints?: number | null;
  giftId?: string | null;
  paymentMethod: 'cash' | 'card' | 'transfer' | 'mixed';
}

export interface StockSalePreviewDTO {
  total: number;
  lines: Array<{ kind: 'bouquet' | 'service'; name: string; price: number; category: string }>;
  /** Loyalty preview (null without a client). */
  loyalty: { paid: number; redeemed: number; discount: number; cashback: number; maxRedeem: number; pct: number; cell: number | null } | null;
}

export interface StockSaleResultDTO {
  saleId: string;
  number: number;
  replayed: boolean;
  total: number;
  paid: number;
  honeyRedeemed: number;
  cashback: number;
  /** 'none' (no client) | 'done' | 'failed' (stock part is posted; honey can be retried). */
  loyaltyStatus: 'none' | 'pending' | 'done' | 'failed';
  loyaltyError: string | null;
  purchaseId: string | null;
  clientBalance: number | null;
  warnings: string[];
}

// ------------------------------------------------------------------ write-offs, freshness

export interface WriteoffRequest {
  idempotencyKey: string;
  lines: Array<{ itemId: string; qty: number; reason: WriteoffReason; lotId?: string | null }>;
  note?: string | null;
}

export interface WriteoffResultDTO { docId: string; number: number; valueUzs: number; approval: 'none' | 'pending' | 'approved'; replayed: boolean }

export interface FreshLotDTO {
  lotId: string; itemId: string; name: string; emoji: string | null; qty: number; valueUzs: number;
  receivedOn: string; sellBy: string | null; freshness: StockFreshness; priority: boolean;
}

export interface FreshnessDTO {
  today: string;
  atRiskUzs: number;
  groups: Record<StockFreshness, { count: number; valueUzs: number; lots: FreshLotDTO[] }>;
}

export interface PendingWriteoffDTO {
  docId: string; number: number; valueUzs: number; createdAt: string; actor: string; note: string | null;
  lines: Array<{ name: string; qty: number; reason: string; valueUzs: number }>;
}

// ------------------------------------------------------------------ owner overview / console

export interface StockOverviewDTO {
  today: string;
  stockValueUzs: number;
  items: number;
  lowItems: Array<{ itemId: string; name: string; qty: number }>;
  expiring: { overdue: number; today: number; soon: number; atRiskUzs: number };
  todayBouquets: { count: number; sold: number; revenueUzs: number; costUzs: number; avgMarginPct: number | null };
  wasteWeek: { wasteUzs: number; cogsUzs: number; pct: number | null; normPct: number; alarmPct: number };
  lastReceipts: ReceiptListItemDTO[];
  pendingApprovals: PendingWriteoffDTO[];
  loyaltyPending: number;
  deficits: Array<{ itemId: string; name: string; qty: number }>;
  showcase: { count: number; valueUzs: number };
}

export interface StockBalanceRowDTO {
  itemId: string; sku: string; name: string; group: string; kind: StockKind; unit: string; qty: number; valueUzs: number;
  lots: number; oldestOn: string | null; lastCostUzs: number | null;
}

export interface StockBouquetRowDTO {
  id: string; number: number; createdAt: string; kind: 'order' | 'showcase'; status: BouquetStatus; florist: string;
  cost: number; suggestedPrice: number; price: number; soldFor: number | null; marginPct: number | null; usedDeficit: boolean;
  composition: string;
}

export interface StockWriteoffRowDTO {
  docId: string; number: number; docDate: string; createdAt: string; actor: string; item: string; qty: number; reason: WriteoffReason | 'disassembly_waste';
  valueUzs: number; approval: 'none' | 'pending' | 'approved' | 'rejected'; status: 'posted' | 'cancelled';
}

export interface StockPageDTO<T> { items: T[]; cursor: string | null; total?: number }
