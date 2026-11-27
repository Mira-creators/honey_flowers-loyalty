-- 0011: the owner's rules (questionnaire 10.11.2026, docs/Спорные вопросы.md Л1–Л9, Д1).
--
--  1. Rules: a database that still runs the pre-questionnaire PLACEHOLDER rules (packages/core
--     RULES_V1_PLACEHOLDER: levels by sum 2 000 000 / 6 000 000, мёд 90 days, cell from 100 000, no
--     welcome bonus, no birthday gift) gets a NEW rules version with packages/core defaultRules
--     (levels by count, sticky, 90-day reset timer, мёд 180 days, welcome 15 000, no cell minimum,
--     birthday −10 %). Rules the owner already edited are never touched. A fresh database has no
--     rules yet: the Worker seeds defaultRules on first use. The JSON below must equal defaultRules
--     (apps/worker/test/migration0011.test.ts checks it).
--  2. Consent (Д1): which version of «Правила программы» + «Согласие на обработку персональных
--     данных» a client accepted and when. Accepted BEFORE registration (tg_users), copied to the
--     client when the card is created; existing clients are asked once on their next open.
--  3. Birthday gift: rewards.valid_until — the last local day a gift may be used.
--  4. Credit by phone (Л9): phone_credits marks a client created by staff for a phone that has no
--     card yet (placeholder telegram_id −998XXXXXXXXX, like an import). Such a card is CLAIMABLE: the
--     first Telegram user who shares that phone takes it over with all accruals.

-- ---------------------------------------------------------------- 2. consent
ALTER TABLE clients ADD COLUMN consent_version TEXT;
ALTER TABLE tg_users ADD COLUMN consent_version TEXT;
ALTER TABLE tg_users ADD COLUMN consent_at TEXT;

-- ---------------------------------------------------------------- 3. gift end date
ALTER TABLE rewards ADD COLUMN valid_until TEXT;              -- YYYY-MM-DD Tashkent, inclusive; NULL = no end
-- Birthday gifts ('bday-<year>-<client>') of a client, for the once-a-year check of the bounded load
-- (db/stateLoader.ts): partial, so it costs nothing for honeycomb gifts.
CREATE INDEX rewards_bday_idx ON rewards (client_id, unlocked_at) WHERE id LIKE 'bday-%';

-- ---------------------------------------------------------------- 4. credit by phone
CREATE TABLE phone_credits (
  client_id   TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,                                  -- E.164 at creation
  created_by  TEXT,                                           -- staff id
  created_at  TEXT NOT NULL,
  claimed_at  TEXT                                            -- when a Telegram account took the card over
);

-- ---------------------------------------------------------------- 1. rules
WITH cur AS (
  SELECT r.id, r.rules FROM rules_versions r
  WHERE r.id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)
)
INSERT INTO rules_versions (id, rules, active_from, created_by, created_at)
SELECT
  (SELECT MAX(id) FROM rules_versions) + 1,
  json_set('{"version":1,"timezone":"Asia/Tashkent","languages":["ru","uz"],"levels":{"criterion":"count","windowMonths":null,"windowDays":90,"oncePerDay":true,"mode":"sticky","resetAfterDays":90,"resetWarnDays":[7,1],"tiers":[{"id":"bee","title":"Пчёлка","cashbackPct":1,"threshold":0},{"id":"queen","title":"Королева улья","cashbackPct":3,"threshold":3},{"id":"gold","title":"Золотой мёд","cashbackPct":5,"threshold":10}]},"maxRedeemPct":50,"maxPurchaseAmount":100000000,"reversalWindowHours":24,"staffCanReverse":true,"allowDiscountWithPoints":false,"welcomeBonus":15000,"cashbackCategories":{"flowers":true,"delivery":false,"cards":true,"wedding":true},"honeycomb":{"cells":10,"rewards":[{"cell":3,"type":"free_card","title":"Открытка в подарок"},{"cell":6,"type":"free_delivery","title":"Бесплатная доставка"},{"cell":10,"type":"discount_pct","value":10,"title":"Скидка 10% на следующий заказ"}],"minPurchaseForCell":0,"maxCellsPerDay":1,"afterLastCell":"restart"},"expiry":{"expiryDays":180,"expiryWarnDays":[14,7,1],"onExpiry":"balance_only"},"birthdayReward":{"enabled":true,"type":"discount_pct","value":10,"daysBefore":3,"daysAfter":3}}', '$.version', (SELECT MAX(id) FROM rules_versions) + 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration:0011',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM cur
WHERE json_extract(cur.rules, '$.levels.criterion') = 'sum'
  AND json_extract(cur.rules, '$.levels.windowMonths') IS NULL
  AND json_array_length(cur.rules, '$.levels.tiers') = 3
  AND json_extract(cur.rules, '$.levels.tiers[0].cashbackPct') = 1
  AND json_extract(cur.rules, '$.levels.tiers[1].cashbackPct') = 3
  AND json_extract(cur.rules, '$.levels.tiers[2].cashbackPct') = 5
  AND json_extract(cur.rules, '$.levels.tiers[1].threshold') = 2000000
  AND json_extract(cur.rules, '$.levels.tiers[2].threshold') = 6000000
  AND json_extract(cur.rules, '$.levels.tiers[1].title') = 'Медовая'
  AND json_extract(cur.rules, '$.maxRedeemPct') = 50
  AND json_extract(cur.rules, '$.welcomeBonus') = 0
  AND json_extract(cur.rules, '$.honeycomb.minPurchaseForCell') = 100000
  AND json_extract(cur.rules, '$.honeycomb.maxCellsPerDay') = 1
  AND json_extract(cur.rules, '$.expiry.expiryDays') = 90
  AND json_extract(cur.rules, '$.expiry.onExpiry') = 'balance_only'
  AND json_extract(cur.rules, '$.birthdayReward.enabled') = 0;

INSERT INTO settings (key, value)
SELECT 'rules_version', CAST(id AS TEXT) FROM rules_versions WHERE created_by = 'migration:0011'
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- Summaries under the new rules (only if the rules were switched above). The exact sticky level is
-- derived by the engine; this is the 90-day purchase-day count, healed by the next write, the client
-- card or the daily job, which looks at every client once (next_check_on = today).
UPDATE client_stats SET spent = (
    SELECT COUNT(DISTINCT date(p.created_at, '+5 hours')) FROM purchases p
    WHERE p.client_id = client_stats.client_id AND p.status = 'active'
      AND date(p.created_at, '+5 hours') > date('now', '+5 hours', '-90 days'))
WHERE EXISTS (SELECT 1 FROM rules_versions WHERE created_by = 'migration:0011');
UPDATE client_stats SET level_id = CASE WHEN spent >= 10 THEN 'gold' WHEN spent >= 3 THEN 'queen' ELSE 'bee' END
WHERE EXISTS (SELECT 1 FROM rules_versions WHERE created_by = 'migration:0011');
UPDATE client_stats SET expires_on = date(activity_at, '+5 hours', '+179 days')
WHERE balance > 0 AND activity_at <> '' AND EXISTS (SELECT 1 FROM rules_versions WHERE created_by = 'migration:0011');
UPDATE clients SET next_check_on = date('now', '+5 hours')
WHERE EXISTS (SELECT 1 FROM rules_versions WHERE created_by = 'migration:0011');
