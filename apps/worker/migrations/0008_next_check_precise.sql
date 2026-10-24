-- Precise daily-job schedule (R3, apps/worker/src/lib/expirySchedule.ts).
--
-- Before: every write set clients.next_check_on = NULL ("check on the next run") and the job took
-- NULLs first, at most CRON_MAX_CLIENTS per run, so on a day with more active clients than that
-- the dated reminders and expiries starved. Now every write stores the exact next date (the next
-- unsent reminder or the expiry day), NULL means "nothing pending", and the job reads only
-- next_check_on <= today (index clients_next_check_idx), earliest first.
--
-- This migration recomputes the value for every existing client from client_stats (balance,
-- expiry anchor) and the sent reminder keys, with the rules in force and today's Tashkent date
-- (the same SQL as lib/expirySchedule.ts nextChecksSql). The legacy values NULL ("unknown") and
-- '9999-12-31' ("never") disappear.
UPDATE clients SET next_check_on = (
      SELECT MIN(d) FROM (
        SELECT MAX(date(x.exp, '-' || CAST(w.value AS INTEGER) || ' days'), date('now', '+5 hours')) AS d
          FROM json_each((SELECT rules FROM rules_versions WHERE id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)), '$.expiry.expiryWarnDays') w
          WHERE x.bal > 0 AND x.exp > date('now', '+5 hours')
            AND NOT EXISTS (SELECT 1 FROM notification_keys k
                            WHERE k.client_id = x.id AND k.key = 'expiry_warning:' || x.aday || ':' || CAST(w.value AS INTEGER))
        UNION ALL
        SELECT MAX(x.exp, date('now', '+5 hours')) WHERE x.bal > 0 OR json_extract((SELECT rules FROM rules_versions WHERE id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)), '$.expiry.onExpiry') <> 'balance_only'
      ))
    FROM (SELECT c.id AS id, COALESCE(s.balance, 0) AS bal, date(COALESCE(NULLIF(s.activity_at, ''), c.created_at), '+5 hours') AS aday,
            date(date(COALESCE(NULLIF(s.activity_at, ''), c.created_at), '+5 hours'), '+' || CAST(json_extract((SELECT rules FROM rules_versions WHERE id = CAST(COALESCE((SELECT value FROM settings WHERE key = 'rules_version'), '1') AS INTEGER)), '$.expiry.expiryDays') AS INTEGER) || ' days') AS exp
          FROM clients c LEFT JOIN client_stats s ON s.client_id = c.id WHERE true) x
    WHERE x.id = clients.id;
