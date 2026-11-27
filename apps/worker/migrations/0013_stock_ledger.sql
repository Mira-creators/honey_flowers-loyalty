-- Склад (M2–M3, прототип): документы, строки, партии, НЕИЗМЕНЯЕМЫЙ журнал движений, дневные агрегаты.
-- Архитектура §3.2. Остатки (stock_lots.qty_on_hand, stock_item_balances, stock_daily) — кэш журнала,
-- его ведёт триггер в том же операторе, что вставка движения. Страж остатка — CHECK stock_lots_bounds.
-- Отличие от §3.2: причина списания 'writeoff_other' («другое»).

CREATE TABLE stock_docs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('receipt','assembly','sale','writeoff','disassembly','count','return','storno')),
  number           INTEGER NOT NULL,                     -- «Приход №12»: MAX(number)+1 внутри вида, в том же операторе
  status           TEXT NOT NULL CHECK (status IN ('posting','posted','cancelled','failed')),
  doc_date         TEXT NOT NULL CHECK (doc_date GLOB '????-??-??' AND doc_date NOT GLOB '*[^0-9-]*'),   -- короткие шаблоны: у D1 лимит длины GLOB
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_hash     TEXT NOT NULL,                        -- SHA-256 нормализованного запроса: тот же ключ + другой состав = 409
  actor_id         TEXT NOT NULL,                        -- staff id или 'tg:<id>' (TEST_MODE), как purchases.staff_id
  actor_role       TEXT NOT NULL,
  supplier_id      TEXT REFERENCES stock_suppliers(id),
  cancels_doc_id   TEXT REFERENCES stock_docs(id),
  total_value_mu   INTEGER NOT NULL DEFAULT 0,           -- Σ |value_mu| движений документа (списки без JOIN)
  extra_cost_uzs   INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_uzs >= 0),
  currency         TEXT NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD','EUR')),   -- валюта прихода (одна на документ)
  fx_rate_x100     INTEGER CHECK (fx_rate_x100 IS NULL OR fx_rate_x100 > 0),             -- сумов за 1 единицу валюты × 100
  price_mode       TEXT CHECK (price_mode IS NULL OR price_mode IN ('lines','total')),    -- приход: цены построчно или одной суммой
  input_total      INTEGER CHECK (input_total IS NULL OR input_total >= 0),               -- приход «одной суммой»: сумы или центы
  approval         TEXT NOT NULL DEFAULT 'none' CHECK (approval IN ('none','pending','approved','rejected')),
  approved_by      TEXT,
  approved_at      TEXT,
  note             TEXT CHECK (note IS NULL OR length(note) <= 500),
  photo_key        TEXT,
  demo             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  posted_at        TEXT,
  CONSTRAINT stock_docs_fx CHECK ((currency = 'UZS') = (fx_rate_x100 IS NULL)),
  CONSTRAINT stock_docs_total CHECK ((price_mode IS 'total') = (input_total IS NOT NULL)),
  CONSTRAINT stock_docs_storno CHECK ((kind = 'storno') = (cancels_doc_id IS NOT NULL)),
  CONSTRAINT stock_docs_approval CHECK (approval IN ('none','pending') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX stock_docs_number_uq   ON stock_docs (kind, number);                          -- нумерация + поиск «№12»
CREATE UNIQUE INDEX stock_docs_cancels_uq  ON stock_docs (cancels_doc_id) WHERE cancels_doc_id IS NOT NULL;  -- сторно один раз
CREATE INDEX stock_docs_date_idx           ON stock_docs (doc_date, kind);                        -- списки и отчёты за период
CREATE INDEX stock_docs_posting_idx        ON stock_docs (created_at) WHERE status = 'posting';   -- уборщик (обычно пуст)
CREATE INDEX stock_docs_pending_idx        ON stock_docs (created_at) WHERE approval = 'pending'; -- «На подтверждение»

-- Заголовок меняет только статус (по автомату) и подтверждение; ключ освобождается только при failed.
CREATE TRIGGER stock_docs_guard BEFORE UPDATE ON stock_docs
WHEN NOT (
      OLD.status = NEW.status
   OR (OLD.status = 'posting' AND NEW.status IN ('posted','failed'))
   OR (OLD.status = 'posted'  AND NEW.status = 'cancelled')
  )
  OR NEW.kind IS NOT OLD.kind OR NEW.number IS NOT OLD.number OR NEW.doc_date IS NOT OLD.doc_date
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.cancels_doc_id IS NOT OLD.cancels_doc_id
  OR (NEW.idempotency_key IS NOT OLD.idempotency_key AND NEW.status <> 'failed')
  OR (OLD.status <> 'posting' AND (NEW.total_value_mu IS NOT OLD.total_value_mu OR NEW.extra_cost_uzs IS NOT OLD.extra_cost_uzs))
  -- подтверждение: только pending → approved | rejected (повторное нажатие → ABORT → 409 «Уже решено»)
  OR (NEW.approval IS NOT OLD.approval AND NOT (OLD.approval = 'pending' AND NEW.approval IN ('approved','rejected')))
BEGIN SELECT RAISE(ABORT, 'stock: недопустимое изменение документа'); END;
CREATE TRIGGER stock_docs_no_delete BEFORE DELETE ON stock_docs
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock: документы не удаляются (отмена — сторно)'); END;

-- Строки документа: что ввёл человек (план/факт, пачки, цена «как в накладной»). Учётная правда — в движениях.
CREATE TABLE stock_doc_lines (
  doc_id           TEXT NOT NULL REFERENCES stock_docs(id),
  line_no          INTEGER NOT NULL,
  item_id          TEXT NOT NULL REFERENCES stock_items(id),
  qty              INTEGER NOT NULL,                     -- факт, базовые единицы
  qty_planned      INTEGER,                              -- по шаблону
  input_qty        INTEGER,                              -- как ввели: 2 (пачки)
  input_unit       TEXT CHECK (input_unit IS NULL OR input_unit IN ('base','pack')),
  input_price      INTEGER,                              -- как ввели: сумы или центы валюты
  input_price_per  TEXT CHECK (input_price_per IS NULL OR input_price_per IN ('unit','pack','line')),
  ref_cost_mu      INTEGER,                              -- приход «одной суммой»: опорная цена для распределения (аудит)
  manual_price     INTEGER NOT NULL DEFAULT 0 CHECK (manual_price IN (0,1)),
  value_mu         INTEGER,                              -- приход: стоимость строки без накладных
  unit_cost_mu     INTEGER,                              -- приход: итог с накладными
  landed_mu        INTEGER,                              -- приход: доля накладных строки
  rounding_mu      INTEGER NOT NULL DEFAULT 0,           -- приход: расхождение округления (< 1 сум при qty < 2000)
  reason           TEXT,                                 -- списание: причина строки
  lot_id           TEXT,                                 -- партия, если выбрана явно (экран свежести)
  PRIMARY KEY (doc_id, line_no)
) WITHOUT ROWID;

CREATE TABLE stock_lots (
  id              TEXT PRIMARY KEY,                       -- UUID; дефицит: 'def:<item>:<cost_mu>'
  item_id         TEXT NOT NULL REFERENCES stock_items(id),
  kind            TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','deficit','surplus')),
  receipt_doc_id  TEXT REFERENCES stock_docs(id),
  supplier_id     TEXT REFERENCES stock_suppliers(id),
  received_at     TEXT NOT NULL,                          -- FIFO-ключ
  sell_by         TEXT,                                   -- YYYY-MM-DD: продать до (свежесть)
  expires_on      TEXT,                                   -- YYYY-MM-DD, FEFO-ключ (приход + срок жизни в вазе)
  qty_received    INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_mu    INTEGER NOT NULL CHECK (unit_cost_mu >= 0),
  price_cur_x100  INTEGER,                                -- исходная цена единицы в валюте × 100 (аудит)
  currency        TEXT NOT NULL DEFAULT 'UZS' CHECK (currency IN ('UZS','USD','EUR')),
  qty_on_hand     INTEGER NOT NULL DEFAULT 0,             -- кэш Σ движений; ведёт триггер
  priority        INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0,1)),
  promo_pct       INTEGER NOT NULL DEFAULT 0 CHECK (promo_pct BETWEEN 0 AND 90),
  location_id     INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  CONSTRAINT stock_lots_kind_ref CHECK ((kind = 'normal') = (receipt_doc_id IS NOT NULL)),
  -- СТРАЖ ОСТАТКА: перерасход партии обрывает оператор (и весь пакет).
  CONSTRAINT stock_lots_bounds CHECK (
       (kind = 'normal'  AND qty_on_hand BETWEEN 0 AND qty_received)
    OR (kind = 'deficit' AND qty_on_hand <= 0)
    OR (kind = 'surplus' AND qty_on_hand >= 0)
  )
);
-- Отбор FIFO/FEFO: только непустые партии, уже в нужном порядке.
CREATE INDEX stock_lots_pick_idx    ON stock_lots (item_id, priority DESC, expires_on, received_at, id) WHERE qty_on_hand > 0;
-- Экран свежести: непустые партии по сроку.
CREATE INDEX stock_lots_fresh_idx   ON stock_lots (sell_by) WHERE qty_on_hand > 0;
-- Отмена прихода, история закупочных цен по позиции.
CREATE INDEX stock_lots_receipt_idx ON stock_lots (receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;
-- Список исключений и погашение: дефициты.
CREATE INDEX stock_lots_deficit_idx ON stock_lots (item_id) WHERE kind = 'deficit' AND qty_on_hand < 0;

CREATE TRIGGER stock_lots_immutable
BEFORE UPDATE OF item_id, kind, receipt_doc_id, received_at, qty_received, unit_cost_mu ON stock_lots
BEGIN SELECT RAISE(ABORT, 'stock: партия неизменяема'); END;
CREATE TRIGGER stock_lots_no_delete BEFORE DELETE ON stock_lots
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock: партии не удаляются'); END;

-- Дневные агрегаты (как stats_daily): отчёты за любой период читают ~дни × активные позиции строк.
CREATE TABLE stock_daily (
  day       TEXT NOT NULL,          -- doc_date (учётная дата)
  item_id   TEXT NOT NULL,
  reason    TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 0,
  value_mu  INTEGER NOT NULL DEFAULT 0,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, item_id, reason)
) WITHOUT ROWID;

