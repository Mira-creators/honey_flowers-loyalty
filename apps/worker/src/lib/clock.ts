/**
 * Global clock: `now = real now + settings.clock_offset_days` (TEST_MODE time
 * travel). Used everywhere: API, bot and the cron job.
 */
export const DAY_MS = 86_400_000;

export function shiftedNow(offsetDays: number, real: Date = new Date()): Date {
  return new Date(real.getTime() + offsetDays * DAY_MS);
}
