-- Daily aggregates for the owner's statistics (apps/worker/src/lib/statsDaily.ts).
--
-- /api/owner/stats read ~90 000 rows per view at 2 000 clients (D1 Free: 5 M rows read per day),
-- the console overview ~40 000. Now they read one row per Tashkent day (plus the all-time row '*').
-- The rows are maintained incrementally in the SAME db.batch as every write (saveOutcome,
-- createClient, base import / undo, demo seed / clear, deleting a client), so they roll back with it.
-- qa/lib/invariants.mjs recomputes this table from the raw rows and compares.
CREATE TABLE stats_daily (
  day               TEXT PRIMARY KEY,               -- YYYY-MM-DD (Asia/Tashkent) or '*' = all time
  purchases         INTEGER NOT NULL DEFAULT 0,     -- active purchases, by creation day
  revenue           INTEGER NOT NULL DEFAULT 0,     -- their amounts
  first_purchases   INTEGER NOT NULL DEFAULT 0,     -- active purchases at the client's earliest active instant (repeat = purchases - first)
  buyers            INTEGER NOT NULL DEFAULT 0,     -- distinct clients with an active purchase that day
  last_buyers       INTEGER NOT NULL DEFAULT 0,     -- clients whose LAST active purchase is that day
  prev_buyers       INTEGER NOT NULL DEFAULT 0,     -- clients whose second-to-last active purchase is that day
  new_clients       INTEGER NOT NULL DEFAULT 0,     -- registered that day (not by a base import; demo counts)
  imported_clients  INTEGER NOT NULL DEFAULT 0,     -- created by a base import that day
  honey_accrued     INTEGER NOT NULL DEFAULT 0,     -- cashback, welcome, positive adjustments (not import), minus reversed cashback
  honey_redeemed    INTEGER NOT NULL DEFAULT 0,     -- paid with мёд, negative adjustments, minus refunded redemptions
  honey_expired     INTEGER NOT NULL DEFAULT 0,     -- burned
  honey_imported    INTEGER NOT NULL DEFAULT 0,     -- starting мёд of a base import (not "issued")
  gifts_unlocked    INTEGER NOT NULL DEFAULT 0,     -- gifts not revoked, by unlock day
  gifts_used        INTEGER NOT NULL DEFAULT 0,     -- used gifts, by use day
  reversals         INTEGER NOT NULL DEFAULT 0,     -- purchases reversed that day
  reversed_amount   INTEGER NOT NULL DEFAULT 0
);

-- Distinct buyers of PAST windows [from_day, to_day] (console overview: previous period, weekly /
-- monthly buckets), computed once and cached. Windows ending today are summed from last_buyers.
-- Any change of purchases inside a window (reversal, demo data, clock move) deletes its rows.
CREATE TABLE stats_buyers (
  from_day     TEXT NOT NULL,
  to_day       TEXT NOT NULL,
  buyers       INTEGER NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (from_day, to_day)
);

