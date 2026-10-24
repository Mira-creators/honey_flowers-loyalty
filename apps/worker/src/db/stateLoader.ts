import { activePurchases, availableRewards, levelTotals, monthsBeforeKey, type CardMove, type ClientState, type LedgerEntry, type PurchaseRecord, type Reward } from '@honey/core';
import type { LoadHint, VersionedState } from '@honey/service';

/**
 * BOUNDED load of client states (migration 0010): instead of every purchase, ledger row, card move
 * and gift of a client (a 1 000-purchase client = ~3 800 rows read, 140–250 ms), load what the
 * engine can look at and fold the rest into aggregates (packages/core ClientState.folded):
 *
 *   purchases   the latest few, the 2 latest active ones (expiry anchor), those of the active
 *               card-move tail (reversal cascade), the hinted ones (id, idempotency keys) and the
 *               one that unlocked the gift used in the hinted purchase; with a level window, every
 *               active purchase inside it
 *   ledger      the latest expiry, the first credit after it, the latest welcome / positive
 *               adjustment (expiry anchor), the welcome entry, the hinted purchase's rows and rows
 *               with hinted idempotency keys
 *   card moves  the latest TAIL active moves, the latest expiry reset, the hinted purchase's moves
 *   gifts       the latest GIFTS available ones (all of them when an expiry resets the card), the latest
 *               GIFTS by unlock, the hinted ones
 *   keys        all sent-notification keys (a few per 90 days)
 *   folded      client_stats totals (balance, purchases_count, level_sum, level_count, gifts_available) minus what
 *               was loaded — exact, because client_stats is written in the same batch as every fact.
 *
 * Every statement drives from json_each(?1) (the client ids) with correlated index lookups, so the
 * same ~16 statements load one client (a command) or a hundred (the daily job), and the rows read
 * do not grow with the length of a client's history. packages/core/test/folded.test.ts proves on
 * random histories that commands give identical outcomes on such a state.
 */

/** Latest purchases / gifts loaded besides the ones a command needs (display, safety margin). */
export const LATEST = 5;
export const GIFTS = 20;
/** Active card moves loaded: more than a card (10 cells), enough for the reversal cascade. */
export const TAIL = 12;

type Row = Record<string, unknown>;

