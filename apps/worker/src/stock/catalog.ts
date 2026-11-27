/**
 * M1 Catalog: items + balances + FIFO ladder for the builder (ETag = stock_rev.catalog_rev.today),
 * item create/edit (owner, optimistic `version`), suppliers, templates, the starter catalog seed.
 */
import type { StockCatalogDTO, StockItemDTO, StockItemInput, StockSupplierDTO, StockTemplateDTO } from '@honey/contracts';
import { addDays, freshnessOf, lifeDefaultsFor, type StockConfig } from '@honey/stock';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import { SEED_ITEMS, SEED_TEMPLATES } from './catalogSeed.js';
import { configStmt, num, numOrNull, publicConfigDTO, revStmt, settingsFrom, strOrNull, todayOf, type Actor, type Row } from './core.js';

/** Open lots per item sent to the phone for the cost preview (picking order). */
export const LADDER_LOTS = 6;

export function itemDTO(r: Row, ladder: StockItemDTO['ladder'] = [], uses30d = 0, available?: number): StockItemDTO {
  return {
    id: String(r.id),
    sku: String(r.sku),
    name: String(r.name),
    kind: r.kind as StockItemDTO['kind'],
    group: String(r.grp ?? ''),
    unit: {
      base: r.base_unit as StockItemDTO['unit']['base'],
      display: String(r.display_unit),
      factor: num(r.display_factor) || 1,
      pack: r.pack_size ? { name: String(r.pack_name ?? 'пачка'), size: num(r.pack_size) } : null,
    },
    emoji: strOrNull(r.emoji),
    color: strOrNull(r.color),
    trackStock: num(r.track_stock) === 1,
    active: num(r.active) === 1,
    qty: num(r.qty),
    // what can be picked without going «в минус»: Σ positive lots (the balance also counts a negative deficit lot)
    available: available ?? Math.max(0, num(r.qty)),
    valueMu: num(r.value_mu),
    ladder,
    lastCostMu: numOrNull(r.last_cost_mu),
    stdCostMu: numOrNull(r.std_cost_mu),
    markupX100: numOrNull(r.markup_x100),
    vaseLifeDays: numOrNull(r.vase_life_days),
    sellDays: numOrNull(r.sell_days),
    warnDays: num(r.warn_days),
    ikpu: strOrNull(r.ikpu),
    version: num(r.version),
    uses30d,
  };
}

export const ITEM_COLUMNS = `i.id, i.sku, i.name, i.kind, i.grp, i.base_unit, i.display_unit, i.display_factor, i.pack_name, i.pack_size, i.vase_life_days,
  i.sell_days, i.warn_days, i.track_stock, i.std_cost_mu, i.markup_x100, i.loose_price_uzs, i.ikpu, i.emoji, i.color, i.sort_order, i.active, i.version,
  COALESCE(b.qty, 0) AS qty, COALESCE(b.value_mu, 0) AS value_mu, b.last_cost_mu`;

/**
 * GET /api/stock/catalog. Round trip 1: the revision counters (+ config). If the ETag matches → 304
 * (≈ 4 rows read). Otherwise round trip 2: items with balances, open lots (partial pick index),
 * 30-day usage from stock_daily (one batch).
 */
