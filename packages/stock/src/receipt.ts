/**
 * Receipt (приход) costing, architecture §2.3 and §4.7.
 *
 * One currency per receipt (сум or доллар + rate). Two price modes:
 *  - `lines`: every line has a price per base unit, per pack or for the whole line;
 *  - `total`: one sum for the whole delivery; it is split over the lines proportionally to the
 *    reference price of each item (last purchase price → std cost → 1 per unit), lines with a
 *    manual price keep it and only the REST is redistributed. Largest remainder: Σ = total exactly.
 * Extra costs (delivery, customs, сум) are spread over the lines by line value (largest remainder).
 * Result per line: the cost of one base unit with extra costs, in milli-сум, + the rounding residue.
 *
 * Money in input is "minor units" of the receipt currency: сум for UZS, cents for USD.
 * fxRateX100 = сум for 1 USD × 100 (12 850,50 → 1 285 050).
 */
import { largestRemainder } from './allocate.js';
import { divRound, MAX_LINE_QTY, MAX_UNIT_COST_MU, MAX_VALUE_MU, MU_PER_UZS } from './money.js';
import type { Currency, StockKind } from './types.js';

export interface ReceiptItemInfo {
  id: string;
  name: string;
  kind: StockKind;
  packSize: number | null;
  trackStock: boolean;
  /** Last receipt cost of one base unit (reference price), mu. */
  lastCostMu: number | null;
  stdCostMu: number | null;
}

export interface ReceiptLineInput {
  itemId: string;
  qty: number;
  unit: 'base' | 'pack';
  /** Minor units of the receipt currency. In `total` mode: only a manual override of this line. */
  price?: number | null;
  per?: 'unit' | 'pack' | 'line';
}

export interface ReceiptInput {
  currency: Currency;
  fxRateX100: number | null;
  priceMode: 'lines' | 'total';
  /** `total` mode: the whole delivery in minor units of the currency. */
  total?: number | null;
  extraCostUzs: number;
  lines: ReceiptLineInput[];
}

export interface ReceiptLineResult {
  lineNo: number;
  itemId: string;
  qtyBase: number;
  inputQty: number;
  inputUnit: 'base' | 'pack';
  inputPrice: number | null;
  per: 'unit' | 'pack' | 'line' | null;
  manual: boolean;
  refCostMu: number | null;
  /** Value of the line before extra costs, mu. */
  valueMu: bigint;
  landedMu: bigint;
  unitCostMu: number;
  /** valueMu + landedMu − unitCostMu × qtyBase (|x| ≤ qtyBase / 2 mu). */
  roundingMu: number;
  /** Unit price in the receipt currency × 100 (audit): сум×100 or cents×100 per base unit. */
  priceCurX100: number;
}

export interface ReceiptWarning {
  code: 'price_jump' | 'fx_range' | 'big_line' | 'backdate';
  lineNo?: number;
  message: string;
}

export interface ReceiptResult {
  lines: ReceiptLineResult[];
  /** Σ line values (without extra), mu. */
  goodsMu: bigint;
  extraMu: bigint;
  /** In the receipt currency (minor units): what the lines add up to before extra costs. */
  goodsMinor: bigint;
  warnings: ReceiptWarning[];
}

export class ReceiptError extends Error {
  constructor(
    readonly code: 'validation' | 'receipt_total_short',
    message: string,
  ) {
    super(message);
  }
}

/** mu per one minor unit of the currency, as a fraction num/den. */
function minorToMu(currency: Currency, fxRateX100: number | null): { num: bigint; den: bigint } {
  if (currency === 'UZS') return { num: MU_PER_UZS, den: 1n };
  if (!fxRateX100 || fxRateX100 <= 0) throw new ReceiptError('validation', 'Укажите курс доллара');
  // 1 cent = fx/100 сум / 100 = fx_x100 / 10 000 сум = fx_x100 / 10 mu
  return { num: BigInt(fxRateX100), den: 10n };
}

const fmtNum = (n: number) => Math.round(n).toLocaleString('ru-RU');