/** Statements of a bounded load; `assemble` turns their results into states. */
export function boundedStatements(db: D1Database, ids: string[], hint: LoadHint = {}): D1PreparedStatement[] {
  const json = JSON.stringify(ids);
  const J = 'json_each(?1) j';
  const keys = JSON.stringify(hint.keys ?? []);
  const rewardIds = JSON.stringify(hint.rewardIds ?? []);
  const pid = hint.purchaseId ?? null;
  const windowFrom =
    hint.rules?.levels.windowMonths && hint.now
      ? new Date(`${monthsBeforeKey(hint.now, hint.rules.levels.windowMonths, hint.rules.timezone)}T00:00:00+05:00`).toISOString()
      : null;
  const P = 'p.*, p.rowid AS _rowid';
  const L = 'l.*, l.rowid AS _rowid';
  const R = 'r.*, r.rowid AS _rowid';
  const stmts = [
    // 0: client + stored totals
    db.prepare(
      `SELECT c.id, c.created_at, c.level_override, c.level_override_at, c.level_override_index,
         s.client_id AS has_stats, s.balance, s.purchases_count, s.level_sum, s.level_count, s.gifts_available
       FROM ${J} JOIN clients c ON c.id = j.value LEFT JOIN client_stats s ON s.client_id = c.id`,
    ).bind(json),
    // 1: version
    db.prepare(`SELECT j.value AS client_id, (SELECT COALESCE(MAX(version), 0) FROM client_versions v WHERE v.client_id = j.value) AS v FROM ${J}`).bind(json),
    // 2: purchases — latest, latest active, active move tail, level window
    db.prepare(
      `SELECT ${P} FROM ${J} JOIN purchases p ON p.rowid IN (SELECT q.rowid FROM purchases q WHERE q.client_id = j.value ORDER BY q.created_at DESC, q.rowid DESC LIMIT ${LATEST})
       UNION ALL
       SELECT ${P} FROM ${J} JOIN purchases p ON p.rowid IN (SELECT q.rowid FROM purchases q WHERE q.status = 'active' AND q.client_id = j.value ORDER BY q.created_at DESC LIMIT 2)
       UNION ALL
       SELECT ${P} FROM ${J} JOIN card_moves m ON m.id IN (SELECT m2.id FROM card_moves m2 WHERE m2.client_id = j.value AND m2.reverted_at IS NULL ORDER BY m2.id DESC LIMIT ${TAIL})
         JOIN purchases p ON p.id = m.purchase_id
       UNION ALL
       SELECT ${P} FROM ${J} JOIN purchases p ON p.status = 'active' AND p.client_id = j.value AND p.created_at >= ?2 WHERE ?2 IS NOT NULL`,
    ).bind(json, windowFrom),
    // 3: purchases — hinted (id, keys) and the unlocker of the gift used in the hinted purchase
    db.prepare(
      `SELECT ${P} FROM purchases p WHERE p.id = ?2 AND p.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${P} FROM purchases p WHERE p.idempotency_key IN (SELECT value FROM json_each(?3)) AND p.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${P} FROM purchases p WHERE p.id = (SELECT r.unlocked_by_purchase FROM rewards r WHERE r.id = (SELECT x.reward_used_id FROM purchases x WHERE x.id = ?2))`,
    ).bind(json, pid, keys),
    // 4: ledger — latest expiry, first credit after it, latest welcome / positive adjustment, welcome
    db.prepare(
      `SELECT ${L} FROM ${J} JOIN points_ledger l ON l.rowid = (SELECT x.rowid FROM points_ledger x WHERE x.client_id = j.value AND x.type = 'expire' ORDER BY x.created_at DESC LIMIT 1)
       UNION ALL
       SELECT ${L} FROM ${J} JOIN points_ledger l ON l.rowid = (SELECT x.rowid FROM points_ledger x WHERE x.client_id = j.value AND x.amount > 0
           AND x.created_at > (SELECT MAX(y.created_at) FROM points_ledger y WHERE y.client_id = j.value AND y.type = 'expire') ORDER BY x.created_at LIMIT 1)
       UNION ALL
       SELECT ${L} FROM ${J} JOIN points_ledger l ON l.rowid = (SELECT x.rowid FROM points_ledger x WHERE x.client_id = j.value AND x.type = 'manual_adjust' AND x.amount > 0 ORDER BY x.created_at DESC LIMIT 1)
       UNION ALL
       SELECT ${L} FROM ${J} JOIN points_ledger l ON l.rowid = (SELECT x.rowid FROM points_ledger x WHERE x.client_id = j.value AND x.type = 'welcome' LIMIT 1)`,
    ).bind(json),
    // 5: ledger — hinted purchase, hinted keys
    db.prepare(
      `SELECT ${L} FROM points_ledger l WHERE l.purchase_id = ?2 AND l.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${L} FROM points_ledger l WHERE l.idempotency_key IN (SELECT value FROM json_each(?3)) AND l.client_id IN (SELECT value FROM json_each(?1))`,
    ).bind(json, pid, keys),
    // 6: card moves — active tail, latest reset, hinted purchase
    db.prepare(
      `SELECT m.* FROM ${J} JOIN card_moves m ON m.id IN (SELECT m2.id FROM card_moves m2 WHERE m2.client_id = j.value AND m2.reverted_at IS NULL ORDER BY m2.id DESC LIMIT ${TAIL})
       UNION ALL
       SELECT m.* FROM ${J} JOIN card_moves m ON m.id = (SELECT m2.id FROM card_moves m2 WHERE m2.client_id = j.value AND m2.reason = 'expiry_reset' ORDER BY m2.id DESC LIMIT 1)
       UNION ALL
       SELECT m.* FROM card_moves m WHERE m.purchase_id = ?2 AND m.client_id IN (SELECT value FROM json_each(?1))`,
    ).bind(json, pid),
    // 7: gifts — available (all of them when an expiry may reset the card: it revokes every one), latest by unlock
    db.prepare(
      `SELECT ${R} FROM ${J} JOIN rewards r ON r.rowid IN (SELECT x.rowid FROM rewards x WHERE x.client_id = j.value AND x.status = 'available' ORDER BY x.unlocked_at DESC LIMIT ?2)
       UNION ALL
       SELECT ${R} FROM ${J} JOIN rewards r ON r.rowid IN (SELECT x.rowid FROM rewards x WHERE x.client_id = j.value ORDER BY x.unlocked_at DESC LIMIT ${GIFTS})`,
    ).bind(json, hint.rules?.expiry.onExpiry === 'reset_all' ? -1 : GIFTS),
    // 8: gifts — hinted ids, unlocked by / used in the hinted purchase, handed out with hinted keys
    db.prepare(
      `SELECT ${R} FROM rewards r WHERE r.id IN (SELECT value FROM json_each(?3)) AND r.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${R} FROM rewards r WHERE r.unlocked_by_purchase = ?2 AND r.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${R} FROM rewards r WHERE r.id = (SELECT x.reward_used_id FROM purchases x WHERE x.id = ?2) AND r.client_id IN (SELECT value FROM json_each(?1))
       UNION ALL
       SELECT ${R} FROM rewards r WHERE r.used_idempotency_key IN (SELECT value FROM json_each(?4)) AND r.client_id IN (SELECT value FROM json_each(?1))`,
    ).bind(json, pid, rewardIds, keys),
    // 9: sent notification keys
    db.prepare(`SELECT k.client_id, k.key FROM ${J} JOIN notification_keys k ON k.client_id = j.value ORDER BY k.rowid`).bind(json),
  ];
  return stmts;
}

