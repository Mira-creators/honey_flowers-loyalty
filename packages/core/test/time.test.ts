import { describe, expect, it } from 'vitest';
import { calendarDaysBetween, localDateKey, monthsBeforeKey } from '../src/index.js';

const TZ = 'Asia/Tashkent';

describe('calendar helpers (Asia/Tashkent)', () => {
  it('uses the local date, not the UTC date', () => {
    // 2026-11-01 20:30 UTC = 2026-11-02 01:30 in Tashkent.
    expect(localDateKey(new Date('2026-11-01T20:30:00Z'), TZ)).toBe('2026-11-02');
    expect(localDateKey(new Date('2026-11-01T18:59:59Z'), TZ)).toBe('2026-11-01');
  });

  it('counts calendar days across local midnight', () => {
    const lateEvening = new Date('2026-11-01T18:50:00Z'); // 23:50 local
    const afterMidnight = new Date('2026-11-01T19:10:00Z'); // 00:10 local next day
    expect(calendarDaysBetween(lateEvening, afterMidnight, TZ)).toBe(1);
  });

  it('subtracts months clamping to the month end', () => {
    expect(monthsBeforeKey(new Date('2026-05-31T10:00:00+05:00'), 3, TZ)).toBe('2026-02-28');
    expect(monthsBeforeKey(new Date('2026-01-15T10:00:00+05:00'), 2, TZ)).toBe('2025-11-15');
  });
});
