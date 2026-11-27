/**
 * Д1: «Как работает Медовая карта» + «Правила программы» + «Согласие на обработку персональных
 * данных» before the phone is shared (onboarding), once more for existing clients when the texts
 * change (re-consent), and as in-app pages (also opened from the bot: `?page=rules|consent`).
 * The texts come from the server (GET /api/legal): templates with [placeholders], marked as a draft.
 */
import type { LegalDocDTO } from '@honey/contracts';
import { S, actions, changes, app } from '../state';
import { T } from '../config/texts';
import { api, ApiErr } from '../api';
import { tg } from '../tg';
import { esc, toast } from '../ui/dom';

const L = () => T(S.lang);
let loading = false;

/** Load the texts once (the bullets depend on the rules in force). */
export function ensureLegal(): void {
  if (S.legal || loading) return;
  loading = true;
  api.legal().then(l => { S.legal = l; app.render(); }, () => undefined).finally(() => { loading = false; });
}

/** Placeholders like [ФИО ИП] are highlighted so nobody mistakes the template for the final text. */
const para = (p: string) => {
  const html = esc(p).replace(/\[([^\]]{1,80})\]/g, '<mark class="ph">[$1]</mark>');
  if (p.startsWith('## ')) return `<h3>${html.slice(3)}</h3>`;
  if (p.startsWith('• ')) return `<p class="li">${html.slice(2)}</p>`;
  return `<p>${html}</p>`;
};

function docHtml(d: LegalDocDTO) {
  return `<h2 class="h disp">${esc(d.title)}</h2>${d.paragraphs.map(para).join('')}`;
}

export function legalPageView(): string {
  ensureLegal();
  const l = S.legal, t = L();
  const doc = l ? (S.legalPage === 'consent' ? l.consent : l.rules) : null;
  return `<main class="scr legal" id="scr"><button class="back" data-act="closeLegal">${t.back}</button>
    ${l?.draft ? `<div class="draft-banner" role="note">⚠️ ${t.draft}</div>` : ''}
    ${doc ? docHtml(doc) : '<p class="mut">…</p>'}</main>`;
}

/** Bullets, the two links and the «Принимаю» checkbox (onboarding and re-consent). */
export function consentBlock(): string {
  ensureLegal();
  const l = S.legal, t = L();
  const bullets = l ? `<ul class="how">${l.summary.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '<p class="mut">…</p>';
  return `<div class="how-card"><h3 class="disp">${t.howTitle}</h3>${bullets}
    <div class="legal-links"><button class="link" data-act="openLegal" data-page="rules">📄 ${t.rulesLink}</button><button class="link" data-act="openLegal" data-page="consent">🔒 ${t.consentLink}</button></div>
    ${l?.draft ? `<div class="draft-banner sm">⚠️ ${t.draft}</div>` : ''}
    <label class="check"><input type="checkbox" id="consentCheck" data-change="consentCheck" ${S.consentChecked ? 'checked' : ''}><span>${t.accept}</span></label></div>`;
}

/** Existing client without the current consent: asked once on the next open. */
export function reconsentView(): string {
  const t = L();
  return `<main class="scr" id="scr"><div class="onb">${logoImg()}<h2 class="disp">${t.reconsentTitle}</h2><p>${t.reconsentText}</p>${consentBlock()}
    <button class="b acc full" data-act="acceptConsent" ${S.consentChecked ? '' : 'disabled'}>${t.goOn}</button></div></main>`;
}

/** The shop logo (optimized copy in public/brand). */
export const logoImg = (cls = 'logo') => `<img class="${cls}" src="/brand/honey-logo.webp" alt="Honey Flowers" width="168" height="168" decoding="async">`;

/** Store the consent (server keeps it for this Telegram user until the card exists). */
export async function giveConsent(): Promise<boolean> {
  if (!S.consentChecked) { toast(L().mustAccept, 'error'); return false; }
  const version = S.legal?.version ?? S.me?.consent.version;
  if (!version) return false;
  try { S.me = await api.consent(version); return true; }
  catch (e) {
    // The texts changed meanwhile: reload them and ask again.
    S.legal = null; S.consentChecked = false; ensureLegal(); app.render();
    toast((e as ApiErr).message, 'error'); return false;
  }
}

actions.openLegal = el => {
  S.legalPage = el.dataset.page === 'consent' ? 'consent' : 'rules'; tg.haptic('select'); app.render();
  const scr = document.getElementById('scr'); if (scr) scr.scrollTop = 0;
};
actions.closeLegal = () => { S.legalPage = null; app.render(); };
changes.consentCheck = el => { S.consentChecked = (el as HTMLInputElement).checked; app.render(); };
actions.acceptConsent = async () => { if (await giveConsent()) { tg.haptic('success'); app.render(); } };
