import type {
  MeDTO, SetLangRequest, StaffClientLookupDTO, PurchasePreviewRequest, PurchasePreviewDTO, PurchaseRequest,
  PurchaseResultDTO, ReverseResultDTO, UseGiftResultDTO, OperationDTO, OwnerStatsDTO, EditableRulesDTO, StaffDTO,
  Role, TestRunExpiryDTO, ApiError,
} from '@honey/contracts';
import { tg } from './tg';

/**
 * Browser testing outside Telegram (server must run with TEST_MODE=1). The server accepts
 * X-Test-User only with X-Test-Key equal to its TEST_KEY secret and ids >= 900 000 000.
 */
const TEST_KEY = 'honey.testUser';
export function getTestUser(): { id: string; name: string; key: string } | null {
  const q = new URLSearchParams(location.search);
  const qid = q.get('testUser');
  if (qid) {
    const u = { id: qid, name: q.get('testName') || 'Тестер ' + qid.slice(-3), key: q.get('testKey') || getTestUser0()?.key || '' };
    try { localStorage.setItem(TEST_KEY, JSON.stringify(u)); } catch { /* ignore */ }
    return u;
  }
  return getTestUser0();
}
function getTestUser0(): { id: string; name: string; key: string } | null {
  try { const s = localStorage.getItem(TEST_KEY); return s ? { key: '', ...JSON.parse(s) } : null; } catch { return null; }
}
export function setTestUser(name: string, key: string) {
  const u = { id: String(900000000 + Math.floor(Math.random() * 99999999)), name, key };
  try { localStorage.setItem(TEST_KEY, JSON.stringify(u)); } catch { /* ignore */ }
  return u;
}
export function clearTestUser() { try { localStorage.removeItem(TEST_KEY); } catch { /* ignore */ } }

export class ApiErr extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tg.inTelegram) headers.Authorization = 'tma ' + tg.initData();
  else {
    const tu = getTestUser();
    if (tu) { headers['X-Test-User'] = tu.id; headers['X-Test-Name'] = encodeURIComponent(tu.name); headers['X-Test-Key'] = tu.key; }
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiErr('network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as ApiError | null)?.error;
    throw new ApiErr(e?.code ?? 'internal', e?.message ?? `Ошибка сервера (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  me: () => req<MeDTO>('GET', '/api/me'),
  setLang: (b: SetLangRequest) => req<unknown>('POST', '/api/me/lang', b),

  lookup: (q: string) => req<StaffClientLookupDTO>('GET', '/api/staff/client?q=' + encodeURIComponent(q)),
  preview: (b: PurchasePreviewRequest) => req<PurchasePreviewDTO>('POST', '/api/staff/purchase/preview', b),
  purchase: (b: PurchaseRequest) => req<PurchaseResultDTO>('POST', '/api/staff/purchase', b),
  reverse: (id: string, reason: string) => req<ReverseResultDTO>('POST', `/api/staff/purchase/${encodeURIComponent(id)}/reverse`, { reason }),
  useGift: (id: string) => req<UseGiftResultDTO>('POST', `/api/staff/gift/${encodeURIComponent(id)}/use`, {}),
  recent: () => req<OperationDTO[]>('GET', '/api/staff/recent'),

  stats: () => req<OwnerStatsDTO>('GET', '/api/owner/stats'),
  rules: () => req<EditableRulesDTO>('GET', '/api/owner/rules'),
  saveRules: (b: EditableRulesDTO) => req<EditableRulesDTO>('PUT', '/api/owner/rules', b),
  staff: () => req<StaffDTO[]>('GET', '/api/owner/staff'),
  addStaff: (phoneOrTelegramId: string, role: StaffDTO['role']) => req<StaffDTO>('POST', '/api/owner/staff', { phoneOrTelegramId, role }),
  removeStaff: (id: string) => req<unknown>('DELETE', `/api/owner/staff/${encodeURIComponent(id)}`),
  operations: (limit = 100) => req<OperationDTO[]>('GET', `/api/owner/operations?limit=${limit}`),

  test: {
    role: (role: Role) => req<unknown>('POST', '/api/test/role', { role }),
    clock: (days: number | null) => req<unknown>('POST', '/api/test/clock', days === null ? { reset: true } : { days }),
    runExpiry: () => req<TestRunExpiryDTO>('POST', '/api/test/run-expiry', {}),
    resetMe: () => req<unknown>('POST', '/api/test/reset-me', {}),
    register: (phone: string, name: string) => req<unknown>('POST', '/api/test/register', { phone, name }),
  },
};

export const newIdempotencyKey = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(16).slice(2));