-- НЕИЗМЕНЯЕМЫЙ ЖУРНАЛ. Порядок строк = id (AUTOINCREMENT, монотонный).
CREATE TABLE stock_moves (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id            TEXT NOT NULL REFERENCES stock_docs(id),
  line_no           INTEGER NOT NULL,
  item_id           TEXT NOT NULL REFERENCES stock_items(id),
  lot_id            TEXT NOT NULL REFERENCES stock_lots(id),
  qty               INTEGER NOT NULL CHECK (qty <> 0),
  value_mu          INTEGER NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN (
                      'receipt','assembly','sale','disassembly_return','disassembly_waste',
                      'writeoff_wilt','writeoff_damage','writeoff_supplier','writeoff_other','writeoff_showcase','writeoff_gift','writeoff_rework',
                      'count_shortage','count_surplus','deficit_settle','return_supplier')),
  doc_date          TEXT NOT NULL,
  bouquet_id        TEXT,
  reverses_move_id  INTEGER REFERENCES stock_moves(id),   -- сторно: зеркало этого движения
  actor_id          TEXT NOT NULL,
  location_id       INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  CONSTRAINT stock_moves_sign CHECK (
       reverses_move_id IS NOT NULL
    OR (reason IN ('receipt','disassembly_return','count_surplus') AND qty > 0)
    OR (reason IN ('assembly','sale','disassembly_waste','writeoff_wilt','writeoff_damage','writeoff_supplier','writeoff_other',
                   'writeoff_showcase','writeoff_gift','writeoff_rework','count_shortage','return_supplier') AND qty < 0)
    OR  reason = 'deficit_settle')
);
CREATE INDEX stock_moves_item_idx ON stock_moves (item_id, id);       -- история позиции
CREATE INDEX stock_moves_doc_idx  ON stock_moves (doc_id);            -- карточка документа, сторно
CREATE INDEX stock_moves_lot_idx  ON stock_moves (lot_id);            -- сверка партии, разборка «в исходные партии»
CREATE UNIQUE INDEX stock_moves_reverses_uq ON stock_moves (reverses_move_id) WHERE reverses_move_id IS NOT NULL;

