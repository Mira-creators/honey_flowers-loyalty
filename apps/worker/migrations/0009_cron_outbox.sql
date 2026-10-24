-- Hourly daily job within the Workers Free subrequest budget (R2, apps/worker/src/cron.ts).
--
-- The job now runs every hour; it applies expiries / reminders at any hour but sends Telegram
-- messages only between 09:00 and 21:00 Tashkent. Messages produced by the job go to this outbox
-- in the SAME batch as the facts (expiry entries, reminder keys), so a reminder is never "marked
-- sent" without a message that will really be sent: rows are marked sent only after Telegram
-- accepted them; a failed send is retried by a later run (backoff), a permanent error (bot blocked,
-- chat not found) is recorded as failed — both in notifications_log too, never silently dropped.
CREATE TABLE outbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  events           TEXT NOT NULL CHECK (json_valid(events)),   -- LoyaltyEvent[] of one client (composed at send time)
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,                              -- real time (ISO)
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  last_error       TEXT
);
-- Pending rows in send order; sent / failed rows are not in the index (it stays small).
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX outbox_client_idx ON outbox (client_id);

-- Per-run accounting (GET /health shows the last run).
ALTER TABLE cron_runs ADD COLUMN sent INTEGER NOT NULL DEFAULT 0;         -- messages Telegram accepted in this run
ALTER TABLE cron_runs ADD COLUMN send_failed INTEGER NOT NULL DEFAULT 0;  -- send attempts that failed (retried later or failed for good)
ALTER TABLE cron_runs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;       -- messages still waiting in the outbox after the run
ALTER TABLE cron_runs ADD COLUMN subrequests INTEGER NOT NULL DEFAULT 0;  -- D1 round trips + fetches of the run (Workers Free: 50)