export function computeReceipt(input: ReceiptInput, items: ReadonlyMap<string, ReceiptItemInfo>): ReceiptResult {
  if (!input.lines.length) throw new ReceiptError('validation', 'В приходе нет строк');
  const conv = minorToMu(input.currency, input.fxRateX100);
  const warnings: ReceiptWarning[] = [];
  const seen = new Set<string>();

  type Draft = Omit<ReceiptLineResult, 'landedMu' | 'unitCostMu' | 'roundingMu' | 'priceCurX100'> & { item: ReceiptItemInfo; minor: bigint | null };
  const drafts: Draft[] = input.lines.map((l, i) => {
    const lineNo = i + 1;
    const item = items.get(l.itemId);
    if (!item) throw new ReceiptError('validation', `Строка ${lineNo}: позиция не найдена`);
    if (!item.trackStock) throw new ReceiptError('validation', `Строка ${lineNo}: «${item.name}» не учитывается на складе — приход не нужен`);
    if (seen.has(l.itemId)) throw new ReceiptError('validation', `Строка ${lineNo}: «${item.name}» уже есть в приходе — объедините строки`);
    seen.add(l.itemId);
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw new ReceiptError('validation', `Строка ${lineNo}: количество должно быть целым больше 0`);
    if (l.unit === 'pack' && !item.packSize) throw new ReceiptError('validation', `Строка ${lineNo}: у «${item.name}» не задан размер пачки`);
    const qtyBase = l.unit === 'pack' ? l.qty * item.packSize! : l.qty;
    if (qtyBase > MAX_LINE_QTY) throw new ReceiptError('validation', `Строка ${lineNo}: слишком большое количество`);
    const hasPrice = l.price !== undefined && l.price !== null;
    if (input.priceMode === 'lines' && !hasPrice) throw new ReceiptError('validation', `Строка ${lineNo}: укажите цену`);
    const per = hasPrice ? (l.per ?? 'unit') : null;
    if (per === 'pack' && !item.packSize) throw new ReceiptError('validation', `Строка ${lineNo}: у «${item.name}» не задан размер пачки`);
    let valueMu = 0n;
    let minor: bigint | null = null;
    if (hasPrice) {
      const p = l.price!;
      if (!Number.isSafeInteger(p) || p < 0) throw new ReceiptError('validation', `Строка ${lineNo}: цена должна быть целым числом ≥ 0`);
      // value = price × (qty_base / divisor) converted to mu, ONE rounding at the end.
      const factor = per === 'line' ? 1n : BigInt(qtyBase);
      const divisor = per === 'pack' ? BigInt(item.packSize!) : 1n;
      valueMu = divRound(BigInt(p) * factor * conv.num, divisor * conv.den);
      minor = per === 'line' ? BigInt(p) : divRound(BigInt(p) * factor, divisor);
    }
    const refCostMu = item.lastCostMu ?? item.stdCostMu ?? null;
    if (qtyBase > 5_000 && (item.kind === 'flower' || item.kind === 'greenery')) {
      warnings.push({ code: 'big_line', lineNo, message: `Строка ${lineNo}: ${fmtNum(qtyBase)} шт. «${item.name}» — проверьте количество` });
    }
    return {
      lineNo, itemId: l.itemId, qtyBase, inputQty: l.qty, inputUnit: l.unit, inputPrice: hasPrice ? l.price! : null, per,
      manual: input.priceMode === 'total' && hasPrice, refCostMu, valueMu, item, minor,
    };
  });

  if (input.priceMode === 'total') {
    if (input.total === undefined || input.total === null || !Number.isSafeInteger(input.total) || input.total < 0) {
      throw new ReceiptError('validation', 'Укажите сумму поставки');
    }
    const totalMu = divRound(BigInt(input.total) * conv.num, conv.den);
    const fixed = drafts.filter((d) => d.manual).reduce((a, d) => a + d.valueMu, 0n);
    if (fixed > totalMu) {
      throw new ReceiptError('receipt_total_short', 'Сумма строк с ручной ценой больше суммы поставки — проверьте цены или общую сумму');
    }
    const auto = drafts.filter((d) => !d.manual);
    if (!auto.length && fixed !== totalMu) {
      throw new ReceiptError('receipt_total_short', 'У всех строк цена задана вручную, но их сумма не равна сумме поставки');
    }
    const parts = largestRemainder(totalMu - fixed, auto.map((d) => BigInt(d.qtyBase) * BigInt(d.refCostMu && d.refCostMu > 0 ? d.refCostMu : 1)));
    auto.forEach((d, k) => {
      d.valueMu = parts[k]!;
    });
  }

  const goodsMu = drafts.reduce((a, d) => a + d.valueMu, 0n);
  if (goodsMu > MAX_VALUE_MU) throw new ReceiptError('validation', 'Сумма прихода слишком большая — проверьте цены');
  if (!Number.isSafeInteger(input.extraCostUzs) || input.extraCostUzs < 0) throw new ReceiptError('validation', 'Накладные расходы должны быть целым числом ≥ 0');
  const extraMu = BigInt(input.extraCostUzs) * MU_PER_UZS;
  const landed = largestRemainder(extraMu, drafts.map((d) => (goodsMu > 0n ? d.valueMu : BigInt(d.qtyBase))));

  const lines: ReceiptLineResult[] = drafts.map((d, i) => {
    const landedMu = landed[i]!;
    const full = d.valueMu + landedMu;
    const unitCostMu = divRound(full, BigInt(d.qtyBase));
    if (unitCostMu > BigInt(MAX_UNIT_COST_MU)) throw new ReceiptError('validation', `Строка ${d.lineNo}: цена единицы больше 100 млн сум — проверьте цену`);
    const roundingMu = full - unitCostMu * BigInt(d.qtyBase);
    // price in the currency per base unit × 100: value in minor units × 100 / qty
    const valueMinorX100 = divRound(d.valueMu * conv.den * 100n, conv.num);
    const priceCurX100 = Number(divRound(valueMinorX100, BigInt(d.qtyBase)));
    const ref = d.item.lastCostMu;
    if (ref && ref > 0) {
      const limit = input.priceMode === 'total' && !d.manual ? 0.5 : 0.3;
      const without = Number(divRound(d.valueMu, BigInt(d.qtyBase)));
      const diff = (without - ref) / ref;
      if (Math.abs(diff) > limit) {
        warnings.push({
          code: 'price_jump',
          lineNo: d.lineNo,
          message: `Строка ${d.lineNo}: «${d.item.name}» — ${fmtNum(without / 1000)} сум за ед., в прошлый раз ${fmtNum(ref / 1000)} (${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) * 100)}%)`,
        });
      }
    }
    const { item: _item, minor: _minor, ...rest } = d;
    return { ...rest, landedMu, unitCostMu: Number(unitCostMu), roundingMu: Number(roundingMu), priceCurX100 };
  });

  if (input.currency === 'USD' && input.fxRateX100 && (input.fxRateX100 < 900_000 || input.fxRateX100 > 2_000_000)) {
    warnings.push({ code: 'fx_range', message: `Курс ${fmtNum(input.fxRateX100 / 100)} сум за доллар выглядит необычно — проверьте` });
  }
  const goodsMinor = divRound(goodsMu * conv.den, conv.num);
  return { lines, goodsMu, extraMu, goodsMinor, warnings };
}
