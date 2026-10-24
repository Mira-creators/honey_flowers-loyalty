/**
 * «Моя карта»: florists and the owner are often clients too. The toggle shows the regular
 * client view (honeycomb, QR, gifts, history) for their OWN client record — /api/me already
 * carries it for any role; without one the client onboarding (share phone) registers them.
 * «Назад к работе» returns to the staff / owner screens. Charging the own card is refused by
 * the server (self_operation), so the toggle is only for looking and showing the QR.
 */
import { S, actions, app } from '../state';
import { tg } from '../tg';
import { clientView } from './client';

/** Toggle button for staff / owner headers. */
export const myCardButton = () =>
  S.me && S.me.role !== 'client' ? `<button class="mc-btn" data-act="myCardOn" aria-label="Моя карта клиента">🍯 Моя карта</button>` : '';

/** Header row for owner screens (the desk has its own staff head). */
export const myCardHead = () => (S.me && S.me.role !== 'client' ? `<div class="staff-head mc-head">${myCardButton()}</div>` : '');

export function myCardView(): string {
  return `<div class="mc-bar"><button class="mc-back" data-act="myCardOff">‹ Назад к работе</button><span class="mc-title">Моя карта</span></div>${clientView()}`;
}

actions.myCardOn = () => {
  S.myCard = true; S.screen = 'home'; tg.haptic('select');
  app.render(); void app.refresh(false);
};
actions.myCardOff = () => {
  S.myCard = false; S.screen = 'home'; tg.haptic('select');
  app.render();
};
