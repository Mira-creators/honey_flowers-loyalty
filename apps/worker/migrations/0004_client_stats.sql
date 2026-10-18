-- Owner's client base: per-client summary table, free-text note, one-time export links.
--
-- client_stats is a DENORMALIZED copy of what the engine derives from a client's
-- ledger / purchases / rewards. It exists so that the owner's list (10 000+ clients,
-- filters, sorts, CSV export) never reads every ledger row: a page of 30 clients costs
-- O(30) rows, not O(all ledger rows).
--
-- How it stays consistent (apps/worker/src/db/d1Repository.ts, saveOutcome):
--   * every engine write goes through saveOutcome, which runs ONE db.batch (= a transaction);
--     the upsert of client_stats is a statement of that same batch, computed from the
--     state AFTER the outcome (LoyaltyService passes it) with the same core functions the
--     client card uses (balanceFromLedger, deriveLevel, expiryInfo, availableRewards);
--   * a concurrent write makes the whole batch roll back (client_versions), stats included;
--   * createClient inserts an empty row; deleteClient / wipeAll remove it;
--   * opening a client card (GET /api/owner/clients/:id) recomputes the row from the full
--     state and rewrites it if it drifted (self-healing, normally a no-op).
--   * a new rules version (PUT /api/owner/rules) recomputes level_id and expires_on of every
--     row in SQL from spent / activity_at in the same batch (rare; writes only changed rows).
-- What it cannot know without a write: a level window (levels.windowMonths) rolling over
-- and overdue expiry not yet settled by the daily job. Both are corrected by the next
-- write to the client or by the daily job, and the client card always shows the live value.
CREATE TABLE client_stats (
  client_id         TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  balance           INTEGER NOT NULL DEFAULT 0,        -- SUM(points_ledger.amount)
  spent             INTEGER NOT NULL DEFAULT 0,        -- level metric (sum of counted active purchases)
  purchases_count   INTEGER NOT NULL DEFAULT 0,        -- active (not reversed) purchases
  last_purchase_at  TEXT NOT NULL DEFAULT '',          -- ISO instant of the last active purchase, '' = never (sorts last in DESC)
  level_id          TEXT NOT NULL DEFAULT '',          -- LevelTier.id in force at the last write
  gifts_available   INTEGER NOT NULL DEFAULT 0,        -- rewards with status 'available'
  activity_at       TEXT NOT NULL DEFAULT '',          -- expiry anchor (core activityAnchor): registration / last purchase / credit
  expires_on        TEXT NOT NULL DEFAULT '',          -- last day the balance is valid (YYYY-MM-DD Tashkent), '' if balance <= 0
  updated_at        TEXT NOT NULL DEFAULT ''
);
-- Sorts of GET /api/owner/clients (keyset pagination on (column, client_id)). Filters (status,
-- level) are evaluated while walking the sort index, which stops after one page of matches,
-- so they need no index of their own (fewer indexes = fewer rows written per purchase).
CREATE INDEX client_stats_last_purchase_idx ON client_stats (last_purchase_at, client_id);
CREATE INDEX client_stats_spent_idx ON client_stats (spent, client_id);
CREATE INDEX client_stats_balance_idx ON client_stats (balance, client_id);
-- Sort by name / registration date drives from the clients table.
CREATE INDEX clients_name_idx ON clients (COALESCE(name, ''), id);
CREATE INDEX clients_created_id_idx ON clients (created_at, id);

-- Backfill for clients that exist before this migration. Level and expiry use the rules
-- version in force (json_each over the tiers), all-time sum criterion; a client with a
-- level override keeps the higher of the two. Exact for the default rules; any later write
-- or card open recomputes the row with the engine.
INSERT INTO client_stats (client_id, balance, spent, purchases_count, last_purchase_at, level_id, gifts_available, activity_at, expires_on, updated_at)
SELECT
  c.id,
  COALESCE((SELECT SUM(l.amount) FROM points_ledger l WHERE l.client_id = c.id), 0),
  COALESCE((SELECT SUM(p.amount) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'
            AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)), 0),
  (SELECT COUNT(*) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'),
  COALESCE((SELECT MAX(p.created_at) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'), ''),
  '',
  (SELECT COUNT(*) FROM rewards r WHERE r.client_id = c.id AND r.status = 'available'),
  MAX(c.created_at,
      COALESCE((SELECT MAX(p.created_at) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'), ''),
      COALESCE((SELECT MAX(l.created_at) FROM points_ledger l WHERE l.client_id = c.id
                 AND l.type IN ('welcome', 'manual_adjust') AND l.amount > 0), '')),
  '',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM clients c;

-- level_id: highest tier whose threshold <= spent (rules in force), or the override if higher.
UPDATE client_stats SET level_id = COALESCE(
  (SELECT json_extract(t.value, '$.id')
     FROM rules_versions rv, json_each(rv.rules, '$.levels.tiers') t
    WHERE rv.id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)
      AND (CAST(json_extract(t.value, '$.threshold') AS INTEGER) <= client_stats.spent
           OR json_extract(t.value, '$.id') = (SELECT level_override FROM clients WHERE id = client_stats.client_id))
    ORDER BY CAST(json_extract(t.value, '$.threshold') AS INTEGER) DESC LIMIT 1),
  '');

-- expires_on: anchor + expiryDays - 1 as a Tashkent (UTC+5, no DST) calendar day, while the balance is positive.
UPDATE client_stats SET expires_on = date(activity_at, '+5 hours',
  '+' || (COALESCE((SELECT json_extract(rv.rules, '$.expiry.expiryDays') FROM rules_versions rv
            WHERE rv.id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)), 90) - 1) || ' days')
WHERE balance > 0;

-- Owner / staff note on a client (<= 500 chars), PUT /api/owner/clients/:id/note.
ALTER TABLE clients ADD COLUMN note TEXT;

-- One-time links for CSV export (the Mini App cannot download inside Telegram, so the
-- owner opens the link in a normal browser): POST /api/owner/export/link → token valid
-- 10 minutes, usable once; expired rows are pruned when a new link is created.
CREATE TABLE export_links (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('clients', 'operations')),
  params      TEXT NOT NULL CHECK (json_valid(params)),   -- { from, to } for operations
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
