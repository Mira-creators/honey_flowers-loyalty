/** Thin wrapper over Telegram.WebApp so the rest of the app works in a plain browser too. */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { Telegram?: any } }
const W = (): any => window.Telegram?.WebApp;

export const tg = {
  get inTelegram(): boolean { const w = W(); return !!(w && typeof w.initData === 'string' && w.initData.length > 0); },
  initData(): string { return W()?.initData ?? ''; },
  user(): { id: number; first_name: string } | null { return W()?.initDataUnsafe?.user ?? null; },
  ready() {
    const w = W(); if (!w) return;
    try { w.ready(); w.expand(); w.disableVerticalSwipes?.(); } catch { /* older clients */ }
  },
  colorScheme(): 'light' | 'dark' {
    const w = W(); if (tg.inTelegram && w?.colorScheme) return w.colorScheme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },
  onThemeChanged(cb: () => void) { W()?.onEvent?.('themeChanged', cb); matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', cb); },
  setColors(bg: string) { const w = W(); if (!tg.inTelegram) return; try { w.setHeaderColor?.(bg); w.setBackgroundColor?.(bg); w.setBottomBarColor?.(bg); } catch { /* ignore */ } },
  haptic(kind: 'success' | 'error' | 'warning' | 'light' | 'select') {
    const h = W()?.HapticFeedback; if (!h || !tg.inTelegram) return;
    try { if (kind === 'light') h.impactOccurred('light'); else if (kind === 'select') h.selectionChanged(); else h.notificationOccurred(kind); } catch { /* ignore */ }
  },
  requestContact(): Promise<boolean> {
    return new Promise(res => {
      const w = W(); if (!w?.requestContact || !tg.inTelegram) return res(false);
      try { w.requestContact((ok: boolean) => res(!!ok)); } catch { res(false); }
    });
  },
  canScan(): boolean { return tg.inTelegram && typeof W()?.showScanQrPopup === 'function'; },
  scanQr(text: string): Promise<string | null> {
    return new Promise(res => {
      const w = W(); if (!tg.canScan()) return res(null);
      let done = false;
      const closed = () => { w.offEvent?.('scanQrPopupClosed', closed); if (!done) { done = true; res(null); } };
      w.onEvent?.('scanQrPopupClosed', closed);
      w.showScanQrPopup({ text }, (data: string) => {
        if (done) return true;
        done = true; w.offEvent?.('scanQrPopupClosed', closed); res(data); return true;
      });
    });
  },
  openTelegramLink(url: string) { const w = W(); if (tg.inTelegram && w?.openTelegramLink) w.openTelegramLink(url); else window.open(url, '_blank', 'noopener'); },
  backButton(cb: (() => void) | null) {
    const b = W()?.BackButton; if (!b || !tg.inTelegram) return;
    b.offClick?.(backHandler); backHandler = cb ?? (() => {});
    if (cb) { b.onClick(backHandler); b.show(); } else b.hide();
  },
};
let backHandler: () => void = () => {};
