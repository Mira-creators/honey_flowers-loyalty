import type {
  ApiError,
  ConsoleClientsPageDTO,
  ConsoleCohortsDTO,
  ConsoleOperationsPageDTO,
  ConsoleOverviewDTO,
  ImportBatchDTO,
  ImportRequest,
  ImportResultDTO,
  Role,
  StaffDTO,
  WebMeDTO,
  WebSessionDTO,
} from '@honey/contracts';
import { getTestUser } from '../api';

/**
 * Console API client. Auth: the browser session from the one-time link (Bearer), kept in
 * localStorage for its 12 hours; in TEST_MODE, the same X-Test-User login as the Mini App.
 */
const SESSION_KEY = 'honey.console.session';

export interface StoredSession { token: string; expiresAt: string; name: string }

export function getSession(): StoredSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as StoredSession | null;
    if (s && Date.parse(s.expiresAt) > Date.now()) return s;
  } catch {
    /* ignore */
  }
  return null;
}
export function setSession(s: StoredSession) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode: lives in memory only */ }
  memory = s;
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  memory = null;
}
let memory: StoredSession | null = null;
const session = () => getSession() ?? memory;

export class ApiErr extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

/** Called when the server says the session is over (main.ts shows the "link expired" screen). */
export const hooks = { onExpired: (_msg: string) => {} };

export function authMode(): 'session' | 'test' | null {
  if (session()) return 'session';
  return getTestUser()?.key ? 'test' : null;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const s = session();
  if (s) headers.Authorization = `Bearer ${s.token}`;
  else {
    const tu = getTestUser();
    if (tu) { headers['X-Test-User'] = tu.id; headers['X-Test-Name'] = encodeURIComponent(tu.name); headers['X-Test-Key'] = tu.key; }
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiErr('network', 'Нет связи с сервером. Проверьте интернет и повторите.', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (data as ApiError | null)?.error;
    const err = new ApiErr(e?.code ?? 'internal', e?.message ?? `Ошибка сервера (${res.status})`, res.status);
    if (res.status === 401 && s) { clearSession(); hooks.onExpired(err.message); }
    throw err;
  }
  return data as T;
}

export const capi = {
  health: () => req<{ ok: boolean; testMode: boolean }>('GET', '/health'),
  exchange: (token: string) => req<WebSessionDTO>('POST', '/api/web/session', { token }),
  me: () => req<WebMeDTO>('GET', '/api/web/me'),
  logout: () => req<{ ok: true }>('POST', '/api/web/logout', {}),
  overview: (qs: string) => req<ConsoleOverviewDTO>('GET', `/api/owner/console/overview?${qs}`),
  clients: (qs: string) => req<ConsoleClientsPageDTO>('GET', `/api/owner/console/clients?${qs}`),
  ops: (qs: string) => req<ConsoleOperationsPageDTO>('GET', `/api/owner/console/operations?${qs}`),
  cohorts: (months: number) => req<ConsoleCohortsDTO>('GET', `/api/owner/console/cohorts?months=${months}`),
  staff: () => req<StaffDTO[]>('GET', '/api/owner/staff'),
  importChunk: (b: ImportRequest) => req<ImportResultDTO>('POST', '/api/owner/import', b),
  batches: () => req<ImportBatchDTO[]>('GET', '/api/owner/import/batches'),
  undo: (id: string) => req<ImportBatchDTO>('POST', `/api/owner/import/${encodeURIComponent(id)}/undo`, {}),
  testRole: (role: Role) => req<unknown>('POST', '/api/test/role', { role }),
};
