import type {
  MeDTO, Lang, ClientSummaryDTO, PurchasePreviewDTO, PurchaseResultDTO, OwnerStatsDTO, EditableRulesDTO, StaffDTO, OperationDTO,
  ClientRowDTO, ClientSort, ClientStatus, OwnerClientDTO,
} from '@honey/contracts';
import { ACTIVE_THEME } from './config/themes';

export type ClientScreen = 'home' | 'card' | 'gifts' | 'profile';
export type OwnerTab = 'desk' | 'stats' | 'clients' | 'rules' | 'staff' | 'ops';

/** Owner «Клиенты»: list (search, status chip, sort, cursor paging) and the opened client card. */
export interface ClientsState {
  q: string;
  status: ClientStatus | '';
  sort: ClientSort;
  items: ClientRowDTO[] | null;
  cursor: string | null;
  loading: boolean;
  error: string | null;
  cardId: string | null;
  card: OwnerClientDTO | null;
  cardError: string | null;
  /** Unsaved text of the note field (survives re-renders), null = show the saved note. */
  noteDraft: string | null;
  /** List scroll position, restored when the card is closed. */
  listScroll: number;
}

export interface StaffState {
  step: 'find' | 'client' | 'done';
  query: string;
  matches: Array<{ id: string; name: string; phoneMasked: string }>;
  client: ClientSummaryDTO | null;
  amount: string;
  redeem: boolean;
  giftId: string | null;
  channel: 'store' | 'delivery';
  preview: PurchasePreviewDTO | null;
  previewError: string | null;
  idem: string;
  result: PurchaseResultDTO | null;
  busy: boolean;
  recent: OperationDTO[] | null;
  recentError: boolean;
}

export const S = {
  me: null as MeDTO | null,
  lang: 'ru' as Lang,
  themeId: ACTIVE_THEME,
  loading: true,
  fatal: null as string | null,
  needsLogin: false,
  screen: 'home' as ClientScreen,
  animating: false,
  waitingContact: false,
  staff: null as unknown as StaffState,
  owner: {
    tab: 'stats' as OwnerTab,
    stats: null as OwnerStatsDTO | null,
    rules: null as EditableRulesDTO | null,
    draft: null as EditableRulesDTO | null,
    staffList: null as StaffDTO[] | null,
    ops: null as OperationDTO[] | null,
    cl: {
      q: '', status: '', sort: 'last_purchase_desc', items: null, cursor: null, loading: false, error: null,
      cardId: null, card: null, cardError: null, noteDraft: null, listScroll: 0,
    } as ClientsState,
    busy: false,
    error: null as string | null,
  },
};

export function resetStaff(keepRecent = true) {
  S.staff = {
    step: 'find', query: '', matches: [], client: null, amount: '', redeem: false, giftId: null, channel: 'store',
    preview: null, previewError: null, idem: '', result: null, busy: false, recent: keepRecent && S.staff ? S.staff.recent : null, recentError: false,
  };
}
resetStaff(false);

/** Delegated actions: any element with data-act="name" calls actions[name](el, event). */
export const actions: Record<string, (el: HTMLElement, e: Event) => void | Promise<void>> = {};
export const changes: Record<string, (el: HTMLInputElement | HTMLSelectElement) => void> = {};
/** Live `input` handlers (fire while typing; must not re-render the whole screen). */
export const inputs: Record<string, (el: HTMLInputElement | HTMLSelectElement) => void> = {};

/** Set by main.ts; screens call it to re-render. */
export const app = { render: () => {}, refresh: async (_animate = false) => {} };