CREATE TRIGGER stock_moves_check BEFORE INSERT ON stock_moves
BEGIN
  SELECT RAISE(ABORT, 'stock: стоимость движения не равна qty × цена партии')
    WHERE NEW.value_mu IS NOT NEW.qty * (SELECT unit_cost_mu FROM stock_lots WHERE id = NEW.lot_id);
  SELECT RAISE(ABORT, 'stock: партия другой позиции')
    WHERE NEW.item_id IS NOT (SELECT item_id FROM stock_lots WHERE id = NEW.lot_id);
  SELECT RAISE(ABORT, 'stock: период закрыт')
    WHERE NEW.doc_date <= (SELECT value FROM settings WHERE key = 'stock_closed_through');
  SELECT RAISE(ABORT, 'stock: сторно должно зеркалить исходное движение')
    WHERE NEW.reverses_move_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM stock_moves o
       WHERE o.id = NEW.reverses_move_id AND o.reverses_move_id IS NULL
         AND o.lot_id = NEW.lot_id AND o.qty = -NEW.qty AND o.reason = NEW.reason);
END;

-- Кэши — в том же операторе, что и вставка движения: SQLite откатывает оператор целиком вместе с триггерами.
CREATE TRIGGER stock_moves_apply AFTER INSERT ON stock_moves
BEGIN
  UPDATE stock_lots SET qty_on_hand = qty_on_hand + NEW.qty WHERE id = NEW.lot_id;   -- ← CHECK stock_lots_bounds
  INSERT INTO stock_item_balances (item_id, qty, value_mu, updated_at)
    VALUES (NEW.item_id, NEW.qty, NEW.value_mu, NEW.created_at)
    ON CONFLICT(item_id) DO UPDATE SET qty = qty + excluded.qty, value_mu = value_mu + excluded.value_mu, updated_at = excluded.updated_at;
  INSERT INTO stock_daily (day, item_id, reason, qty, value_mu, n)
    VALUES (NEW.doc_date, NEW.item_id, NEW.reason, NEW.qty, NEW.value_mu, CASE WHEN NEW.reverses_move_id IS NULL THEN 1 ELSE -1 END)
    ON CONFLICT(day, item_id, reason) DO UPDATE SET qty = qty + excluded.qty, value_mu = value_mu + excluded.value_mu, n = n + excluded.n;
END;
CREATE TRIGGER stock_moves_no_update BEFORE UPDATE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'stock_moves: журнал только дополняется (отмена — зеркальным движением)'); END;
CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock_moves: журнал только дополняется (отмена — зеркальным движением)'); END;
