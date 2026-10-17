import type { CellReward, Reward, RewardType } from '@honey/core';

/**
 * Gift "type codes" of the HTTP contract (GiftDTO.type, CardDTO.gifts,
 * EditableRulesDTO.gifts) ⇄ engine rewards (CellReward / Reward).
 *
 *   card      ⇄ free_card            "Открытка в подарок"
 *   delivery  ⇄ free_delivery        "Бесплатная доставка"
 *   disc<N>   ⇄ discount_pct value N "Скидка N% на следующий заказ"
 *   mini      ⇄ custom               "Мини-букет в подарок"
 */

export const GIFT_CODE_RE = /^(card|delivery|mini|disc([1-9]|[1-9][0-9]))$/;

const CUSTOM_TITLES: Record<string, string> = {
  mini: 'Мини-букет в подарок',
};

export function giftCode(r: { type: RewardType; value?: number | null; title: string }): string {
  switch (r.type) {
    case 'free_card':
      return 'card';
    case 'free_delivery':
      return 'delivery';
    case 'discount_pct':
      return `disc${Math.round(r.value ?? 0)}`;
    case 'custom': {
      const known = Object.entries(CUSTOM_TITLES).find(([, t]) => t === r.title);
      return known ? known[0] : 'mini';
    }
  }
}

export function rewardFromCode(cell: number, code: string): CellReward {
  if (code === 'card') return { cell, type: 'free_card', title: 'Открытка в подарок' };
  if (code === 'delivery') return { cell, type: 'free_delivery', title: 'Бесплатная доставка' };
  const disc = /^disc(\d+)$/.exec(code);
  if (disc) {
    const pct = Number(disc[1]);
    return { cell, type: 'discount_pct', value: pct, title: `Скидка ${pct}% на следующий заказ` };
  }
  return { cell, type: 'custom', title: CUSTOM_TITLES[code] ?? code };
}

export function giftLayout(rewards: readonly CellReward[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of [...rewards].sort((a, b) => a.cell - b.cell)) out[String(r.cell)] = giftCode(r);
  return out;
}

export function giftCodeOfReward(r: Reward): string {
  return giftCode(r);
}
