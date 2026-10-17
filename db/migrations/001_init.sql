-- Honey Flowers loyalty program: initial schema (PostgreSQL 16).
--
-- Conventions
--   * Money and points are BIGINT UZS (1 "мёд" = 1 сум). No floats.
--   * Timestamps are TIMESTAMPTZ; calendar logic uses Asia/Tashkent in the app.
--   * points_ledger is append-only: balance = SUM(amount). Never UPDATE/DELETE it.
--   * Field names mirror packages/core types (ClientState, Outcome).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() (built in since PG13, kept for clarity)

-- ---------------------------------------------------------------- clients
CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT NOT NULL UNIQUE,
  phone           TEXT,                       -- E.164, e.g. +998901234567
  name            TEXT,
  birthday        DATE,
  language        TEXT NOT NULL DEFAULT 'ru' CHECK (language IN ('ru', 'uz', 'en')),
  consent_at      TIMESTAMPTZ,                -- personal data consent (Q24)
  -- Level floor/reset set by expiry (LevelOverride in core):
  -- effective level = max(override, level from purchases after level_override_at).
  level_override     TEXT,
  level_override_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clients_phone_format CHECK (phone IS NULL OR phone ~ '^\+[0-9]{9,15}$'),
  CONSTRAINT clients_override_pair CHECK ((level_override IS NULL) = (level_override_at IS NULL))
);
-- Phone search by the trailing digits typed by the florist.
CREATE UNIQUE INDEX clients_phone_uq ON clients (phone) WHERE phone IS NOT NULL;
CREATE INDEX clients_phone_reverse_idx ON clients (reverse(phone) text_pattern_ops) WHERE phone IS NOT NULL;
CREATE INDEX clients_birthday_idx ON clients (EXTRACT(MONTH FROM birthday), EXTRACT(DAY FROM birthday)) WHERE birthday IS NOT NULL;

-- ---------------------------------------------------------------- staff
CREATE TABLE staff (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  BIGINT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('florist', 'manager', 'owner')),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- rules
-- Versioned LoyaltyRules JSON (validated by the zod schema in packages/core).
-- The version in force at time T = latest row with active_from <= T.
CREATE TABLE rules_versions (
  id           INTEGER PRIMARY KEY,           -- = rules.version
  rules        JSONB NOT NULL,
  active_from  TIMESTAMPTZ NOT NULL,
  created_by   UUID REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rules_versions_version_match CHECK ((rules ->> 'version')::int = id)
);
CREATE UNIQUE INDEX rules_versions_active_from_uq ON rules_versions (active_from);

-- ---------------------------------------------------------------- purchases
CREATE TABLE purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id),
  staff_id          UUID REFERENCES staff(id),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  lines             JSONB NOT NULL,             -- [{category, amount}], sum = amount (checked in app)
  channel           TEXT NOT NULL CHECK (channel IN ('store', 'delivery')),
  points_redeemed   BIGINT NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0),
  discount_applied  BIGINT NOT NULL DEFAULT 0 CHECK (discount_applied >= 0),
  reward_used_id    TEXT,                        -- FK added below (rewards defined later)
  idempotency_key   TEXT NOT NULL UNIQUE,
  rules_version_id  INTEGER NOT NULL REFERENCES rules_versions(id),
  result            JSONB,                       -- PurchaseSummary, returned on idempotent replay
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
  reversed_reason   TEXT,
  reversed_by       UUID REFERENCES staff(id),
  reversed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchases_lines_array CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  CONSTRAINT purchases_paid_nonnegative CHECK (points_redeemed + discount_applied <= amount),
  CONSTRAINT purchases_reversal_fields CHECK (
    (status = 'active'   AND reversed_reason IS NULL AND reversed_at IS NULL) OR
    (status = 'reversed' AND reversed_reason IS NOT NULL AND length(btrim(reversed_reason)) > 0 AND reversed_at IS NOT NULL)
  )
);
CREATE INDEX purchases_client_created_idx ON purchases (client_id, created_at);
CREATE INDEX purchases_staff_created_idx ON purchases (staff_id, created_at);

