/**
 * Migrations 0012–0014 («Склад») apply on a fresh database (test/setup.ts does that for DB) AND on a
 * database already at 0010 with loyalty data: nothing is lost, the stock schema works on top.
 */
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

type Migrations = Parameters<typeof applyD1Migrations>[1];
const e = env as unknown as { DB_MIGRATE: D1Database; TEST_MIGRATIONS: Migrations };

describe('stock migrations', () => {
  it('apply on top of a 0010 database with data', async () => {
    const db = e.DB_MIGRATE;
    const all = e.TEST_MIGRATIONS;
    const upTo10 = all.filter((m) => m.name.slice(0, 4) <= '0010');
    expect(upTo10.length).toBe(10);
    await applyD1Migrations(db, upTo10);
    const now = '2026-11-01T10:00:00.000Z';
    await db.batch([
      db.prepare(`INSERT INTO clients (id, telegram_id, code, phone, name, language, created_at) VALUES ('c1', 1001, 'HF1001', '+998901112233', 'Мадина', 'ru', ?)`).bind(now),
      db.prepare(`INSERT INTO staff (id, telegram_id, name, role, active, created_at) VALUES ('s1', 2001, 'Дилноза', 'florist', 1, ?)`).bind(now),
    ]);
    await applyD1Migrations(db, all);
    const names = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'stock_%' ORDER BY name`).all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['stock_items', 'stock_item_balances', 'stock_suppliers', 'stock_templates', 'stock_audit_log', 'stock_docs', 'stock_doc_lines', 'stock_lots', 'stock_moves', 'stock_daily', 'stock_bouquets', 'stock_sales', 'stock_sale_lines']));
    expect((await db.prepare(`SELECT name FROM clients WHERE id = 'c1'`).first<{ name: string }>())!.name).toBe('Мадина');
    expect((await db.prepare(`SELECT value FROM settings WHERE key = 'stock_rev'`).first<{ value: string }>())!.value).toBe('0');
    // the ledger works on the migrated database: receipt → lot → move → caches
    await db.batch([
      db.prepare(`INSERT INTO stock_items (id, sku, name, kind, grp, base_unit, display_unit, created_at, updated_at) VALUES ('i1', 'RN60', 'Роза', 'flower', 'Розы', 'stem', 'шт', ?, ?)`).bind(now, now),
      db.prepare(`INSERT INTO stock_docs (id, kind, number, status, doc_date, idempotency_key, payload_hash, actor_id, actor_role, created_at) VALUES ('d1', 'receipt', 1, 'posted', '2026-11-01', 'k1', 'h', 's1', 'owner', ?)`).bind(now),
      db.prepare(`INSERT INTO stock_lots (id, item_id, receipt_doc_id, received_at, qty_received, unit_cost_mu, created_at) VALUES ('l1', 'i1', 'd1', ?, 25, 12000000, ?)`).bind(now, now),
      db.prepare(`INSERT INTO stock_moves (doc_id, line_no, item_id, lot_id, qty, value_mu, reason, doc_date, actor_id, created_at) VALUES ('d1', 1, 'i1', 'l1', 25, 300000000, 'receipt', '2026-11-01', 's1', ?)`).bind(now),
    ]);
    expect(await db.prepare(`SELECT qty, value_mu FROM stock_item_balances WHERE item_id = 'i1'`).first()).toEqual({ qty: 25, value_mu: 300_000_000 });
    await expect(db.prepare(`INSERT INTO stock_moves (doc_id, line_no, item_id, lot_id, qty, value_mu, reason, doc_date, actor_id, created_at) VALUES ('d1', 1, 'i1', 'l1', -26, -312000000, 'assembly', '2026-11-01', 's1', ?)`).bind(now).run()).rejects.toThrow(/stock_lots_bounds/);
    // re-applying is a no-op
    await applyD1Migrations(db, all);
  });
});
