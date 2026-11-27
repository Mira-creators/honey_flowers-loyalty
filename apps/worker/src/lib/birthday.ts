import { birthdayCheck, localDateKey } from '@honey/core';
import { hasEffects } from '@honey/service';
import type { AppContext } from '../context.js';
import { nextCheckOn } from './expirySchedule.js';
import { HttpError } from './errors.js';

/**
 * Л6: the client enters the birthday ONCE (profile or right after registration); afterwards only the
 * owner changes it (client card). Valid 'YYYY-MM-DD', a real day, not in the future, year ≥ 1900.
 */
export function parseBirthdayInput(v: unknown, now: Date): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const bad = () => new HttpError(400, 'validation', 'Укажите дату рождения в формате ГГГГ-ММ-ДД');
  if (!m) throw bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw bad();
  if (y < 1900 || s > localDateKey(now, 'Asia/Tashkent')) throw new HttpError(400, 'validation', 'Проверьте дату рождения');
  return s;
}

/**
 * After the birthday was set or changed: unlock the gift at once if its window has already come,
 * and reschedule the daily job for this client (the window / revoke dates).
 */
export async function applyBirthday(app: AppContext, clientId: string): Promise<void> {
  const res = await app.service.execute(clientId, ({ rules, state, now }) => birthdayCheck(rules, state, now));
  if (!hasEffects(res.outcome)) await app.repo.setNextChecks([{ clientId, on: nextCheckOn(res.rules, res.state, res.now) }]);
}
