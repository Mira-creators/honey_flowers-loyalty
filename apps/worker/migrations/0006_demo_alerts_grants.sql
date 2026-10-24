-- Demo data, monitoring / alerts and owner grants.

-- ---------------------------------------------------------------- demo data (TEST_MODE)
-- «Заполнить демо-данными» (POST /api/test/demo-seed) marks every row it creates with demo = 1;
-- «Удалить демо-данные» (POST /api/test/demo-clear) removes exactly these rows and their facts.
-- Demo clients have negative telegram_id (never a real Telegram user) and are never messaged.
ALTER TABLE clients ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
-- Partial: rows with demo = 0 (all real clients) are not in the index, so it costs nothing for them.
CREATE INDEX clients_demo_idx ON clients (demo) WHERE demo = 1;

-- ---------------------------------------------------------------- owner grants
-- A gift given by the owner without a purchase (POST /api/owner/clients/:id/grant):
-- who granted it and why (shown in the operations journal and the client history).
ALTER TABLE rewards ADD COLUMN granted_by TEXT;
ALTER TABLE rewards ADD COLUMN grant_reason TEXT;
CREATE INDEX rewards_granted_idx ON rewards (unlocked_at) WHERE granted_by IS NOT NULL;

-- ---------------------------------------------------------------- monitoring
-- Alert throttle (apps/worker/src/lib/alerts.ts): one row per error signature; the same
-- signature is sent to ALERT_CHAT_ID at most once per 15 minutes, repeats are counted.
CREATE TABLE system_events (
  signature     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- 'http' | 'webhook' | 'cron'
  last_sent_at  TEXT NOT NULL,              -- real time (not the TEST_MODE clock)
  suppressed    INTEGER NOT NULL DEFAULT 0, -- repeats since last_sent_at (not sent)
  reported      INTEGER NOT NULL DEFAULT 0, -- repeats reported in the last sent alert
  total         INTEGER NOT NULL DEFAULT 1,
  last_message  TEXT,
  updated_at    TEXT NOT NULL
);

-- One row per daily job run (cron at 04:00 UTC, or «Запустить ночную задачу» in TEST_MODE).
CREATE TABLE cron_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger      TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  checked      INTEGER NOT NULL DEFAULT 0,  -- clients looked at
  warned       INTEGER NOT NULL DEFAULT 0,  -- expiry reminders sent
  expired      INTEGER NOT NULL DEFAULT 0,  -- clients whose мёд burned (or level/card reset)
  burned       INTEGER NOT NULL DEFAULT 0,  -- мёд burned, сум
  failed       INTEGER NOT NULL DEFAULT 0,  -- clients that threw
  more         INTEGER NOT NULL DEFAULT 0,  -- 1 = more clients were due than processed
  error        TEXT
);
CREATE INDEX cron_runs_started_idx ON cron_runs (started_at);
