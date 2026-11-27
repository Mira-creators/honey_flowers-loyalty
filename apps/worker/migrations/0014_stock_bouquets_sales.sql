-- Склад (M4–M5, прототип): букеты с замороженной себестоимостью, продажи и их строки.
-- Архитектура §3.3. Отличия прототипа:
--  * продажа ↔ покупка лояльности — два шага (склад, затем лояльность с ключом 'sale:<id>'),
--    поэтому у продажи есть loyalty_status ('none' без клиента | 'pending' | 'done' | 'failed') и
--    параметры второго шага (redeem, gift_id, channel), чтобы повтор доводил его до конца;
--  * client_id без FK на clients: сброс клиента в TEST_MODE (deleteClient) не должен упираться в склад
--    (так же сделана связь loyalty_purchase_id).

CREATE TABLE stock_bouquets (
  id                   TEXT PRIMARY KEY,
  assembly_doc_id      TEXT NOT NULL UNIQUE REFERENCES stock_docs(id),
  template_id          TEXT REFERENCES stock_templates(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('order','showcase')),
  status               TEXT NOT NULL CHECK (status IN ('assembled','on_showcase','sold','disassembled','written_off','cancelled')),
  florist_id           TEXT NOT NULL,
  florist_name         TEXT,
  cost_mu              INTEGER NOT NULL CHECK (cost_mu >= 0),        -- = −Σ value_mu движений сборки + Σ позиций без учёта (инвариант QA)
  cost_uzs             INTEGER NOT NULL CHECK (cost_uzs >= 0),
  flowers_cost_uzs     INTEGER NOT NULL CHECK (flowers_cost_uzs >= 0),
  supplies_cost_uzs    INTEGER NOT NULL CHECK (supplies_cost_uzs >= 0),
  labour_uzs           INTEGER NOT NULL DEFAULT 0,
  suggested_price_uzs  INTEGER NOT NULL CHECK (suggested_price_uzs >= 0),
  price_uzs            INTEGER NOT NULL CHECK (price_uzs > 0),
  price_current_uzs    INTEGER NOT NULL CHECK (price_current_uzs > 0),
  used_deficit         INTEGER NOT NULL DEFAULT 0 CHECK (used_deficit IN (0,1)),
  deficit_comment      TEXT,
  photo_key            TEXT,
  sale_id              TEXT,
  closed_doc_id        TEXT,                                         -- разборка / сторно
  demo                 INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  closed_at            TEXT,
  CONSTRAINT stock_bouquets_deficit CHECK (used_deficit = 0 OR length(trim(deficit_comment)) >= 3)
);
CREATE INDEX stock_bouquets_showcase_idx ON stock_bouquets (created_at) WHERE status IN ('assembled','on_showcase');  -- витрина
CREATE INDEX stock_bouquets_created_idx  ON stock_bouquets (created_at);                                             -- маржа за период

-- Автомат статусов = страж от двойной продажи/разборки: UPDATE … SET status = 'sold' WHERE id = ? без условия
-- по статусу, поэтому второй конкурент получает OLD.status = 'sold' → ABORT (а не тихие 0 изменённых строк).
CREATE TRIGGER stock_bouquets_transition BEFORE UPDATE OF status ON stock_bouquets
WHEN NOT (
     (OLD.status IN ('assembled','on_showcase') AND NEW.status IN ('on_showcase','sold','disassembled','written_off','cancelled') AND NEW.status <> OLD.status)
  OR (OLD.status = 'sold' AND NEW.status = 'on_showcase'))
BEGIN SELECT RAISE(ABORT, 'stock: букет уже продан, разобран или списан'); END;
CREATE TRIGGER stock_bouquets_frozen
BEFORE UPDATE OF cost_mu, cost_uzs, flowers_cost_uzs, supplies_cost_uzs, labour_uzs, assembly_doc_id, florist_id, kind ON stock_bouquets
BEGIN SELECT RAISE(ABORT, 'stock: себестоимость букета заморожена'); END;
CREATE TRIGGER stock_bouquets_no_delete BEFORE DELETE ON stock_bouquets
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock: букеты не удаляются'); END;

CREATE TABLE stock_sales (
  id                   TEXT PRIMARY KEY REFERENCES stock_docs(id),   -- = документ kind 'sale'
  client_id            TEXT,                                         -- clients.id (без FK, см. заголовок)
  loyalty_purchase_id  TEXT UNIQUE,                                  -- purchases.id (без FK)
  loyalty_status       TEXT NOT NULL DEFAULT 'none' CHECK (loyalty_status IN ('none','pending','done','failed')),
  loyalty_error        TEXT,
  redeem               INTEGER NOT NULL DEFAULT 0 CHECK (redeem IN (0,1)),
  gift_id              TEXT,
  total_uzs            INTEGER NOT NULL CHECK (total_uzs > 0),
  honey_redeemed       INTEGER NOT NULL DEFAULT 0 CHECK (honey_redeemed >= 0),
  discount_uzs         INTEGER NOT NULL DEFAULT 0 CHECK (discount_uzs >= 0),
  paid_uzs             INTEGER NOT NULL CHECK (paid_uzs >= 0),
  payment_method       TEXT NOT NULL CHECK (payment_method IN ('cash','card','transfer','mixed')),
  channel              TEXT NOT NULL DEFAULT 'store' CHECK (channel IN ('store','delivery')),
  cost_uzs             INTEGER NOT NULL CHECK (cost_uzs >= 0),       -- себестоимость проданного, заморожена
  status               TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','reversed')),
  reversed_at          TEXT,
  reversed_by          TEXT,
  reversed_reason      TEXT,
  actor_id             TEXT NOT NULL,
  demo                 INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  CONSTRAINT stock_sales_paid CHECK (paid_uzs = total_uzs - honey_redeemed - discount_uzs),
  CONSTRAINT stock_sales_loyalty CHECK ((client_id IS NULL) = (loyalty_status = 'none') AND (loyalty_purchase_id IS NULL OR client_id IS NOT NULL)),
  CONSTRAINT stock_sales_reversal CHECK ((status = 'reversed') = (reversed_at IS NOT NULL AND length(trim(reversed_reason)) >= 3))
);
CREATE INDEX stock_sales_created_idx ON stock_sales (created_at);
CREATE INDEX stock_sales_loyalty_idx ON stock_sales (created_at) WHERE loyalty_status IN ('pending','failed');   -- сверка второго шага
CREATE TRIGGER stock_sales_no_delete BEFORE DELETE ON stock_sales
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock: продажи не удаляются'); END;

CREATE TABLE stock_sale_lines (
  sale_id     TEXT NOT NULL REFERENCES stock_sales(id),
  line_no     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('bouquet','item','service')),
  bouquet_id  TEXT REFERENCES stock_bouquets(id),
  item_id     TEXT REFERENCES stock_items(id),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  price_uzs   INTEGER NOT NULL CHECK (price_uzs >= 0),     -- за строку
  cost_uzs    INTEGER NOT NULL DEFAULT 0,
  category    TEXT NOT NULL CHECK (category IN ('flowers','cards','delivery','wedding')),   -- категории кешбэка лояльности
  PRIMARY KEY (sale_id, line_no),
  CONSTRAINT stock_sale_lines_ref CHECK ((kind = 'bouquet') = (bouquet_id IS NOT NULL) AND (kind <> 'bouquet') = (item_id IS NOT NULL))
) WITHOUT ROWID;
