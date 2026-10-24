import type { ApiError } from '@honey/contracts';
import { LoyaltyError, type LoyaltyErrorCode } from '@honey/core';
import { ConcurrencyError, NotFoundError, PhoneTakenError } from '@honey/service';
import { ZodError } from 'zod';

export type ApiErrorCode = ApiError['error']['code'];

/** Error with an HTTP status and a contract error code. Message is Russian (shown to staff). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const OWNER_FIX = 'Если нужно исправить баланс, это может сделать владелец через «Скорректировать мёд».';

/** Russian reason why a purchase cannot be reversed (also shown next to the disabled «Отменить»). */
export function reversalBlockMessage(code: 'REVERSAL_WINDOW_EXPIRED' | 'REVERSAL_GIFT_USED' | 'REVERSAL_POINTS_SPENT', hours = 24): string {
  if (code === 'REVERSAL_WINDOW_EXPIRED') return `Отмена возможна только в течение ${hours} ч после покупки — отменить нельзя. ${OWNER_FIX}`;
  if (code === 'REVERSAL_GIFT_USED') return `Подарок за эту покупку уже использован — отменить нельзя. ${OWNER_FIX}`;
  return `Мёд с этой покупки уже потрачен — отменить нельзя. ${OWNER_FIX}`;
}

const LOYALTY_MAP: Record<LoyaltyErrorCode, { status: number; code: ApiErrorCode; message: string }> = {
  INVALID_INPUT: { status: 400, code: 'validation', message: 'Неверные данные' },
  INSUFFICIENT_BALANCE: { status: 422, code: 'insufficient_points', message: 'Недостаточно мёда на балансе' },
  REDEEM_CAP_EXCEEDED: { status: 422, code: 'insufficient_points', message: 'Превышен лимит оплаты мёдом для этой суммы' },
  DISCOUNT_WITH_POINTS_NOT_ALLOWED: { status: 422, code: 'validation', message: 'Скидку-подарок нельзя совмещать с оплатой мёдом' },
  REWARD_NOT_FOUND: { status: 404, code: 'not_found', message: 'Подарок не найден' },
  REWARD_NOT_AVAILABLE: { status: 409, code: 'conflict', message: 'Подарок уже использован или недоступен' },
  PURCHASE_NOT_FOUND: { status: 404, code: 'not_found', message: 'Покупка не найдена' },
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'conflict', message: 'Этот ключ операции уже использован для другой покупки' },
  REVERSAL_WINDOW_EXPIRED: { status: 409, code: 'conflict', message: '' },
  REVERSAL_GIFT_USED: { status: 409, code: 'conflict', message: '' },
  REVERSAL_POINTS_SPENT: { status: 409, code: 'conflict', message: '' },
};

export function toApiError(err: unknown): { status: number; body: ApiError } {
  const body = (code: ApiErrorCode, message: string): ApiError => ({ error: { code, message } });
  if (err instanceof HttpError) return { status: err.status, body: body(err.code, err.message) };
  if (err instanceof LoyaltyError) {
    if (err.code === 'REVERSAL_WINDOW_EXPIRED' || err.code === 'REVERSAL_GIFT_USED' || err.code === 'REVERSAL_POINTS_SPENT') {
      return { status: 409, body: body('conflict', reversalBlockMessage(err.code, err.data.hours)) };
    }
    const m = LOYALTY_MAP[err.code];
    // Keep the engine detail (e.g. "at most 25000 points") after the Russian text.
    return { status: m.status, body: body(m.code, `${m.message} (${err.message})`) };
  }
  if (err instanceof NotFoundError) return { status: 404, body: body('not_found', 'Не найдено') };
  if (err instanceof PhoneTakenError) return { status: 409, body: body('conflict', 'Этот номер уже привязан к другому аккаунту Telegram') };
  if (err instanceof ConcurrencyError) {
    return { status: 409, body: body('conflict', 'Данные клиента одновременно изменились, повторите операцию') };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return { status: 400, body: body('validation', `Неверные данные: ${where}${first?.message ?? ''}`) };
  }
  if (err instanceof SyntaxError) return { status: 400, body: body('validation', 'Тело запроса не JSON') };
  console.error('internal error', err);
  return { status: 500, body: body('internal', 'Внутренняя ошибка сервера') };
}