export async function getCatalog(app: AppContext, ifNoneMatch: string | null): Promise<{ etag: string; body: StockCatalogDTO | null }> {
  const db = app.repo.db;
  const today = todayOf(app);
  const s = settingsFrom((await configStmt(db).all<Row>()).results);
  const etag = `W/"${s.rev}.${s.catalogRev}.${today}"`;
  if (ifNoneMatch && ifNoneMatch === etag) return { etag, body: null };
  // 30-day usage («most used first») reads ~30 days × active items of stock_daily: computed once a day
  // and cached in settings (stock_uses), so a cold catalog stays within the ≤ 1 000 rows budget.
  const cachedUses = s.uses && s.uses.day === today ? s.uses.n : null;
  const [items, lots, uses] = await db.batch<Row>([
    db.prepare(`SELECT ${ITEM_COLUMNS} FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id ORDER BY i.active DESC, i.grp, i.sort_order, i.name`),
    db.prepare(
      `SELECT id, item_id, qty_on_hand, unit_cost_mu, sell_by, received_at FROM stock_lots WHERE qty_on_hand > 0
        ORDER BY item_id, priority DESC, expires_on, received_at, id`,
    ),
    cachedUses
      ? db.prepare('SELECT 1 AS none WHERE 0')
      : db.prepare(`SELECT item_id, SUM(n) AS n FROM stock_daily WHERE day >= ? AND day < ? AND reason = 'assembly' GROUP BY item_id`).bind(addDays(today, -30), today),
  ]);
  const usageRows: Record<string, number> = cachedUses ?? Object.fromEntries(uses!.results.map((u) => [String(u.item_id), num(u.n)]));
  if (!cachedUses) {
    await db.prepare(`INSERT INTO settings (key, value) VALUES ('stock_uses', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify({ day: today, n: usageRows })).run();
  }
  const warn = new Map(items!.results.map((r) => [String(r.id), num(r.warn_days)]));
  const ladders = new Map<string, StockItemDTO['ladder']>();
  const avail = new Map<string, number>();
  for (const l of lots!.results) {
    const id = String(l.item_id);
    avail.set(id, (avail.get(id) ?? 0) + num(l.qty_on_hand));
    const arr = ladders.get(id) ?? [];
    if (arr.length < LADDER_LOTS) {
      arr.push({
        lotId: String(l.id),
        qty: num(l.qty_on_hand),
        unitCostMu: num(l.unit_cost_mu),
        freshness: freshnessOf(strOrNull(l.sell_by), warn.get(id) ?? 1, today),
        receivedOn: String(l.received_at).slice(0, 10),
      });
    }
    ladders.set(id, arr);
  }
  const usage = new Map(Object.entries(usageRows));
  const body: StockCatalogDTO = {
    rev: etag,
    today,
    items: items!.results.map((r) => itemDTO(r, ladders.get(String(r.id)) ?? [], usage.get(String(r.id)) ?? 0, avail.get(String(r.id)) ?? 0)),
    config: publicConfigDTO(s.config),
  };
  return { etag, body };
}

// ------------------------------------------------------------------ items (owner)

const txt = (max: number) => z.string().trim().min(1).max(max);
export const itemSchema = z
  .object({
    sku: z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/, 'код: латиница, цифры, - _'),
    name: txt(80),
    kind: z.enum(['flower', 'greenery', 'supply', 'service']),
    group: z.string().trim().max(40).default(''),
    baseUnit: z.enum(['stem', 'pcs', 'cm', 'sheet', 'g']),
    displayUnit: txt(12),
    displayFactor: z.number().int().min(1).max(1000).default(1),
    packName: z.string().trim().max(20).nullish(),
    packSize: z.number().int().min(1).max(100_000).nullish(),
    vaseLifeDays: z.number().int().min(1).max(365).nullish(),
    sellDays: z.number().int().min(1).max(365).nullish(),
    warnDays: z.number().int().min(0).max(30).optional(),
    trackStock: z.boolean().default(true),
    stdCost: z.number().min(0).max(100_000_000).nullish(),
    markupX100: z.number().int().min(100).max(2000).nullish(),
    loosePrice: z.number().int().positive().max(100_000_000).nullish(),
    ikpu: z.string().regex(/^\d{17}$/, 'ИКПУ — 17 цифр').nullish(),
    emoji: z.string().max(8).nullish(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullish(),
    sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
    active: z.boolean().default(true),
    version: z.number().int().min(1).optional(),
  })
  .transform((v) => (v.kind === 'service' ? { ...v, trackStock: false, baseUnit: 'pcs' as const } : v));

function itemValues(v: z.infer<typeof itemSchema>, cfg: StockConfig) {
  const life = lifeDefaultsFor(cfg, v.kind, v.group);
  return {
    vase: v.vaseLifeDays === undefined ? life.vaseLifeDays : v.vaseLifeDays,
    sell: v.sellDays === undefined ? life.sellDays : v.sellDays,
    warn: v.warnDays ?? life.warnDays,
    std: v.stdCost === undefined || v.stdCost === null ? null : Math.round(v.stdCost * 1000),
  };
}

function uniqueSkuError(e: unknown): never {
  if (String((e as Error)?.message).includes('stock_items.sku')) throw new HttpError(409, 'conflict', 'Позиция с таким кодом уже есть');
  throw e;
}

export async function createItem(app: AppContext, actor: Actor, input: StockItemInput, cfg: StockConfig): Promise<StockItemDTO> {
  const v = itemSchema.parse(input);
  const x = itemValues(v, cfg);
  const id = crypto.randomUUID();
  const now = app.now().toISOString();
  const db = app.repo.db;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO stock_items (id, sku, name, kind, grp, base_unit, display_unit, display_factor, pack_name, pack_size, vase_life_days, sell_days,
             warn_days, track_stock, std_cost_mu, markup_x100, loose_price_uzs, ikpu, emoji, color, sort_order, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, v.sku, v.name, v.kind, v.group, v.baseUnit, v.displayUnit, v.displayFactor, v.packSize ? (v.packName || 'пачка') : null, v.packSize ?? null,
          x.vase, x.sell, x.warn, v.trackStock ? 1 : 0, x.std, v.markupX100 ?? null, v.loosePrice ?? null, v.ikpu ?? null, v.emoji ?? null, v.color ?? null,
          v.sortOrder, v.active ? 1 : 0, now, now),
      auditStmt(app, actor, 'stock.item.create', 'stock_items', id, { sku: v.sku, name: v.name }),
      revStmt(db, 'stock_catalog_rev'),
    ]);
  } catch (e) {
    uniqueSkuError(e);
  }
  return (await getItem(app, id))!;
}

export async function updateItem(app: AppContext, actor: Actor, id: string, input: StockItemInput, cfg: StockConfig): Promise<StockItemDTO> {
  const v = itemSchema.parse(input);
  if (!v.version) throw new HttpError(400, 'validation', 'Неверные данные: version: укажите версию карточки');
  const before = await getItem(app, id);
  if (!before) throw new HttpError(404, 'not_found', 'Позиция не найдена');
  if (before.kind !== v.kind && (before.qty !== 0 || before.ladder.length)) throw new HttpError(409, 'conflict', 'Вид позиции с остатком менять нельзя');
  if (before.trackStock && !v.trackStock && before.qty !== 0) throw new HttpError(409, 'conflict', 'Сначала спишите остаток, потом отключайте учёт');
  const x = itemValues(v, cfg);
  const db = app.repo.db;
  const now = app.now().toISOString();
  let changes = 0;
  try {
    const [r] = await db.batch([
      db
        .prepare(
          `UPDATE stock_items SET sku = ?, name = ?, kind = ?, grp = ?, base_unit = ?, display_unit = ?, display_factor = ?, pack_name = ?, pack_size = ?,
             vase_life_days = ?, sell_days = ?, warn_days = ?, track_stock = ?, std_cost_mu = ?, markup_x100 = ?, loose_price_uzs = ?, ikpu = ?, emoji = ?,
             color = ?, sort_order = ?, active = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(v.sku, v.name, v.kind, v.group, v.baseUnit, v.displayUnit, v.displayFactor, v.packSize ? (v.packName || 'пачка') : null, v.packSize ?? null,
          x.vase, x.sell, x.warn, v.trackStock ? 1 : 0, x.std, v.markupX100 ?? null, v.loosePrice ?? null, v.ikpu ?? null, v.emoji ?? null, v.color ?? null,
          v.sortOrder, v.active ? 1 : 0, now, id, v.version),
    ]);
    changes = r?.meta.changes ?? 0;
  } catch (e) {
    uniqueSkuError(e);
  }
  if (!changes) throw new HttpError(409, 'conflict', 'Карточку уже изменили — обновите экран и повторите');
  await db.batch([auditStmt(app, actor, 'stock.item.update', 'stock_items', id, { before: { name: before.name, version: before.version }, after: { name: v.name } }), revStmt(db, 'stock_catalog_rev')]);
  return (await getItem(app, id))!;
}

