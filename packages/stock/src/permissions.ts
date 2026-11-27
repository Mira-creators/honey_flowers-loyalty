/**
 * One permission table for the whole stock module (architecture §8.2, prototype scope).
 * Routes check `can(role, action, config)` after the router-level staff check (deny by default).
 */
import type { StockConfig } from './config.js';

export type StockRole = 'client' | 'florist' | 'manager' | 'owner';

export type StockAction =
  | 'catalog.read'
  | 'catalog.edit'
  | 'receipt.post'
  | 'receipt.backdate'
  | 'receipt.cancel'
  | 'bouquet.assemble'
  | 'bouquet.cancel.own'
  | 'bouquet.cancel.any'
  | 'bouquet.disassemble'
  | 'template.save'
  | 'sale.post'
  | 'writeoff.post'
  | 'writeoff.approve'
  | 'freshness.read'
  | 'lot.priority'
  | 'overview.read'
  | 'reports.read'
  | 'config.edit';

const STAFF: StockRole[] = ['florist', 'manager', 'owner'];
const OWNER: StockRole[] = ['owner'];

const TABLE: Record<Exclude<StockAction, 'receipt.post'>, StockRole[]> = {
  'catalog.read': STAFF,
  'catalog.edit': OWNER,
  'receipt.backdate': OWNER,
  'receipt.cancel': OWNER,
  'bouquet.assemble': STAFF,
  'bouquet.cancel.own': STAFF,
  'bouquet.cancel.any': OWNER,
  'bouquet.disassemble': STAFF,
  'template.save': STAFF,
  'sale.post': STAFF,
  'writeoff.post': STAFF,
  'writeoff.approve': OWNER,
  'freshness.read': STAFF,
  'lot.priority': STAFF,
  'overview.read': OWNER,
  'reports.read': OWNER,
  'config.edit': OWNER,
};

export function can(role: StockRole, action: StockAction, config: Pick<StockConfig, 'receiptRoles'>): boolean {
  if (role === 'client') return false;
  if (action === 'receipt.post') return role === 'owner' || (config.receiptRoles as StockRole[]).includes(role);
  return TABLE[action].includes(role);
}
