-- Daily job schedule + indexes for the "recent operations" lists (audit findings W2–W4).

-- clients.next_check_on: local date (YYYY-MM-DD, Asia/Tashkent) on which the daily
-- job must look at the client again (next expiry warning or the expiry day),
-- written by the job itself (apps/worker/src/cron.ts, lib/expirySchedule.ts).
--   NULL         = unknown: check on the next run (new client, any new ledger/purchase row,
--                  rules changed, test clock moved);
--   '9999-12-31' = nothing can happen until new activity.
-- The job reads only rows with next_check_on IS NULL OR next_check_on <= today, oldest first,
-- a limited number per run, instead of loading every client every night.
ALTER TABLE clients ADD COLUMN next_check_on TEXT;
CREATE INDEX clients_next_check_idx ON clients (next_check_on);

-- "Recent operations" (staff list, owner journal) take the newest N rows of each
-- source table; these partial indexes let SQLite do that without scanning the tables.
CREATE INDEX purchases_reversed_idx ON purchases (reversed_at) WHERE status = 'reversed';
CREATE INDEX points_ledger_standalone_idx ON points_ledger (created_at) WHERE purchase_id IS NULL;
CREATE INDEX rewards_handed_out_idx ON rewards (used_at) WHERE status = 'used' AND used_in_purchase IS NULL;