-- ---------------------------------------------------------------- points ledger
CREATE TABLE points_ledger (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id        UUID NOT NULL REFERENCES clients(id),
  type             TEXT NOT NULL CHECK (type IN ('accrual', 'redeem', 'expire', 'reversal', 'welcome', 'manual_adjust')),
  amount           BIGINT NOT NULL CHECK (amount <> 0),   -- signed
  purchase_id      UUID REFERENCES purchases(id),
  staff_id         UUID REFERENCES staff(id),
  reason           TEXT,
  idempotency_key  TEXT UNIQUE,                            -- standalone redeem / manual adjust
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_sign CHECK (
    (type IN ('accrual', 'welcome') AND amount > 0) OR
    (type IN ('redeem', 'expire') AND amount < 0) OR
    (type IN ('reversal', 'manual_adjust'))
  ),
  CONSTRAINT ledger_accrual_has_purchase CHECK (type NOT IN ('accrual', 'reversal') OR purchase_id IS NOT NULL),
  CONSTRAINT ledger_manual_has_reason CHECK (type <> 'manual_adjust' OR (staff_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX points_ledger_client_idx ON points_ledger (client_id, created_at);
CREATE INDEX points_ledger_purchase_idx ON points_ledger (purchase_id) WHERE purchase_id IS NOT NULL;
-- Welcome bonus at most once per client.
CREATE UNIQUE INDEX points_ledger_welcome_once ON points_ledger (client_id) WHERE type = 'welcome';

-- Append-only guard.
CREATE FUNCTION points_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points_ledger is append-only (use a reversal or manual_adjust entry)';
END $$;
CREATE TRIGGER points_ledger_no_update BEFORE UPDATE OR DELETE ON points_ledger
  FOR EACH ROW EXECUTE FUNCTION points_ledger_immutable();

-- ---------------------------------------------------------------- honeycomb
CREATE TABLE card_moves (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    UUID NOT NULL REFERENCES clients(id),
  purchase_id  UUID REFERENCES purchases(id),
  cycle        INTEGER NOT NULL CHECK (cycle >= 1),
  cell         INTEGER NOT NULL CHECK (cell >= 0),       -- 0 = reset to an empty card
  reason       TEXT NOT NULL DEFAULT 'purchase' CHECK (reason IN ('purchase', 'expiry_reset')),
  reverted_at  TIMESTAMPTZ,                               -- set when a reversal rolled it back
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT card_moves_kind CHECK (
    (reason = 'purchase' AND purchase_id IS NOT NULL AND cell >= 1) OR
    (reason = 'expiry_reset' AND purchase_id IS NULL AND cell = 0)
  )
);
CREATE INDEX card_moves_client_idx ON card_moves (client_id, created_at);
-- A purchase moves the card at most once; a live cell is filled at most once.
CREATE UNIQUE INDEX card_moves_purchase_uq ON card_moves (purchase_id) WHERE reverted_at IS NULL AND purchase_id IS NOT NULL;
CREATE UNIQUE INDEX card_moves_cell_uq ON card_moves (client_id, cycle, cell) WHERE reverted_at IS NULL AND reason = 'purchase';

CREATE TABLE rewards (
  -- '<cycle>-<cell>-<unlocking purchase id>' as generated by core (rewardId()).
  id                    TEXT PRIMARY KEY,
  client_id             UUID NOT NULL REFERENCES clients(id),
  cycle                 INTEGER NOT NULL CHECK (cycle >= 1),
  cell                  INTEGER NOT NULL CHECK (cell >= 1),
  type                  TEXT NOT NULL CHECK (type IN ('free_card', 'free_delivery', 'discount_pct', 'custom')),
  value                 NUMERIC(12, 2),                  -- percent for discount_pct, cap in UZS for free_*
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used', 'revoked')),
  unlocked_by_purchase  UUID REFERENCES purchases(id),
  used_in_purchase      UUID REFERENCES purchases(id),
  used_idempotency_key  TEXT UNIQUE,                     -- standalone hand-out (POST /staff/redeem)
  unlocked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at               TIMESTAMPTZ,
  CONSTRAINT rewards_used_fields CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE INDEX rewards_client_status_idx ON rewards (client_id, status);
-- Only one live (non-revoked) reward per card cell.
CREATE UNIQUE INDEX rewards_cell_uq ON rewards (client_id, cycle, cell) WHERE status <> 'revoked';

ALTER TABLE purchases
  ADD CONSTRAINT purchases_reward_used_fk FOREIGN KEY (reward_used_id) REFERENCES rewards(id);

-- ---------------------------------------------------------------- important dates
-- "Напоминания о днях рождения близких" (brief, optional feature).
CREATE TABLE important_dates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  month       SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  day         SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 31),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT important_dates_valid_day CHECK (
    day <= CASE WHEN month = 2 THEN 29 WHEN month IN (4, 6, 9, 11) THEN 30 ELSE 31 END
  )
);
CREATE INDEX important_dates_md_idx ON important_dates (month, day);
CREATE INDEX important_dates_client_idx ON important_dates (client_id);

-- ---------------------------------------------------------------- notifications
-- Every notification the bot sends (or tried to). dedupe_key prevents
-- duplicates, e.g. 'expiry_warning:2026-11-01:7' (see runExpiry in core).
CREATE TABLE notifications_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    UUID NOT NULL REFERENCES clients(id),
  type         TEXT NOT NULL,                 -- LoyaltyEvent['type']
  dedupe_key   TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX notifications_log_dedupe_uq ON notifications_log (client_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_log_pending_idx ON notifications_log (created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- views
-- Current points balance per client.
CREATE VIEW client_balances AS
SELECT c.id AS client_id, COALESCE(SUM(l.amount), 0)::BIGINT AS balance
FROM clients c
LEFT JOIN points_ledger l ON l.client_id = c.id
GROUP BY c.id;

COMMIT;
