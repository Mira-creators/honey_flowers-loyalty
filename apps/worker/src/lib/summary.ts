import type { ClientSummaryDTO, MeDTO, OperationDTO } from '@honey/contracts';
import type { ClientState, LoyaltyRules } from '@honey/core';
import type { Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { actorIds, clientSummary, publicRules } from './dto.js';
import { HttpError } from './errors.js';

/** Summary of a client as of `now` (loads state unless given). */
export async function summaryFor(
  app: AppContext,
  rules: LoyaltyRules,
  clientId: string,
  now: Date,
  state?: ClientState,
): Promise<ClientSummaryDTO> {
  const client = await app.repo.findClientById(clientId);
  if (!client) throw new HttpError(404, 'not_found', 'Клиент не найден');
  const s = state ?? (await app.repo.loadClientState(clientId)).state;
  return clientSummary(rules, client, s, now, await app.repo.actorNames(actorIds(s)));
}

export async function buildMe(app: AppContext, caller: Caller): Promise<MeDTO> {
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
  const client = await app.repo.findClientByTelegramId(caller.telegramId);
  const summary = client ? await summaryFor(app, rules, client.id, now) : null;
  const botUsername = app.env.BOT_USERNAME?.trim().replace(/^@/, '') || (await app.repo.getSetting('bot_username')) || null;
  return {
    telegramId: caller.telegramId,
    firstName: caller.firstName,
    role: caller.role,
    testMode: app.testMode,
    registered: !!client?.phone,
    client: summary,
    rules: publicRules(rules),
    now: now.toISOString(),
    clockOffsetDays: app.clockOffsetDays,
    botUsername,
  };
}

export async function operationsFor(app: AppContext, limit: number): Promise<OperationDTO[]> {
  const rows = await app.repo.operations(limit);
  const names = await app.repo.actorNames(rows.map((r) => (r.staff_id === null ? null : String(r.staff_id))));
  return rows.map((r) => {
    const op: OperationDTO = {
      id: String(r.id),
      at: String(r.at),
      kind: String(r.kind) as OperationDTO['kind'],
      points: Number(r.points ?? 0),
      clientId: String(r.client_id),
      clientName: r.client_name === null ? '' : String(r.client_name),
      staffName: r.staff_id === null ? null : names.get(String(r.staff_id)) ?? null,
    };
    if (r.purchase_id !== null) op.purchaseId = String(r.purchase_id);
    if (r.purchase_amount !== null) op.purchaseAmount = Number(r.purchase_amount);
    if (r.status !== null) op.status = String(r.status) as 'active' | 'reversed';
    return op;
  });
}

/** Engine warnings are English; staff sees Russian. */
export function translateWarning(w: string): string {
  let m = /^card step \(card (\d+), cell (\d+)\) was not rolled back/.exec(w);
  if (m) return `Шаг по сотам (карта ${m[1]}, сота ${m[2]}) не откатан: после этой покупки пчёлка уже ходила дальше.`;
  m = /^gift "(.+)" \(card (\d+), cell (\d+)\) unlocked by this purchase was already used/.exec(w);
  if (m) return `Подарок «${m[1]}» (карта ${m[2]}, сота ${m[3]}) из этой покупки уже использован — он остаётся у клиента.`;
  m = /^points balance is negative \((-?\d+)\)/.exec(w);
  if (m) return `Баланс мёда ушёл в минус (${m[1]}): начисленный за покупку мёд уже потрачен.`;
  if (w === 'balance becomes negative') return 'Баланс мёда станет отрицательным.';
  return w;
}