export async function getItem(app: AppContext, id: string): Promise<StockItemDTO | null> {
  const db = app.repo.db;
  const [it, lots] = await db.batch<Row>([
    db.prepare(`SELECT ${ITEM_COLUMNS} FROM stock_items i LEFT JOIN stock_item_balances b ON b.item_id = i.id WHERE i.id = ?`).bind(id),
    db.prepare(`SELECT id, qty_on_hand, unit_cost_mu, sell_by, received_at FROM stock_lots WHERE item_id = ? AND qty_on_hand > 0 ORDER BY priority DESC, expires_on, received_at, id LIMIT ?`).bind(id, LADDER_LOTS),
  ]);
  const r = it!.results[0];
  if (!r) return null;
  const today = todayOf(app);
  return itemDTO(r, lots!.results.map((l) => ({ lotId: String(l.id), qty: num(l.qty_on_hand), unitCostMu: num(l.unit_cost_mu), freshness: freshnessOf(strOrNull(l.sell_by), num(r.warn_days), today), receivedOn: String(l.received_at).slice(0, 10) })));
}

export function auditStmt(app: AppContext, actor: Actor, action: string, entity: string, entityId: string | null, details: unknown): D1PreparedStatement {
  return app.repo.db
    .prepare('INSERT INTO stock_audit_log (at, actor_id, actor_role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(app.now().toISOString(), actor.id, actor.role, action, entity, entityId, details === undefined ? null : JSON.stringify(details).slice(0, 4000));
}

/**
 * Starter catalog (+ 3 templates). INSERT OR IGNORE by sku: running it twice changes nothing; items
 * that already exist (same sku) are kept as they are. `demo` marks rows the TEST_MODE demo clear removes.
 */
export async function seedCatalog(app: AppContext, actor: Actor | null, cfg: StockConfig, demo = false): Promise<{ items: number; templates: number }> {
  const db = app.repo.db;
  const now = app.now().toISOString();
  const rows = SEED_ITEMS.map((s, k) => {
    const life = lifeDefaultsFor(cfg, s.kind, s.group);
    return {
      id: crypto.randomUUID(), sku: s.sku, name: s.name, kind: s.kind, grp: s.group, unit: s.unit, disp: s.display, factor: s.factor ?? 1,
      pn: s.pack?.[0] ?? null, ps: s.pack?.[1] ?? null, vase: s.kind === 'supply' || s.kind === 'service' ? null : life.vaseLifeDays,
      sell: s.kind === 'supply' || s.kind === 'service' ? null : life.sellDays, warn: life.warnDays, track: s.track === false ? 0 : 1,
      std: Math.round(s.stdCost * 1000), loose: s.loosePrice ?? null, emoji: s.emoji, color: s.color, sort: k * 10,
    };
  });
  const before = num((await db.prepare('SELECT COUNT(*) AS n FROM stock_items').all<Row>()).results[0]?.n);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO stock_items (id, sku, name, kind, grp, base_unit, display_unit, display_factor, pack_name, pack_size, vase_life_days, sell_days,
           warn_days, track_stock, std_cost_mu, loose_price_uzs, emoji, color, sort_order, active, demo, created_at, updated_at)
         SELECT json_extract(value,'$.id'), json_extract(value,'$.sku'), json_extract(value,'$.name'), json_extract(value,'$.kind'), json_extract(value,'$.grp'),
                json_extract(value,'$.unit'), json_extract(value,'$.disp'), json_extract(value,'$.factor'), json_extract(value,'$.pn'), json_extract(value,'$.ps'),
                json_extract(value,'$.vase'), json_extract(value,'$.sell'), json_extract(value,'$.warn'), json_extract(value,'$.track'), json_extract(value,'$.std'),
                json_extract(value,'$.loose'), json_extract(value,'$.emoji'), json_extract(value,'$.color'), json_extract(value,'$.sort'), 1, ?1, ?2, ?2
           FROM json_each(?3)`,
      )
      .bind(demo ? 1 : 0, now, JSON.stringify(rows)),
  ];
  const tpl = SEED_TEMPLATES.map((t, k) => ({ id: crypto.randomUUID(), name: t.name, skus: t.lines, sort: k * 10 }));
  // Templates reference items by id: resolved by sku inside SQL, only when no template with this name exists.
  for (const t of tpl) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO stock_templates (id, name, lines, active, sort_order, created_by, demo, created_at, updated_at)
           SELECT ?1, ?2, (SELECT json_group_array(json_object('itemId', i.id, 'qty', json_extract(l.value, '$[1]')))
                             FROM json_each(?3) l JOIN stock_items i ON i.sku = json_extract(l.value, '$[0]')), 1, ?4, ?5, ?6, ?7, ?7
            WHERE NOT EXISTS (SELECT 1 FROM stock_templates WHERE name = ?2)
              AND (SELECT COUNT(*) FROM json_each(?3) l JOIN stock_items i ON i.sku = json_extract(l.value, '$[0]')) > 0`,
        )
        .bind(t.id, t.name, JSON.stringify(t.skus), t.sort, actor?.id ?? 'system', demo ? 1 : 0, now),
    );
  }
  if (actor) stmts.push(auditStmt(app, actor, 'stock.catalog.seed', 'stock_items', null, { items: rows.length }));
  stmts.push(revStmt(db, 'stock_catalog_rev'));
  await db.batch(stmts);
  const after = num((await db.prepare('SELECT COUNT(*) AS n FROM stock_items').all<Row>()).results[0]?.n);
  return { items: after - before, templates: tpl.length };
}