/** Results of boundedStatements → states. A client without a client_stats row is reported in `missing`. */
export function assembleBounded(
  results: Array<{ results: Row[] }>,
  maps: {
    purchase: (r: Row) => PurchaseRecord;
    ledger: (r: Row) => LedgerEntry;
    move: (r: Row) => CardMove;
    reward: (r: Row) => Reward;
    override: (r: Row) => ClientState['levelOverride'];
  },
): { states: Map<string, VersionedState>; missing: string[] } {
  const [clients, versions, p1, p2, l1, l2, moves, g1, g2, keys] = results.map((r) => r.results);
  const states = new Map<string, VersionedState>();
  const missing: string[] = [];
  const totals = new Map<string, { balance: number; count: number; levelSum: number; levelCount: number; gifts: number }>();
  for (const c of clients!) {
    const id = String(c.id);
    if (c.has_stats === null || c.has_stats === undefined) {
      missing.push(id);
      continue;
    }
    totals.set(id, { balance: Number(c.balance), count: Number(c.purchases_count), levelSum: Number(c.level_sum), levelCount: Number(c.level_count), gifts: Number(c.gifts_available) });
    states.set(id, {
      version: 0,
      state: { clientId: id, registeredAt: new Date(String(c.created_at)), levelOverride: maps.override(c), purchases: [], ledger: [], cardMoves: [], rewards: [], sentNotificationKeys: [] },
    });
  }
  for (const v of versions!) {
    const s = states.get(String(v.client_id));
    if (s) s.version = Number(v.v ?? 0);
  }
  // Dedupe (a row may come from several sources) and restore storage order.
  const group = <T>(rows: Row[], key: (r: Row) => string, map: (r: Row) => T, order: (r: Row) => [string | number, number]) => {
    const by = new Map<string, Map<string, Row>>();
    for (const r of rows) {
      const cid = String(r.client_id);
      if (!states.has(cid)) continue;
      if (!by.has(cid)) by.set(cid, new Map());
      by.get(cid)!.set(key(r), r);
    }
    const out = new Map<string, T[]>();
    for (const [cid, m] of by) {
      const list = [...m.values()].sort((a, b) => {
        const [a1, a2] = order(a);
        const [b1, b2] = order(b);
        return a1 < b1 ? -1 : a1 > b1 ? 1 : a2 - b2;
      });
      out.set(cid, list.map(map));
    }
    return out;
  };
  const purchases = group([...p1!, ...p2!], (r) => String(r.id), maps.purchase, (r) => [String(r.created_at), Number(r._rowid)]);
  const ledger = group([...l1!, ...l2!], (r) => String(r.id), maps.ledger, (r) => [0, Number(r._rowid)]);
  const cardMoves = group(moves!, (r) => String(r.id), maps.move, (r) => [0, Number(r.id)]);
  const rewards = group([...g1!, ...g2!], (r) => String(r.id), maps.reward, (r) => [0, Number(r._rowid)]);
  for (const k of keys!) states.get(String(k.client_id))?.state.sentNotificationKeys.push(String(k.key));
  for (const [id, vs] of states) {
    const s = vs.state;
    s.purchases = purchases.get(id) ?? [];
    s.ledger = ledger.get(id) ?? [];
    s.cardMoves = cardMoves.get(id) ?? [];
    s.rewards = rewards.get(id) ?? [];
    const t = totals.get(id)!;
    const loadedLevel = levelTotals(s);
    s.folded = {
      ledgerSum: t.balance - s.ledger.reduce((sum, e) => sum + e.amount, 0),
      activeCount: t.count - activePurchases(s).length,
      levelSum: t.levelSum - loadedLevel.sum,
      levelCount: t.levelCount - loadedLevel.count,
      levelSince: s.levelOverride?.setAt ?? null,
      availableGifts: t.gifts - availableRewards(s).length,
    };
  }
  return { states, missing };
}
