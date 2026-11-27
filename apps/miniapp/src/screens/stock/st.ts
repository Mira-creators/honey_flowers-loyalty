/** «Склад» screens: state and shared helpers (catalog cache with ETag, phone-side FIFO cost). */
import type {
  BouquetDTO, FreshnessDTO, ReceiptFormDTO, ReceiptPreviewDTO, StockCatalogDTO, StockItemDTO, StockOverviewDTO, StockSalePreviewDTO,
  StockSaleResultDTO, StockStatusDTO, StockTemplateDTO, ClientSummaryDTO, StockShortDetails,
} from '@honey/contracts';
import { bouquetCost, pickLots, shareLevel, shares, suggestPrice, type CostLine } from '@honey/stock';
import { newIdempotencyKey } from '../../api';
import { app } from '../../state';
import { esc, fmt } from '../../ui/dom';
import { sapi } from './sapi';

export type StockScreen = 'home' | 'bouquet' | 'fresh' | 'showcase' | 'receipt' | 'sell' | 'catalog';
/** Florist tabs. 'desk' = the existing cash desk. */
export type FloristTab = 'desk' | 'bouquet' | 'fresh' | 'showcase';

export interface ReceiptLineDraft { itemId: string; qty: string; unit: 'base' | 'pack'; price: string; per: 'unit' | 'pack' | 'line' }

export const ST = {
  status: null as StockStatusDTO | null,
  probed: false,
  /** Florist / manager: current tab; owner: the «Склад» tab shows `screen`. */
  ftab: 'desk' as FloristTab,
  screen: 'home' as StockScreen,
  catalog: null as StockCatalogDTO | null,
  catalogEtag: null as string | null,
  templates: [] as StockTemplateDTO[],
  error: null as string | null,
  busy: false,
  builder: {
    qty: {} as Record<string, number>,
    planned: {} as Record<string, number> | null,
    templateId: null as string | null,
    kind: 'order' as 'order' | 'showcase',
    price: '' as string,
    priceEdited: false,
    group: '' as string,
    q: '' as string,
    idem: '',
    short: null as StockShortDetails | null,
  },
  sell: {
    bouquets: [] as BouquetDTO[],
    price: '' as string,
    client: null as ClientSummaryDTO | null,
    query: '',
    matches: [] as Array<{ id: string; name: string; phoneMasked: string }>,
    redeem: false,
    giftId: null as string | null,
    channel: 'store' as 'store' | 'delivery',
    delivery: '30000',
    payment: 'cash' as 'cash' | 'card' | 'transfer' | 'mixed',
    preview: null as StockSalePreviewDTO | null,
    previewError: null as string | null,
    idem: '',
    result: null as StockSaleResultDTO | null,
  },
  showcase: null as BouquetDTO[] | null,
  fresh: null as FreshnessDTO | null,
  overview: null as StockOverviewDTO | null,
  receipt: {
    form: null as ReceiptFormDTO | null,
    currency: 'UZS' as 'UZS' | 'USD',
    fx: '',
    mode: 'lines' as 'lines' | 'total',
    total: '',
    extra: '',
    supplierId: '',
    docDate: '',
    lines: [] as ReceiptLineDraft[],
    preview: null as ReceiptPreviewDTO | null,
    idem: '',
  },
};

export const stockOn = () => !!ST.status;
export const money = (n: number) => `${fmt(n)} сум`;
export const itemById = (id: string): StockItemDTO | undefined => ST.catalog?.items.find((i) => i.id === id);
export const tile = (it: Pick<StockItemDTO, 'emoji' | 'color'>) => `<span class="st-emo" style="background:${esc(it.color ?? 'var(--c-surface2)')}">${esc(it.emoji ?? '🌼')}</span>`;
export const qtyText = (it: StockItemDTO, q: number) => (it.unit.factor > 1 ? `${(q / it.unit.factor).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${it.unit.display}` : `${fmt(q)} ${it.unit.display}`);

/** Catalog with ETag: a 304 keeps the cached one (≈ 4 rows read on the server). */
export async function loadCatalog(force = false): Promise<void> {
  const r = await sapi.catalog(force ? null : ST.catalogEtag);
  if (r.status !== 304 && r.data) { ST.catalog = r.data; ST.catalogEtag = r.etag; }
}

export function resetBuilder() {
  Object.assign(ST.builder, { qty: {}, planned: null, templateId: null, kind: 'order', price: '', priceEdited: false, short: null, idem: newIdempotencyKey() });
}
export function resetSell(bouquets: BouquetDTO[]) {
  Object.assign(ST.sell, {
    bouquets, price: String(bouquets.reduce((a, b) => a + b.priceCurrent, 0)), client: null, query: '', matches: [], redeem: false, giftId: null, channel: 'store',
    delivery: '30000', payment: 'cash', preview: null, previewError: null, idem: newIdempotencyKey(), result: null,
  });
}

/** Live cost of the builder composition from the catalog ladder (the server recomputes on «Собран»). */
export function builderCost() {
  const c = ST.catalog;
  const lines: Array<CostLine & { itemId: string; qty: number; short: boolean }> = [];
  if (!c) return null;
  for (const [itemId, qty] of Object.entries(ST.builder.qty)) {
    if (!qty) continue;
    const it = c.items.find((i) => i.id === itemId);
    if (!it) continue;
    let value = 0n;
    let short = false;
    if (!it.trackStock) value = BigInt(qty) * BigInt(it.stdCostMu ?? 0);
    else {
      const lots = it.ladder.map((l) => ({ id: l.lotId, itemId, qty: l.qty, unitCostMu: l.unitCostMu, priority: 0, expiresOn: null, receivedAt: '' }));
      // ladder is already in picking order; keep that order (priority = position)
      lots.forEach((l, k) => (l.priority = lots.length - k));
      const { picks, short: s } = pickLots(lots, [{ itemId, qty }], { policy: 'allow', confirmedShort: true, deficitCostMu: () => it.lastCostMu ?? it.stdCostMu ?? 0 });
      value = picks.reduce((a, p) => a + p.valueMu, 0n);
      short = s.length > 0 || qty > it.qty;
    }
    lines.push({ itemId, qty, kind: it.kind, valueMu: value, markupX100: it.markupX100, short });
  }
  const cost = bouquetCost(lines);
  const suggested = suggestPrice(lines, c.config.pricing);
  const price = ST.builder.priceEdited && +ST.builder.price > 0 ? +ST.builder.price : suggested;
  const sh = shares(cost, price);
  const t = c.config.pricing.targets;
  return {
    lines, cost, suggested, price, ...sh,
    costLevel: shareLevel(sh.costShare, t.costShare, t.amberBandPp), flowersLevel: shareLevel(sh.flowersShare, t.flowersShare, t.amberBandPp),
    anyShort: lines.some((l) => l.short),
  };
}

export const render = () => app.render();
export const pctTxt = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
export const dayTxt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