// ------------------------------------------------------------------ suppliers, templates

export async function listSuppliers(app: AppContext): Promise<StockSupplierDTO[]> {
  const { results } = await app.repo.db.prepare('SELECT id, name, phone FROM stock_suppliers WHERE active = 1 ORDER BY name LIMIT 200').all<Row>();
  return results.map((r) => ({ id: String(r.id), name: String(r.name), phone: strOrNull(r.phone) }));
}

export const supplierSchema = z.object({ name: txt(80), phone: z.string().trim().max(20).nullish(), note: z.string().trim().max(500).nullish() });

export async function createSupplier(app: AppContext, input: unknown, demo = false): Promise<StockSupplierDTO> {
  const v = supplierSchema.parse(input);
  const id = crypto.randomUUID();
  await app.repo.db
    .prepare('INSERT INTO stock_suppliers (id, name, phone, note, demo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, v.name, v.phone ?? null, v.note ?? null, demo ? 1 : 0, app.now().toISOString())
    .run();
  return { id, name: v.name, phone: v.phone ?? null };
}

export async function listTemplates(app: AppContext): Promise<StockTemplateDTO[]> {
  const { results } = await app.repo.db.prepare('SELECT id, name, lines, price_uzs FROM stock_templates WHERE active = 1 ORDER BY sort_order, name LIMIT 100').all<Row>();
  return results.map((r) => ({ id: String(r.id), name: String(r.name), lines: JSON.parse(String(r.lines)) as StockTemplateDTO['lines'], price: numOrNull(r.price_uzs) }));
}

export const templateSchema = z.object({
  name: txt(60),
  lines: z.array(z.object({ itemId: z.string().min(1).max(64), qty: z.number().int().min(1).max(10_000) })).min(1).max(40),
  price: z.number().int().positive().max(100_000_000).nullish(),
});

export async function saveTemplate(app: AppContext, actor: Actor, input: unknown): Promise<StockTemplateDTO> {
  const v = templateSchema.parse(input);
  const ids = [...new Set(v.lines.map((l) => l.itemId))];
  if (ids.length !== v.lines.length) throw new HttpError(400, 'validation', 'Позиция в шаблоне повторяется');
  const { results } = await app.repo.db.prepare(`SELECT id FROM stock_items WHERE kind <> 'service' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Row>();
  if (results.length !== ids.length) throw new HttpError(400, 'validation', 'В шаблоне есть неизвестная позиция');
  const id = crypto.randomUUID();
  const now = app.now().toISOString();
  await app.repo.db
    .prepare('INSERT INTO stock_templates (id, name, lines, price_uzs, active, sort_order, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 100, ?, ?, ?)')
    .bind(id, v.name, JSON.stringify(v.lines), v.price ?? null, actor.id, now, now)
    .run();
  return { id, name: v.name, lines: v.lines, price: v.price ?? null };
}

