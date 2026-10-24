import type { ConsoleCohortDTO } from '@honey/contracts';
import { ApiErr, capi } from '../api';
import { acts, esc, fmt, monthName, pct, q, setQuery, shell } from '../core';

let data: ConsoleCohortDTO[] | null = null;
let error: string | null = null;
let loadedFor = 0;

const monthsParam = () => Math.min(36, Math.max(3, Number(q().get('months')) || 12));

export async function loadCohorts(force = false) {
  const m = monthsParam();
  if (!force && m === loadedFor && data) return;
  loadedFor = m;
  data = null;
  error = null;
  shell.renderView();
  try {
    data = (await capi.cohorts(m)).cohorts;
  } catch (e) {
    error = (e as ApiErr).message;
  }
  shell.renderView();
}

/** Cell with the share as text plus a single-hue intensity (sequential, light → dark). */
function cell(r: number, e: number): string {
  if (!e) return '<td class="num cx-mut" title="Окно ещё не закончилось">—</td>';
  const share = r / e;
  return `<td class="num cx-heat" style="--h:${Math.round(share * 100)}" title="${r} из ${e}">${pct(share)}<div class="cx-mut">${r} из ${e}</div></td>`;
}

export function cohortsView(): string {
  const m = monthsParam();
  const head = `<p class="cx-mut cx-sub">Клиенты сгруппированы по месяцу первой покупки. В ячейке — доля тех, кто вернулся за второй покупкой (в другой день) в течение 30, 60 и 90 дней.
    Считаются только клиенты, у которых это окно уже прошло, поэтому у свежих месяцев «—».</p>
    <div class="cx-seg" role="group" aria-label="Сколько месяцев">${[6, 12, 24].map((n) => `<button data-act="cohMonths" data-n="${n}" aria-pressed="${n === m}">${n} мес.</button>`).join('')}</div>`;
  if (error) return `${head}<div class="cx-err">${esc(error)} <button class="cx-link" data-act="cohReload">Повторить</button></div>`;
  if (!data) return `${head}<div class="cx-loading">Считаем…</div>`;
  if (!data.length) return `${head}<p class="cx-mut">Покупок за этот срок нет.</p>`;
  const sum = (k: keyof ConsoleCohortDTO) => data!.reduce((a, c) => a + Number(c[k]), 0);
  return `${head}<div class="cx-table-wrap"><table class="cx-table cx-cohorts"><thead><tr><th>Месяц первой покупки</th><th class="num">Новых покупателей</th><th class="num">Вернулись за 30 дн.</th><th class="num">за 60 дн.</th><th class="num">за 90 дн.</th></tr></thead><tbody>
    ${data.map((c) => `<tr><td>${esc(monthName(c.month))}</td><td class="num">${fmt(c.clients)}</td>${cell(c.r30, c.e30)}${cell(c.r60, c.e60)}${cell(c.r90, c.e90)}</tr>`).join('')}
    </tbody><tfoot><tr><td>Всего</td><td class="num">${fmt(sum('clients'))}</td>${cell(sum('r30'), sum('e30'))}${cell(sum('r60'), sum('e60'))}${cell(sum('r90'), sum('e90'))}</tr></tfoot></table></div>`;
}

acts.cohMonths = (el) => {
  setQuery({ months: el.dataset.n === '12' ? null : el.dataset.n });
  void loadCohorts();
};
acts.cohReload = () => loadCohorts(true);
