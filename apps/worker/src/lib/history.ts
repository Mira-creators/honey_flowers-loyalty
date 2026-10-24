import type { HistoryItemDTO } from '@honey/contracts';

/**
 * A client's history, newest first, read with ONE SQL statement per page (migration 0010 indexes):
 * each source (purchases, reversals, stand-alone мёд rows, gifts granted / handed out) takes only
 * its newest `limit` rows before the cursor, so a page costs O(limit) rows whatever the length of
 * the history. Keyset cursor = (at, id) of the last item of the previous page.
 */

type Row = Record<string, unknown>;

export interface HistoryCursor {
  at: string;
  id: string;
}

export const HISTORY_PAGE = 50;

export function historyStmt(db: D1Database, clientId: string, limit = HISTORY_PAGE, before: HistoryCursor | null = null): D1PreparedStatement {
  const b = (at: string, id: string) => `(?3 IS NULL OR ${at} < ?3 OR (${at} = ?3 AND ${id} < ?4))`;
  const sql = `SELECT * FROM (
      SELECT p.id AS id, p.created_at AS at, 'purchase' AS kind, p.id AS purchase_id, p.amount AS purchase_amount, p.status AS status,
        p.points_redeemed AS redeemed, p.result AS result, p.staff_id AS staff_id, NULL AS reason, NULL AS type,
        -- the accrual row equals result.cashback and the redeem row −points_redeemed (qa/lib/invariants.mjs):
        -- no ledger lookups per purchase
        COALESCE(json_extract(p.result, '$.cashback'), 0) - p.points_redeemed AS points,
        COALESCE(json_extract(p.result, '$.cashback'), 0) AS cashback
      FROM (SELECT * FROM purchases WHERE client_id = ?1 AND ${b('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?2) p
      UNION ALL
      SELECT 'rev-' || p.id, p.reversed_at, 'reversal', p.id, p.amount, 'reversed', NULL, NULL, p.reversed_by, p.reversed_reason, NULL,
        (SELECT COALESCE(SUM(l.amount), 0) FROM points_ledger l WHERE l.purchase_id = p.id AND l.type = 'reversal'), NULL
      FROM (SELECT * FROM purchases WHERE client_id = ?1 AND status = 'reversed' AND ${b('reversed_at', "'rev-' || id")} ORDER BY reversed_at DESC LIMIT ?2) p
      UNION ALL
      SELECT l.id, l.created_at, 'ledger', NULL, NULL, NULL, NULL, NULL, l.staff_id, l.reason, l.type, l.amount, NULL
      FROM (SELECT * FROM points_ledger WHERE client_id = ?1 AND purchase_id IS NULL AND ${b('created_at', 'id')} ORDER BY created_at DESC LIMIT ?2) l
      UNION ALL
      SELECT 'granted-' || r.id, r.unlocked_at, 'gift_granted', NULL, NULL, NULL, NULL, NULL, r.granted_by, r.grant_reason, r.id, 0, NULL
      FROM (SELECT * FROM rewards WHERE client_id = ?1 AND granted_by IS NOT NULL AND ${b('unlocked_at', "'granted-' || id")} ORDER BY unlocked_at DESC LIMIT ?2) r
      UNION ALL
      SELECT 'gift-' || r.id, r.used_at, 'gift_used', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL
      FROM (SELECT * FROM rewards WHERE client_id = ?1 AND status = 'used' AND used_in_purchase IS NULL AND ${b('used_at', "'gift-' || id")} ORDER BY used_at DESC LIMIT ?2) r
    ) ORDER BY at DESC, id DESC LIMIT ?2`;
  return db.prepare(sql).bind(clientId, limit, before?.at ?? null, before?.id ?? '');
}

/** Staff / actor ids referenced by history rows (for the name lookup). */
export function historyActorIds(rows: Row[]): string[] {
  return rows.map((r) => (r.staff_id === null || r.staff_id === undefined ? null : String(r.staff_id))).filter((x): x is string => !!x);
}

/** Rows of historyStmt → HistoryItemDTO (same shape the Mini App always got). */
export function historyItems(rows: Row[], names: Map<string, string>): HistoryItemDTO[] {
  return rows.map((r) => {
    const staffName = r.staff_id ? names.get(String(r.staff_id)) : undefined;
    const kind = String(r.kind);
    if (kind === 'purchase') {
      const res = r.result ? (JSON.parse(String(r.result)) as { cashbackPct?: number; cellAdvanced?: boolean; cell?: number }) : null;
      return {
        id: String(r.id),
        at: String(r.at),
        kind: 'purchase',
        points: Number(r.points ?? 0),
        cashback: Number(r.cashback ?? 0),
        purchaseId: String(r.purchase_id),
        purchaseAmount: Number(r.purchase_amount),
        pct: res?.cashbackPct ?? 0,
        cell: res?.cellAdvanced ? (res.cell ?? null) : null,
        redeemed: Number(r.redeemed ?? 0),
        status: String(r.status) as 'active' | 'reversed',
        ...(staffName ? { staffName } : {}),
      } satisfies HistoryItemDTO;
    }
    if (kind === 'reversal') {
      return {
        id: String(r.id),
        at: String(r.at),
        kind: 'reversal',
        points: Number(r.points ?? 0),
        purchaseId: String(r.purchase_id),
        purchaseAmount: Number(r.purchase_amount),
        status: 'reversed',
        ...(r.reason ? { reason: String(r.reason) } : {}),
        ...(staffName ? { staffName } : {}),
      } satisfies HistoryItemDTO;
    }
    if (kind === 'ledger') {
      const t = String(r.type);
      const k = t === 'welcome' ? 'welcome' : t === 'redeem' ? 'redeem' : t === 'expire' ? 'expire' : 'manual';
      return {
        id: String(r.id),
        at: String(r.at),
        kind: k,
        points: Number(r.points ?? 0),
        ...(k === 'manual' && r.reason ? { reason: String(r.reason) } : {}),
        ...(staffName ? { staffName } : {}),
      } satisfies HistoryItemDTO;
    }
    if (kind === 'gift_granted') {
      // only owner grants have granted_by; the reason is the owner's text
      return {
        id: String(r.id),
        at: String(r.at),
        kind: 'gift_granted',
        points: 0,
        ...(r.reason ? { reason: String(r.reason) } : {}),
        ...(staffName ? { staffName } : {}),
      } satisfies HistoryItemDTO;
    }
    return { id: String(r.id), at: String(r.at), kind: 'gift_used', points: 0 } satisfies HistoryItemDTO;
  });
}

export function encodeHistoryCursor(c: HistoryCursor): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeHistoryCursor(raw: string): HistoryCursor | null {
  try {
    const c = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))))) as Partial<HistoryCursor>;
    return typeof c.at === 'string' && typeof c.id === 'string' ? { at: c.at, id: c.id } : null;
  } catch {
    return null;
  }
}
