/** «Склад» API client: same auth as the rest of the Mini App (initData or the TEST_MODE header). */
import type {
  AssembleRequest, AssembleResultDTO, BouquetDTO, DisassembleRequest, DisassembleResultDTO, FreshnessDTO, PendingWriteoffDTO, ReceiptFormDTO,
  ReceiptPreviewDTO, ReceiptRequest, ReceiptResultDTO, SaveTemplateRequest, StockCatalogDTO, StockItemDTO, StockItemInput, StockOverviewDTO,
  StockSalePreviewDTO, StockSaleRequest, StockSaleResultDTO, StockStatusDTO, StockTemplateDTO, WriteoffRequest, WriteoffResultDTO, ApiError,
} from '@honey/contracts';
import { getTestUser } from '../../api';
import { tg } from '../../tg';

export class StockErr extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; etag: string | null }> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (tg.inTelegram) h.Authorization = 'tma ' + tg.initData();
  else {
    const tu = getTestUser();
    if (tu) { h['X-Test-User'] = tu.id; h['X-Test-Name'] = encodeURIComponent(tu.name); h['X-Test-Key'] = tu.key; }
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new StockErr('network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 0);
  }
  if (res.status === 304) return { status: 304, data: null as T, etag: res.headers.get('etag') };
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as ApiError | null)?.error;
    throw new StockErr(e?.code ?? 'internal', e?.message ?? `Ошибка сервера (${res.status})`, res.status, e?.details);
  }
  return { status: res.status, data: data as T, etag: res.headers.get('etag') };
}
const get = async <T>(p: string) => (await req<T>('GET', p)).data;
const post = async <T>(p: string, b: unknown = {}) => (await req<T>('POST', p, b)).data;
const id = (s: string) => encodeURIComponent(s);

export const sapi = {
  /** null = the module is off (404) — the app keeps its usual screens. */
  status: async (): Promise<StockStatusDTO | null> => {
    try { return await get<StockStatusDTO>('/api/stock/status'); } catch (e) { if ((e as StockErr).status === 404) return null; throw e; }
  },
  catalog: (etag: string | null) => req<StockCatalogDTO>('GET', '/api/stock/catalog', undefined, etag ? { 'If-None-Match': etag } : {}),
  templates: () => get<StockTemplateDTO[]>('/api/stock/templates'),
  saveTemplate: (b: SaveTemplateRequest) => post<StockTemplateDTO>('/api/stock/templates', b),
  assemble: (b: AssembleRequest) => post<AssembleResultDTO>('/api/stock/bouquets', b),
  openBouquets: () => get<BouquetDTO[]>('/api/stock/bouquets'),
  bouquet: (bid: string) => get<BouquetDTO>(`/api/stock/bouquets/${id(bid)}`),
  toShowcase: (bid: string) => post<BouquetDTO>(`/api/stock/bouquets/${id(bid)}/showcase`),
  disassemble: (bid: string, b: DisassembleRequest) => post<DisassembleResultDTO>(`/api/stock/bouquets/${id(bid)}/disassemble`, b),
  cancelBouquet: (bid: string) => post<BouquetDTO>(`/api/stock/bouquets/${id(bid)}/cancel`),
  salePreview: (b: Omit<StockSaleRequest, 'idempotencyKey'>) => post<StockSalePreviewDTO>('/api/stock/sales/preview', b),
  sale: (b: StockSaleRequest) => post<StockSaleResultDTO>('/api/stock/sales', b),
  retryLoyalty: (sid: string, withoutRedeem = false) => post<StockSaleResultDTO>(`/api/stock/sales/${id(sid)}/loyalty`, { withoutRedeem }),
  receiptForm: () => get<ReceiptFormDTO>('/api/stock/receipts/form'),
  receiptPreview: (b: ReceiptRequest) => post<ReceiptPreviewDTO>('/api/stock/receipts/preview', b),
  receipt: (b: ReceiptRequest) => post<ReceiptResultDTO>('/api/stock/receipts', b),
  writeoff: (b: WriteoffRequest) => post<WriteoffResultDTO>('/api/stock/writeoffs', b),
  freshness: () => get<FreshnessDTO>('/api/stock/freshness'),
  priority: (lotId: string, on: boolean) => post<unknown>(`/api/stock/lots/${id(lotId)}/priority`, { on }),
  overview: () => get<StockOverviewDTO>('/api/owner/stock/overview'),
  approvals: () => get<PendingWriteoffDTO[]>('/api/owner/stock/approvals'),
  decide: (docId: string, decision: 'approve' | 'reject', reason?: string) => post<unknown>(`/api/owner/stock/approvals/${id(docId)}`, { decision, reason }),
  cancelReceipt: (docId: string) => post<unknown>(`/api/owner/stock/receipts/${id(docId)}/cancel`),
  seedCatalog: () => post<{ items: number }>('/api/owner/stock/catalog/seed'),
  createItem: (b: StockItemInput) => post<StockItemDTO>('/api/owner/stock/items', b),
  updateItem: (iid: string, b: StockItemInput) => req<StockItemDTO>('PUT', `/api/owner/stock/items/${id(iid)}`, b).then((r) => r.data),
};
