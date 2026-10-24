import type { ClientSummaryDTO, MeDTO, OperationDTO } from '@honey/contracts';
import type { ClientState, LoyaltyRules } from '@honey/core';
import type { Caller } from '../auth.js';
import type { AppContext } from '../context.js';
import { clientSummary, publicRules } from './dto.js';
import { historyActorIds, historyItems } from './history.js';
import { HttpError, reversalBlockMessage } from './errors.js';

/**
 * Summary of a client as of `now`: the BOUNDED state (unless given) and the last 50 history items
 * in ONE read batch, then the staff names of those items. Cost independent of the history length.
 */
export async function summaryFor(
  app: AppContext,
  rules: LoyaltyRules,
  clientId: string,
  now: Date,
  state?: ClientState,
): Promise<ClientSummaryDTO> {
  const client = await app.repo.findClientById(clientId);
  if (!client) throw new HttpError(404, 'not_found', 'Клиент не найден');
  const { state: s, historyRows } = await app.repo.loadStateWithHistory(clientId, { now, rules }, state);
  const names = await app.repo.actorNames(historyActorIds(historyRows));
  return clientSummary(rules, client, s, now, historyItems(historyRows, names));
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
    // «🧪 Тест» only for testers (TEST_MODE + TEST_USERS); everyone else sees the production app.
    testMode: caller.tester,
    registered: !!client?.phone,
    client: summary,
    rules: publicRules(rules),
    now: now.toISOString(),
    clockOffsetDays: app.clockOffsetDays,
    botUsername,
  };
}

export async function operationsFor(app: AppContext, limit: number): Promise<OperationDTO[]> {
  const now = app.now();
  const { rules } = await app.repo.getActiveRules(now);
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
    if (r.reason !== null && r.reason !== undefined && String(r.reason)) op.reason = String(r.reason);
    // Item 8: may staff still reverse this purchase? (the server checks again on «Отменить»)
    if (op.kind === 'purchase' && op.status === 'active') {
      const hours = rules.reversalWindowHours;
      const block =
        now.getTime() - Date.parse(op.at) > hours * 3_600_000 ? reversalBlockMessage('REVERSAL_WINDOW_EXPIRED', hours)
        : Number(r.rev_gift_used ?? 0) === 1 ? reversalBlockMessage('REVERSAL_GIFT_USED')
        : Number(r.rev_balance ?? 0) < 0 ? reversalBlockMessage('REVERSAL_POINTS_SPENT')
        : null;
      op.reversible = block === null;
      if (block) op.reverseBlocked = block;
    }
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
