-- Склад (M1, прототип): справочник позиций, кэш остатков по позиции, поставщики, шаблоны букетов,
-- журнал аудита склада. Архитектура: docs/Склад — архитектура.md §3.1 (там миграция 0011; 0011 занята
-- веткой лояльности, поэтому склад начинается с 0012). Модуль включается флагом STOCK_ENABLED.
--
-- Отличия от §3.1: плитка конструктора — эмодзи и цвет (фото позже, photo_key оставлен);
-- журнал аудита называется stock_audit_log (общий audit_log — отдельное решение для всей системы).

CREATE TABLE stock_items (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,                              -- короткий код: 'RN60'
  name            TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  kind            TEXT NOT NULL CHECK (kind IN ('flower','greenery','supply','service')),
  grp             TEXT NOT NULL DEFAULT '',                          -- группа плиток: 'Розы', 'Упаковка'
  base_unit       TEXT NOT NULL CHECK (base_unit IN ('stem','pcs','cm','sheet','g')),
  display_unit    TEXT NOT NULL,                                     -- 'шт', 'м', 'лист'
  display_factor  INTEGER NOT NULL DEFAULT 1 CHECK (display_factor >= 1),
  pack_name       TEXT,
  pack_size       INTEGER CHECK (pack_size IS NULL OR pack_size BETWEEN 1 AND 100000),
  vase_life_days  INTEGER CHECK (vase_life_days IS NULL OR vase_life_days BETWEEN 1 AND 365),
  sell_days       INTEGER CHECK (sell_days IS NULL OR sell_days BETWEEN 1 AND 365),
  warn_days       INTEGER NOT NULL DEFAULT 1 CHECK (warn_days BETWEEN 0 AND 30),
  track_stock     INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  std_cost_mu     INTEGER CHECK (std_cost_mu IS NULL OR std_cost_mu >= 0),
  markup_x100     INTEGER CHECK (markup_x100 IS NULL OR markup_x100 BETWEEN 100 AND 2000),
  loose_price_uzs INTEGER CHECK (loose_price_uzs IS NULL OR loose_price_uzs > 0),
  ikpu            TEXT CHECK (ikpu IS NULL OR (length(ikpu) = 17 AND ikpu NOT GLOB '*[^0-9]*')),
  emoji           TEXT CHECK (emoji IS NULL OR length(emoji) <= 8),
  color           TEXT CHECK (color IS NULL OR (length(color) = 7 AND substr(color, 1, 1) = '#' AND lower(substr(color, 2)) NOT GLOB '*[^0-9a-f]*')),
  photo_key       TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version         INTEGER NOT NULL DEFAULT 1,                        -- правка: UPDATE … WHERE version = ?
  demo            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CONSTRAINT stock_items_service CHECK (kind <> 'service' OR (track_stock = 0 AND base_unit = 'pcs'))
);
-- Плитки конструктора: активные позиции по группам в заданном порядке (≤ 300 строк, читается целиком).
CREATE INDEX stock_items_tiles_idx ON stock_items (active, grp, sort_order);

-- Кэш Σ движений по позиции. Ведёт ТОЛЬКО триггер stock_moves_apply (0013); last_cost_mu — проводка прихода.
CREATE TABLE stock_item_balances (
  item_id          TEXT PRIMARY KEY REFERENCES stock_items(id),
  qty              INTEGER NOT NULL DEFAULT 0,      -- < 0 возможно только из-за дефицитных партий
  value_mu         INTEGER NOT NULL DEFAULT 0,
  last_cost_mu     INTEGER,                         -- цена базовой единицы последнего прихода
  last_receipt_on  TEXT,
  updated_at       TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE stock_suppliers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  phone       TEXT,
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  demo        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE stock_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  lines       TEXT NOT NULL CHECK (json_valid(lines) AND json_type(lines) = 'array' AND json_array_length(lines) BETWEEN 1 AND 40),
  price_uzs   INTEGER CHECK (price_uzs IS NULL OR price_uzs > 0),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  demo        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Аудит того, что НЕ является документом склада: карточки, настройки, подтверждения списаний.
CREATE TABLE stock_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,          -- 'stock.item.create', 'stock.item.update', 'stock.config.update', 'stock.approval', 'stock.catalog.seed'
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  details     TEXT CHECK (details IS NULL OR (json_valid(details) AND length(details) <= 4000))
);
CREATE INDEX stock_audit_log_at_idx ON stock_audit_log (at);
CREATE TRIGGER stock_audit_log_no_update BEFORE UPDATE ON stock_audit_log
BEGIN SELECT RAISE(ABORT, 'stock_audit_log: только дополняется'); END;
CREATE TRIGGER stock_audit_log_no_delete BEFORE DELETE ON stock_audit_log
WHEN NOT EXISTS (SELECT 1 FROM maintenance WHERE flag = 'allow_stock_delete')
BEGIN SELECT RAISE(ABORT, 'stock_audit_log: только дополняется'); END;

-- Настройки склада: один JSON (zod StockConfig в Worker'е, умолчания — packages/stock/config.ts).
-- stock_rev / stock_catalog_rev: счётчики для ETag каталога конструктора.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('stock_config', '{}'), ('stock_closed_through', '0000-00-00'), ('stock_rev', '0'), ('stock_catalog_rev', '0');