-- Backfill from the existing rows (same SQL as lib/statsDaily.ts contributionTerms for all clients;
-- D1 allows at most 5 terms per compound SELECT, hence two statements).
INSERT INTO stats_daily (day, purchases, revenue, first_purchases, buyers, last_buyers, prev_buyers, new_clients, imported_clients, honey_accrued, honey_redeemed, honey_expired, honey_imported, gifts_unlocked, gifts_used, reversals, reversed_amount)
SELECT day, COALESCE(SUM(purchases), 0), COALESCE(SUM(revenue), 0), COALESCE(SUM(first_purchases), 0), COALESCE(SUM(buyers), 0), COALESCE(SUM(last_buyers), 0), COALESCE(SUM(prev_buyers), 0), COALESCE(SUM(new_clients), 0), COALESCE(SUM(imported_clients), 0), COALESCE(SUM(honey_accrued), 0), COALESCE(SUM(honey_redeemed), 0), COALESCE(SUM(honey_expired), 0), COALESCE(SUM(honey_imported), 0), COALESCE(SUM(gifts_unlocked), 0), COALESCE(SUM(gifts_used), 0), COALESCE(SUM(reversals), 0), COALESCE(SUM(reversed_amount), 0) FROM (
SELECT date(p.created_at, '+5 hours') AS day, 1 AS purchases, p.amount AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM purchases p WHERE p.status = 'active' AND 1
 UNION ALL SELECT date(p.reversed_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 1 AS reversals, p.amount AS reversed_amount FROM purchases p WHERE p.status = 'reversed' AND 1
 UNION ALL SELECT x.day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 1 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM (SELECT DISTINCT p.client_id, date(p.created_at, '+5 hours') AS day FROM purchases p WHERE p.status = 'active' AND 1) x
 UNION ALL SELECT date(p.created_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 1 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM purchases p
       WHERE p.status = 'active' AND 1
         AND p.created_at = (SELECT MIN(q.created_at) FROM purchases q WHERE q.status = 'active' AND q.client_id = p.client_id)
 UNION ALL SELECT date(MAX(p.created_at), '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 1 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM purchases p WHERE p.status = 'active' AND 1 GROUP BY p.client_id
) WHERE true GROUP BY day
ON CONFLICT(day) DO UPDATE SET purchases = purchases + excluded.purchases, revenue = revenue + excluded.revenue, first_purchases = first_purchases + excluded.first_purchases, buyers = buyers + excluded.buyers, last_buyers = last_buyers + excluded.last_buyers, prev_buyers = prev_buyers + excluded.prev_buyers, new_clients = new_clients + excluded.new_clients, imported_clients = imported_clients + excluded.imported_clients, honey_accrued = honey_accrued + excluded.honey_accrued, honey_redeemed = honey_redeemed + excluded.honey_redeemed, honey_expired = honey_expired + excluded.honey_expired, honey_imported = honey_imported + excluded.honey_imported, gifts_unlocked = gifts_unlocked + excluded.gifts_unlocked, gifts_used = gifts_used + excluded.gifts_used, reversals = reversals + excluded.reversals, reversed_amount = reversed_amount + excluded.reversed_amount;

INSERT INTO stats_daily (day, purchases, revenue, first_purchases, buyers, last_buyers, prev_buyers, new_clients, imported_clients, honey_accrued, honey_redeemed, honey_expired, honey_imported, gifts_unlocked, gifts_used, reversals, reversed_amount)
SELECT day, COALESCE(SUM(purchases), 0), COALESCE(SUM(revenue), 0), COALESCE(SUM(first_purchases), 0), COALESCE(SUM(buyers), 0), COALESCE(SUM(last_buyers), 0), COALESCE(SUM(prev_buyers), 0), COALESCE(SUM(new_clients), 0), COALESCE(SUM(imported_clients), 0), COALESCE(SUM(honey_accrued), 0), COALESCE(SUM(honey_redeemed), 0), COALESCE(SUM(honey_expired), 0), COALESCE(SUM(honey_imported), 0), COALESCE(SUM(gifts_unlocked), 0), COALESCE(SUM(gifts_used), 0), COALESCE(SUM(reversals), 0), COALESCE(SUM(reversed_amount), 0) FROM (
SELECT date(x.at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 1 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM (
       SELECT (SELECT q.created_at FROM purchases q WHERE q.status = 'active' AND q.client_id = c.id ORDER BY q.created_at DESC LIMIT 1 OFFSET 1) AS at
       FROM clients c WHERE 1) x WHERE x.at IS NOT NULL
 UNION ALL SELECT date(c.created_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, CASE WHEN EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id) THEN 0 ELSE 1 END AS new_clients, CASE WHEN EXISTS (SELECT 1 FROM client_imports i WHERE i.client_id = c.id) THEN 1 ELSE 0 END AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM clients c WHERE 1
 UNION ALL SELECT date(l.created_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, CASE WHEN l.type IN ('accrual', 'welcome') OR (l.type = 'manual_adjust' AND l.amount > 0 AND COALESCE(l.idempotency_key, '') NOT LIKE 'import:%') OR (l.type = 'reversal' AND l.amount < 0) THEN l.amount ELSE 0 END AS honey_accrued, CASE WHEN l.type = 'redeem' OR (l.type = 'manual_adjust' AND l.amount < 0) OR (l.type = 'reversal' AND l.amount > 0) THEN -l.amount ELSE 0 END AS honey_redeemed, CASE WHEN l.type = 'expire' THEN -l.amount ELSE 0 END AS honey_expired, CASE WHEN l.type = 'manual_adjust' AND l.amount > 0 AND COALESCE(l.idempotency_key, '') LIKE 'import:%' THEN l.amount ELSE 0 END AS honey_imported, 0 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM points_ledger l WHERE 1
 UNION ALL SELECT date(r.unlocked_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 1 AS gifts_unlocked, 0 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM rewards r WHERE r.status <> 'revoked' AND 1
 UNION ALL SELECT date(r.used_at, '+5 hours') AS day, 0 AS purchases, 0 AS revenue, 0 AS first_purchases, 0 AS buyers, 0 AS last_buyers, 0 AS prev_buyers, 0 AS new_clients, 0 AS imported_clients, 0 AS honey_accrued, 0 AS honey_redeemed, 0 AS honey_expired, 0 AS honey_imported, 0 AS gifts_unlocked, 1 AS gifts_used, 0 AS reversals, 0 AS reversed_amount FROM rewards r WHERE r.status = 'used' AND 1
) WHERE true GROUP BY day
ON CONFLICT(day) DO UPDATE SET purchases = purchases + excluded.purchases, revenue = revenue + excluded.revenue, first_purchases = first_purchases + excluded.first_purchases, buyers = buyers + excluded.buyers, last_buyers = last_buyers + excluded.last_buyers, prev_buyers = prev_buyers + excluded.prev_buyers, new_clients = new_clients + excluded.new_clients, imported_clients = imported_clients + excluded.imported_clients, honey_accrued = honey_accrued + excluded.honey_accrued, honey_redeemed = honey_redeemed + excluded.honey_redeemed, honey_expired = honey_expired + excluded.honey_expired, honey_imported = honey_imported + excluded.honey_imported, gifts_unlocked = gifts_unlocked + excluded.gifts_unlocked, gifts_used = gifts_used + excluded.gifts_used, reversals = reversals + excluded.reversals, reversed_amount = reversed_amount + excluded.reversed_amount;

INSERT INTO stats_daily (day, purchases, revenue, first_purchases, buyers, last_buyers, prev_buyers, new_clients, imported_clients, honey_accrued, honey_redeemed, honey_expired, honey_imported, gifts_unlocked, gifts_used, reversals, reversed_amount)
SELECT '*', COALESCE(SUM(purchases), 0), COALESCE(SUM(revenue), 0), COALESCE(SUM(first_purchases), 0), COALESCE(SUM(buyers), 0), COALESCE(SUM(last_buyers), 0), COALESCE(SUM(prev_buyers), 0), COALESCE(SUM(new_clients), 0), COALESCE(SUM(imported_clients), 0), COALESCE(SUM(honey_accrued), 0), COALESCE(SUM(honey_redeemed), 0), COALESCE(SUM(honey_expired), 0), COALESCE(SUM(honey_imported), 0), COALESCE(SUM(gifts_unlocked), 0), COALESCE(SUM(gifts_used), 0), COALESCE(SUM(reversals), 0), COALESCE(SUM(reversed_amount), 0) FROM stats_daily;
