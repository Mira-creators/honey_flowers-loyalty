-- Heavy clients: cost independent of history length (item 5, D1Repository bounded load).
--
-- A client with ~1 000 purchases cost ~3 800 rows read and 140–250 ms on /api/me, a purchase and
-- the owner's client card, because the whole history was loaded and replayed. Now a command loads
-- only the latest purchases and the rows it needs (by id / key), and the engine adds what was not
-- loaded from per-client totals (packages/core ClientState.folded):
--   balance          (exists)  Σ points_ledger.amount
--   purchases_count  (exists)  active purchases
--   level_sum / level_count    active purchases at/after the level override (all without one):
--                              the all-time level metric (sum / count criterion)
-- client_stats is written in the same batch as every outcome, so these stay exact.
ALTER TABLE client_stats ADD COLUMN level_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_stats ADD COLUMN level_count INTEGER NOT NULL DEFAULT 0;

UPDATE client_stats SET
  level_sum = COALESCE((SELECT SUM(p.amount) FROM purchases p JOIN clients c ON c.id = p.client_id
                        WHERE p.client_id = client_stats.client_id AND p.status = 'active'
                          AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)), 0),
  level_count = (SELECT COUNT(*) FROM purchases p JOIN clients c ON c.id = p.client_id
                 WHERE p.client_id = client_stats.client_id AND p.status = 'active'
                   AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)),
  -- exact totals for the bounded load (the 0004 backfill was exact too; this is belt and braces)
  balance = COALESCE((SELECT SUM(l.amount) FROM points_ledger l WHERE l.client_id = client_stats.client_id), 0),
  purchases_count = (SELECT COUNT(*) FROM purchases p WHERE p.client_id = client_stats.client_id AND p.status = 'active');

-- Clients that somehow have no summary row get one (the bounded load needs the totals).
INSERT INTO client_stats (client_id, balance, purchases_count, level_sum, level_count, updated_at)
SELECT c.id,
  COALESCE((SELECT SUM(l.amount) FROM points_ledger l WHERE l.client_id = c.id), 0),
  (SELECT COUNT(*) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'),
  COALESCE((SELECT SUM(p.amount) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active' AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)), 0),
  (SELECT COUNT(*) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active' AND (c.level_override_at IS NULL OR p.created_at >= c.level_override_at)),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM clients c WHERE NOT EXISTS (SELECT 1 FROM client_stats s WHERE s.client_id = c.id);

-- Index lookups of the bounded load (a few rows each instead of the whole history).
CREATE INDEX points_ledger_client_type_idx ON points_ledger (client_id, type, created_at);
CREATE INDEX card_moves_purchase_idx ON card_moves (purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX card_moves_reset_idx ON card_moves (client_id, id) WHERE reason = 'expiry_reset';
CREATE INDEX rewards_client_unlocked_idx ON rewards (client_id, unlocked_at);
CREATE INDEX rewards_unlocked_by_idx ON rewards (unlocked_by_purchase) WHERE unlocked_by_purchase IS NOT NULL;
-- Client history, newest first, 50 per page (SQL union, lib/history.ts).
CREATE INDEX purchases_client_reversed_idx ON purchases (client_id, reversed_at) WHERE status = 'reversed';
CREATE INDEX points_ledger_client_standalone_idx ON points_ledger (client_id, created_at) WHERE purchase_id IS NULL;
CREATE INDEX rewards_client_granted_idx ON rewards (client_id, unlocked_at) WHERE granted_by IS NOT NULL;
CREATE INDEX rewards_client_handed_idx ON rewards (client_id, used_at) WHERE status = 'used' AND used_in_purchase IS NULL;
