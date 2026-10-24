/** Phone helpers (Uzbekistan numbers: +998 XX XXX XX XX). */

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Last 9 digits = Uzbek national number without +998. */
export function nationalPart(digits: string): string {
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * Normalize a phone to E.164 "+998XXXXXXXXX".
 * Accepts "+998 90 123-45-67", "998901234567", "901234567", "8 90 123 45 67".
 * Other countries' numbers (10–15 digits) are kept as "+<digits>".
 * Returns null if it does not look like a phone.
 */
export function normalizePhone(raw: string): string | null {
  let d = phoneDigits(raw);
  if (d.length === 9) d = `998${d}`;
  else if (d.length === 10 && d.startsWith('8')) d = `998${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('998')) return `+${d}`;
  if (d.length >= 10 && d.length <= 15) return `+${d}`;
  return null;
}

/**
 * Imported clients (old shop base) have a phone but no Telegram account yet. clients.telegram_id
 * is NOT NULL UNIQUE, so they get a NEGATIVE placeholder derived from the phone digits
 * (real Telegram user ids are always positive). Claiming replaces it with the real id.
 */
export function placeholderTelegramId(phone: string): number {
  const d = phoneDigits(phone);
  const n = Number(d);
  if (!d || !Number.isSafeInteger(n) || n <= 0) throw new Error(`cannot derive a placeholder id from phone ${phone}`);
  return -n;
}

/** True for an imported client that no Telegram account has claimed yet. */
export function isUnlinkedTelegramId(telegramId: number): boolean {
  return telegramId < 0;
}

/** "+998901234567" → "+998 90 ••• •• 67". */
export function maskPhone(phone: string | null): string {
  if (!phone) return '';
  const d = phoneDigits(phone);
  if (d.length === 12 && d.startsWith('998')) return `+998 ${d.slice(3, 5)} ••• •• ${d.slice(10)}`;
  if (d.length < 4) return '••••';
  return `+${d.slice(0, Math.max(1, d.length - 9))} ••• ${d.slice(-2)}`;
}
