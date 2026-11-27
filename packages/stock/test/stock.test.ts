import { describe, expect, it } from 'vitest';
import {
  bouquetCost,
  can,
  computeReceipt,
  DEFAULT_STOCK_CONFIG,
  deficitLotId,
  divRound,
  freshnessOf,
  largestRemainder,
  lifeDefaultsFor,
  mergeStockConfig,
  muToUzs,
  pickLots,
  planDisassembly,
  ReceiptError,
  roundPrice,
  shareLevel,
  shares,
  shortBlocks,
  suggestPrice,
  type PickLot,
  type ReceiptItemInfo,
} from '../src/index.js';

const item = (id: string, over: Partial<ReceiptItemInfo> = {}): ReceiptItemInfo => ({
  id, name: id, kind: 'flower', packSize: 25, trackStock: true, lastCostMu: null, stdCostMu: null, ...over,
});
const items = (...xs: ReceiptItemInfo[]) => new Map(xs.map((x) => [x.id, x]));

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(muToUzs(1499)).toBe(1);
    expect(muToUzs(1500)).toBe(2);
    expect(muToUzs(-1500)).toBe(-2);
  });
});

describe('largestRemainder', () => {
  it('sums exactly and is proportional', () => {
    expect(largestRemainder(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(largestRemainder(10n, [0n, 0n])).toEqual([5n, 5n]);
    expect(largestRemainder(7n, [0n, 3n, 1n])).toEqual([0n, 5n, 2n]);
    expect(largestRemainder(0n, [5n, 6n])).toEqual([0n, 0n]);
  });
  it('one line takes everything', () => {
    expect(largestRemainder(12_345n, [7n])).toEqual([12_345n]);
  });
});

describe('receipt: lines mode', () => {
  it('pack price → stem cost (owner example: 30 roses for 360 000)', () => {
    const r = computeReceipt(
      { currency: 'UZS', fxRateX100: null, priceMode: 'lines', extraCostUzs: 0, lines: [{ itemId: 'r', qty: 1, unit: 'pack', price: 360_000, per: 'pack' }] },
      items(item('r', { packSize: 30 })),
    );
    expect(r.lines[0]!.qtyBase).toBe(30);
    expect(r.lines[0]!.unitCostMu).toBe(12_000_000);
    expect(r.lines[0]!.roundingMu).toBe(0);
  });
  it('per unit, per line and extra costs; Σ landed = extra exactly', () => {
    const r = computeReceipt(
      {
        currency: 'UZS', fxRateX100: null, priceMode: 'lines', extraCostUzs: 50_000,
        lines: [
          { itemId: 'a', qty: 2, unit: 'pack', price: 300_000, per: 'pack' },
          { itemId: 'b', qty: 30, unit: 'base', price: 6_000, per: 'unit' },
          { itemId: 'c', qty: 7, unit: 'base', price: 100_000, per: 'line' },
        ],
      },
      items(item('a'), item('b', { kind: 'greenery' }), item('c', { kind: 'supply', packSize: null })),
    );
    expect(r.goodsMu).toBe(BigInt((600_000 + 180_000 + 100_000) * 1000));
    expect(r.lines.reduce((a, l) => a + l.landedMu, 0n)).toBe(50_000_000n);
    // conservation per line: unit × qty + rounding = value + landed
    for (const l of r.lines) expect(BigInt(l.unitCostMu) * BigInt(l.qtyBase) + BigInt(l.roundingMu)).toBe(l.valueMu + l.landedMu);
    expect(Math.abs(r.lines[2]!.roundingMu)).toBeLessThanOrEqual(7 / 2);
  });
  it('USD: cents × rate', () => {
    const r = computeReceipt(
      { currency: 'USD', fxRateX100: 1_285_000, priceMode: 'lines', extraCostUzs: 0, lines: [{ itemId: 'r', qty: 1, unit: 'pack', price: 2_500, per: 'pack' }] },
      items(item('r', { packSize: 25 })),
    );
    // 25 $ × 12 850 = 321 250 сум for 25 stems = 12 850 сум per stem
    expect(r.lines[0]!.unitCostMu).toBe(12_850_000);
    expect(r.lines[0]!.priceCurX100).toBe(10_000); // 1,00 $ = 100 cents ×100
    expect(r.goodsMinor).toBe(2_500n);
  });
  it('validations', () => {
    const base = { currency: 'UZS' as const, fxRateX100: null, priceMode: 'lines' as const, extraCostUzs: 0 };
    expect(() => computeReceipt({ ...base, lines: [] }, items())).toThrow(ReceiptError);
    expect(() => computeReceipt({ ...base, lines: [{ itemId: 'x', qty: 1, unit: 'base', price: 1 }] }, items())).toThrow(/не найдена/);
    expect(() => computeReceipt({ ...base, lines: [{ itemId: 'a', qty: 1, unit: 'base' }] }, items(item('a')))).toThrow(/цену/);
    expect(() => computeReceipt({ ...base, lines: [{ itemId: 'a', qty: 1, unit: 'base', price: 1 }, { itemId: 'a', qty: 1, unit: 'base', price: 1 }] }, items(item('a')))).toThrow(/уже есть/);
    expect(() => computeReceipt({ ...base, currency: 'USD', lines: [{ itemId: 'a', qty: 1, unit: 'base', price: 1 }] }, items(item('a')))).toThrow(/курс/);
    expect(() => computeReceipt({ ...base, lines: [{ itemId: 'a', qty: 1, unit: 'base', price: 1 }] }, items(item('a', { trackStock: false })))).toThrow(/не учитывается/);
  });
  it('warns on a price jump > 30 % and odd fx', () => {
    const r = computeReceipt(
      { currency: 'USD', fxRateX100: 128_500, priceMode: 'lines', extraCostUzs: 0, lines: [{ itemId: 'a', qty: 10, unit: 'base', price: 100, per: 'unit' }] },
      items(item('a', { lastCostMu: 12_000_000 })),
    );
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['fx_range', 'price_jump']);
  });
});

describe('receipt: total mode', () => {
  const its = items(item('rose', { lastCostMu: 12_000_000 }), item('euc', { kind: 'greenery', lastCostMu: 6_000_000 }), item('new', { stdCostMu: null }));
  it('splits the total by reference price, exactly', () => {
    const r = computeReceipt(
      { currency: 'UZS', fxRateX100: null, priceMode: 'total', total: 803_100, extraCostUzs: 0, lines: [{ itemId: 'rose', qty: 2, unit: 'pack' }, { itemId: 'euc', qty: 30, unit: 'base' }] },
      its,
    );
    expect(r.goodsMu).toBe(803_100_000n);
    // weights 50×12 000 : 30×6 000 = 600 : 180
    expect(r.lines[0]!.valueMu).toBe(617_769_231n);
    expect(r.lines.map((l) => l.valueMu).reduce((a, b) => a + b)).toBe(803_100_000n);
  });
  it('manual line keeps its price, the rest is redistributed', () => {
    const r = computeReceipt(
      {
        currency: 'USD', fxRateX100: 1_285_000, priceMode: 'total', total: 6_250, extraCostUzs: 0,
        lines: [{ itemId: 'rose', qty: 2, unit: 'pack' }, { itemId: 'euc', qty: 30, unit: 'base', price: 45, per: 'unit' }, { itemId: 'new', qty: 5, unit: 'base' }],
      },
      its,
    );
    const total = 6_250n * 1_285_000n / 10n;
    expect(r.goodsMu).toBe(total);
    expect(r.lines[1]!.manual).toBe(true);
    expect(r.lines[1]!.valueMu).toBe(30n * 45n * 1_285_000n / 10n);
  });
  it('rejects manual lines above the total', () => {
    expect(() =>
      computeReceipt(
        { currency: 'UZS', fxRateX100: null, priceMode: 'total', total: 1_000, extraCostUzs: 0, lines: [{ itemId: 'rose', qty: 1, unit: 'base', price: 2_000, per: 'unit' }, { itemId: 'euc', qty: 1, unit: 'base' }] },
        its,
      ),
    ).toThrow(expect.objectContaining({ code: 'receipt_total_short' }));
  });
});

describe('pickLots (FIFO/FEFO)', () => {
  const lots: PickLot[] = [
    { id: 'L2', itemId: 'r', qty: 10, unitCostMu: 9_000_000, priority: 0, expiresOn: '2026-11-12', receivedAt: '2026-11-05T10:00:00Z' },
    { id: 'L1', itemId: 'r', qty: 7, unitCostMu: 8_000_000, priority: 0, expiresOn: '2026-11-10', receivedAt: '2026-11-03T10:00:00Z' },
    { id: 'L3', itemId: 'r', qty: 5, unitCostMu: 10_000_000, priority: 1, expiresOn: '2026-11-14', receivedAt: '2026-11-07T10:00:00Z' },
  ];
  const opts = { policy: 'warn' as const, confirmedShort: false, deficitCostMu: () => 9_000_000 };
  it('priority first, then oldest; partial lots', () => {
    const { picks, short } = pickLots(lots, [{ itemId: 'r', qty: 15 }], opts);
    expect(short).toEqual([]);
    expect(picks.map((p) => [p.lotId, p.qty])).toEqual([['L3', 5], ['L1', 7], ['L2', 3]]);
    expect(picks.reduce((a, p) => a + p.valueMu, 0n)).toBe(5n * 10_000_000n + 7n * 8_000_000n + 3n * 9_000_000n);
  });
  it('shortage: warn blocks until confirmed, then deficit lot', () => {
    const a = pickLots(lots, [{ itemId: 'r', qty: 25 }], opts);
    expect(a.short).toEqual([{ itemId: 'r', need: 25, have: 22 }]);
    expect(shortBlocks(a.short, 'warn', false)).toBe(true);
    const b = pickLots(lots, [{ itemId: 'r', qty: 25 }], { ...opts, confirmedShort: true });
    expect(b.picks.at(-1)).toMatchObject({ lotId: deficitLotId('r', 9_000_000), qty: 3, deficit: true });
    expect(shortBlocks(b.short, 'warn', true)).toBe(false);
    expect(shortBlocks(b.short, 'block', true)).toBe(true);
  });
});

describe('pricing', () => {
  it('architecture example §4.10: 585 000, 27,7 % green, flowers 26,2 % amber', () => {
    const cost = bouquetCost([
      { kind: 'flower', valueMu: 135_000_000n },
      { kind: 'greenery', valueMu: 18_000_000n },
      { kind: 'supply', valueMu: 8_000_000n },
      { kind: 'supply', valueMu: 1_200_000n },
    ]);
    expect(cost).toMatchObject({ flowersCostUzs: 153_000, suppliesCostUzs: 9_200, costUzs: 162_200 });
    const price = suggestPrice(
      [{ kind: 'flower', valueMu: 153_000_000n }, { kind: 'supply', valueMu: 9_200_000n }],
      DEFAULT_STOCK_CONFIG.pricing,
    );
    expect(price).toBe(585_000);
    const s = shares(cost, price);
    expect(shareLevel(s.costShare, 33, 5)).toBe('good');
    expect(shareLevel(s.flowersShare, 25, 5)).toBe('warn');
    const at495 = shares(cost, 495_000);
    expect(shareLevel(at495.flowersShare, 25, 5)).toBe('bad');
  });
  it('rounding step/offset and edges', () => {
    expect(roundPrice(578_400, 10_000, 5_000)).toBe(585_000);
    expect(roundPrice(585_000, 10_000, 5_000)).toBe(585_000);
    expect(roundPrice(585_001, 10_000, 5_000)).toBe(595_000);
    expect(roundPrice(0, 10_000, 5_000)).toBe(0);
    expect(roundPrice(100, 10_000, 5_000)).toBe(5_000);
    expect(shareLevel(0.33, 33, 5)).toBe('good');
    expect(shareLevel(0.38, 33, 5)).toBe('warn');
    expect(shareLevel(0.3801, 33, 5)).toBe('bad');
  });
  it('item markup overrides the kind multiplier', () => {
    expect(suggestPrice([{ kind: 'flower', valueMu: 10_000_000n, markupX100: 400 }], { ...DEFAULT_STOCK_CONFIG.pricing, labourPct: 0 })).toBe(45_000);
  });
});

describe('freshness', () => {
  it('overdue / today / soon / fresh', () => {
    expect(freshnessOf('2026-11-09', 1, '2026-11-10')).toBe('overdue');
    expect(freshnessOf('2026-11-10', 1, '2026-11-10')).toBe('today');
    expect(freshnessOf('2026-11-11', 1, '2026-11-10')).toBe('soon');
    expect(freshnessOf('2026-11-12', 1, '2026-11-10')).toBe('fresh');
    expect(freshnessOf(null, 1, '2026-11-10')).toBe('fresh');
  });
});

describe('disassembly', () => {
  it('returns every stem to its lot, then waste from the oldest lots', () => {
    const taken = [
      { id: 'old', itemId: 'r', qty: 0, unitCostMu: 8, priority: 0, expiresOn: '2026-11-10', receivedAt: '2026-11-03', taken: 4, deficit: false },
      { id: 'new', itemId: 'r', qty: 0, unitCostMu: 9, priority: 0, expiresOn: '2026-11-12', receivedAt: '2026-11-05', taken: 6, deficit: false },
      { id: 'e', itemId: 'e', qty: 0, unitCostMu: 5, priority: 0, expiresOn: null, receivedAt: '2026-11-05', taken: 3, deficit: false },
    ];
    const { moves, waste } = planDisassembly(taken, new Map([['r', 5]]));
    expect(moves.filter((m) => m.reason === 'disassembly_return').map((m) => [m.lotId, m.qty])).toEqual([['old', 4], ['new', 6], ['e', 3]]);
    expect(moves.filter((m) => m.reason === 'disassembly_waste').map((m) => [m.lotId, m.qty])).toEqual([['old', -4], ['new', -1]]);
    expect(waste.get('r')).toBe(5);
    expect(waste.get('e')).toBe(0);
  });
});

describe('config and permissions', () => {
  it('merges a partial stored config over defaults', () => {
    const c = mergeStockConfig({ negativePolicy: 'block', pricing: { labourPct: 10 }, unknown: 1 });
    expect(c.negativePolicy).toBe('block');
    expect(c.pricing.labourPct).toBe(10);
    expect(c.pricing.flowersMultiplier).toBe(3);
    expect((c as unknown as Record<string, unknown>).unknown).toBeUndefined();
    expect(mergeStockConfig('garbage')).toEqual(DEFAULT_STOCK_CONFIG);
  });
  it('life defaults by group', () => {
    expect(lifeDefaultsFor(DEFAULT_STOCK_CONFIG, 'flower', 'Розы').vaseLifeDays).toBe(7);
    expect(lifeDefaultsFor(DEFAULT_STOCK_CONFIG, 'flower', 'Тюльпаны').sellDays).toBe(3);
    expect(lifeDefaultsFor(DEFAULT_STOCK_CONFIG, 'greenery', 'Зелень').vaseLifeDays).toBe(10);
    expect(lifeDefaultsFor(DEFAULT_STOCK_CONFIG, 'supply', 'Упаковка').sellDays).toBeNull();
  });
  it('permission matrix', () => {
    const cfg = DEFAULT_STOCK_CONFIG;
    expect(can('client', 'catalog.read', cfg)).toBe(false);
    expect(can('florist', 'bouquet.assemble', cfg)).toBe(true);
    expect(can('florist', 'catalog.edit', cfg)).toBe(false);
    expect(can('florist', 'receipt.post', cfg)).toBe(true);
    expect(can('florist', 'receipt.post', { receiptRoles: ['owner'] })).toBe(false);
    expect(can('owner', 'receipt.post', { receiptRoles: [] })).toBe(true);
    expect(can('florist', 'writeoff.approve', cfg)).toBe(false);
    expect(can('owner', 'writeoff.approve', cfg)).toBe(true);
    expect(can('manager', 'receipt.cancel', cfg)).toBe(false);
  });
});
