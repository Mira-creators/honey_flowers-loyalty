import { emptyOutcome, type Outcome } from '../outcome.js';
import type { LoyaltyRules } from '../rules.js';
import { cardPosition } from '../state.js';
import { dayNumberFromKey, keyFromDayNumber, localDateKey } from '../time.js';
import type { ClientState, Reward } from '../types.js';

/**
 * Birthday gift (Л6): «−10 % ко дню рождения» appears `daysBefore` local days before the birthday
 * and is valid until `daysAfter` days after it, ONCE per year (the gift id carries the year of the
 * birthday it belongs to). It is an ordinary gift (Reward) with an end date (`validUntil`): one gift
 * per order, so it never combines with the cell-10 discount (the client picks one, the other stays),
 * and a discount never combines with мёд (rules.allowDiscountWithPoints).
 *
 * Run by the daily job (runExpiry) and right after the birthday is entered; idempotent.
 */

export const BIRTHDAY_REWARD_PREFIX = 'bday-';

/** Globally unique id of a client's birthday gift for the birthday in `year`. */
export function birthdayRewardId(clientId: string, year: number): string {
  return `${BIRTHDAY_REWARD_PREFIX}${year}-${clientId}`;
}

export function isBirthdayReward(r: Pick<Reward, 'id' | 'unlockedByPurchase'>): boolean {
  return r.unlockedByPurchase === null && r.id.startsWith(BIRTHDAY_REWARD_PREFIX);
}

/** Valid 'YYYY-MM-DD' (or '--MM-DD' without a year)? Returns [month, day] or null. */
export function parseBirthday(birthday: string | null | undefined): [number, number] | null {
  if (!birthday) return null;
  const m = /^(?:\d{4}|--)-(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1) return null;
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= max ? [month, day] : null;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The birthday in `year` as a local date key (29 Feb → 28 Feb in a common year). */
export function birthdayIn(year: number, month: number, day: number): string {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface BirthdayWindow {
  /** Year of the birthday the window belongs to (the gift's id). */
  year: number;
  birthday: string;
  /** First and last local day (inclusive) the gift is available. */
  from: string;
  until: string;
}

/**
 * The gift window that contains `now`'s local day, or else the next one. null = no valid birthday or
 * the gift is disabled.
 */
export function birthdayWindow(rules: LoyaltyRules, birthday: string | null | undefined, now: Date): (BirthdayWindow & { current: boolean }) | null {
  const br = rules.birthdayReward;
  const md = parseBirthday(birthday);
  if (!br.enabled || br.type === 'points' || !md) return null;
  const today = localDateKey(now, rules.timezone);
  const t = dayNumberFromKey(today);
  const y = Number(today.slice(0, 4));
  for (const year of [y - 1, y, y + 1, y + 2]) {
    const b = birthdayIn(year, md[0], md[1]);
    const from = dayNumberFromKey(b) - br.daysBefore;
    const until = dayNumberFromKey(b) + br.daysAfter;
    if (until < t) continue;
    return { year, birthday: b, from: keyFromDayNumber(from), until: keyFromDayNumber(until), current: from <= t };
  }
  return null;
}

export function birthdayGiftTitle(rules: LoyaltyRules): string {
  const br = rules.birthdayReward;
  return br.type === 'discount_pct' ? `Скидка ${br.value}% ко дню рождения` : 'Подарок ко дню рождения';
}

/**
 * Unlock this year's birthday gift when its window has come; revoke birthday gifts whose last day
 * has passed. Revoking happens even if the gift is switched off meanwhile.
 */
export function birthdayCheck(rules: LoyaltyRules, state: ClientState, now: Date): Outcome {
  const out = emptyOutcome();
  const today = localDateKey(now, rules.timezone);
  for (const r of state.rewards) {
    if (r.status === 'available' && r.validUntil && r.validUntil < today && isBirthdayReward(r)) {
      out.rewardsUpdated.push({ ...r, status: 'revoked' });
    }
  }
  const w = birthdayWindow(rules, state.birthday, now);
  if (w && w.current) {
    const id = birthdayRewardId(state.clientId, w.year);
    if (!state.rewards.some((r) => r.id === id)) {
      const br = rules.birthdayReward;
      const title = birthdayGiftTitle(rules);
      // Not tied to a cell; storage needs cycle/cell >= 1, so the bee's current place is recorded (as grants do).
      const pos = cardPosition(rules, state);
      out.rewardsUnlocked.push({
        id,
        clientId: state.clientId,
        cycle: pos.cycle,
        cell: Math.max(1, pos.filled),
        type: br.type === 'discount_pct' ? 'discount_pct' : 'custom',
        value: br.type === 'discount_pct' ? br.value : null,
        title,
        status: 'available',
        unlockedByPurchase: null,
        usedInPurchase: null,
        unlockedAt: now,
        usedAt: null,
        validUntil: w.until,
      });
      out.events.push({
        type: 'birthday_gift',
        clientId: state.clientId,
        rewardId: id,
        rewardType: br.type === 'discount_pct' ? 'discount_pct' : 'custom',
        title,
        validUntil: w.until,
      });
    }
  }
  return out;
}
