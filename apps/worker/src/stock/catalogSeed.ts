/**
 * Starter catalog of a Tashkent flower shop (prototype): roses (Ecuadorian and local), tulips, eustoma,
 * chrysanthemums, alstroemeria, gypsophila, greenery, packaging, cards, delivery as a service.
 * Std costs are rough market prices (сум per base unit) used only until the first receipt.
 * Used by «Заполнить каталог примером» (owner, empty catalog) and by the TEST_MODE demo seed.
 */
import type { StockBaseUnit, StockKind } from '@honey/contracts';

export interface SeedItem {
  sku: string;
  name: string;
  kind: StockKind;
  group: string;
  unit: StockBaseUnit;
  display: string;
  factor?: number;
  pack?: [string, number];
  stdCost: number; // сум per base unit (ribbon: per cm, may be fractional)
  emoji: string;
  color: string;
  track?: boolean;
  loosePrice?: number;
}

export const SEED_ITEMS: SeedItem[] = [
  { sku: 'RN60', name: 'Роза Red Naomi 60 см (Эквадор)', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 25], stdCost: 14_000, emoji: '🌹', color: '#B0123B' },
  { sku: 'EX70', name: 'Роза Explorer 70 см (Эквадор)', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 25], stdCost: 16_000, emoji: '🌹', color: '#8E0E1E' },
  { sku: 'FR50', name: 'Роза Freedom 50 см (Эквадор)', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 25], stdCost: 12_000, emoji: '🌹', color: '#C62828' },
  { sku: 'PB50', name: 'Роза Playa Blanca 50 см (Эквадор)', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 25], stdCost: 12_000, emoji: '🤍', color: '#F3EFE6' },
  { sku: 'LR40', name: 'Роза местная красная 40 см', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 30], stdCost: 6_000, emoji: '🌹', color: '#E53935' },
  { sku: 'LP40', name: 'Роза местная розовая 40 см', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 30], stdCost: 6_000, emoji: '🌸', color: '#F48FB1' },
  { sku: 'LYD', name: 'Роза кустовая Lydia', kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 9_000, emoji: '🌸', color: '#F8BBD0' },
  { sku: 'POH', name: "Роза пионовидная Pink O'Hara", kind: 'flower', group: 'Розы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 25_000, emoji: '🌺', color: '#EC8FA8' },
  { sku: 'TLR', name: 'Тюльпан красный', kind: 'flower', group: 'Тюльпаны', unit: 'stem', display: 'шт', pack: ['пачка', 50], stdCost: 7_000, emoji: '🌷', color: '#E53935' },
  { sku: 'TLY', name: 'Тюльпан жёлтый', kind: 'flower', group: 'Тюльпаны', unit: 'stem', display: 'шт', pack: ['пачка', 50], stdCost: 7_000, emoji: '🌷', color: '#FBC02D' },
  { sku: 'TLW', name: 'Тюльпан белый', kind: 'flower', group: 'Тюльпаны', unit: 'stem', display: 'шт', pack: ['пачка', 50], stdCost: 7_500, emoji: '🌷', color: '#EDE7DA' },
  { sku: 'EUW', name: 'Эустома белая', kind: 'flower', group: 'Эустома', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 15_000, emoji: '🤍', color: '#F5F2EA' },
  { sku: 'EUL', name: 'Эустома сиреневая', kind: 'flower', group: 'Эустома', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 15_000, emoji: '💜', color: '#9575CD' },
  { sku: 'CHB', name: 'Хризантема кустовая Бакарди', kind: 'flower', group: 'Хризантемы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 12_000, emoji: '🌼', color: '#F0F4C3' },
  { sku: 'CHA', name: 'Хризантема одноголовая Антонов', kind: 'flower', group: 'Хризантемы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 14_000, emoji: '🌼', color: '#FFF59D' },
  { sku: 'ALS', name: 'Альстромерия', kind: 'flower', group: 'Другие цветы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 8_000, emoji: '🌺', color: '#FF8A65' },
  { sku: 'GYP', name: 'Гипсофила', kind: 'flower', group: 'Другие цветы', unit: 'stem', display: 'ветка', pack: ['пачка', 10], stdCost: 10_000, emoji: '☁️', color: '#ECEFF1' },
  { sku: 'CAR', name: 'Гвоздика', kind: 'flower', group: 'Другие цветы', unit: 'stem', display: 'шт', pack: ['пачка', 25], stdCost: 5_000, emoji: '🌸', color: '#EC407A' },
  { sku: 'PEO', name: 'Пион Сара Бернар (сезон)', kind: 'flower', group: 'Другие цветы', unit: 'stem', display: 'шт', pack: ['пачка', 10], stdCost: 35_000, emoji: '🌸', color: '#F6A5C0' },
  { sku: 'EUC', name: 'Эвкалипт Цинерея', kind: 'greenery', group: 'Зелень', unit: 'stem', display: 'ветка', pack: ['пачка', 10], stdCost: 6_000, emoji: '🌿', color: '#90A4AE' },
  { sku: 'PIS', name: 'Фисташка', kind: 'greenery', group: 'Зелень', unit: 'stem', display: 'ветка', pack: ['пачка', 10], stdCost: 4_000, emoji: '🌿', color: '#558B2F' },
  { sku: 'RUS', name: 'Рускус', kind: 'greenery', group: 'Зелень', unit: 'stem', display: 'ветка', pack: ['пачка', 10], stdCost: 3_500, emoji: '🍃', color: '#2E7D32' },
  { sku: 'SAL', name: 'Салал', kind: 'greenery', group: 'Зелень', unit: 'stem', display: 'ветка', pack: ['пачка', 10], stdCost: 3_000, emoji: '🍃', color: '#33691E' },
  { sku: 'KRF', name: 'Бумага крафт', kind: 'supply', group: 'Упаковка', unit: 'sheet', display: 'лист', pack: ['рулон', 50], stdCost: 4_000, emoji: '📜', color: '#A1887F' },
  { sku: 'MAT', name: 'Бумага корейская матовая', kind: 'supply', group: 'Упаковка', unit: 'sheet', display: 'лист', pack: ['упаковка', 20], stdCost: 6_000, emoji: '📄', color: '#F8BBD0' },
  { sku: 'RIB', name: 'Лента атласная 2,5 см', kind: 'supply', group: 'Упаковка', unit: 'cm', display: 'м', factor: 100, pack: ['бобина', 2500], stdCost: 4.8, emoji: '🎀', color: '#E57373' },
  { sku: 'BOX', name: 'Коробка шляпная', kind: 'supply', group: 'Упаковка', unit: 'pcs', display: 'шт', pack: ['упаковка', 10], stdCost: 35_000, emoji: '🎁', color: '#D7CCC8' },
  { sku: 'OAS', name: 'Флористическая губка', kind: 'supply', group: 'Упаковка', unit: 'pcs', display: 'шт', pack: ['упаковка', 20], stdCost: 8_000, emoji: '🧽', color: '#66BB6A' },
  { sku: 'CRD', name: 'Открытка', kind: 'supply', group: 'Открытки', unit: 'pcs', display: 'шт', pack: ['упаковка', 50], stdCost: 5_000, emoji: '✉️', color: '#FFE0B2', loosePrice: 15_000 },
  { sku: 'TAP', name: 'Тейп-лента (без учёта)', kind: 'supply', group: 'Упаковка', unit: 'pcs', display: 'шт', stdCost: 300, emoji: '🩹', color: '#BDBDBD', track: false },
  { sku: 'DLV', name: 'Доставка по Ташкенту', kind: 'service', group: 'Услуги', unit: 'pcs', display: 'шт', stdCost: 0, emoji: '🚚', color: '#90CAF9', track: false, loosePrice: 30_000 },
];

export const SEED_TEMPLATES: Array<{ name: string; lines: Array<[string, number]>; price?: number }> = [
  { name: '15 роз Red Naomi в крафте', lines: [['RN60', 15], ['EUC', 3], ['KRF', 2], ['RIB', 80]] },
  { name: '25 тюльпанов микс', lines: [['TLR', 9], ['TLY', 8], ['TLW', 8], ['MAT', 3], ['RIB', 60]] },
  { name: 'Эустома с эвкалиптом', lines: [['EUW', 7], ['EUC', 4], ['GYP', 2], ['MAT', 2], ['RIB', 60]] },
];
