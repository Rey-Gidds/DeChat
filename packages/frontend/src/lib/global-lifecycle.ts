/**
 * Singleton App lifecycle for the global WebSocket.
 *
 * Unlike the per-room AppLifecycle, this is instantiated once inside
 * GlobalSocketProvider and runs continuously across all page navigations.
 *
 * Watches:
 *  - visibilitychange (tab returns to foreground)
 *  - online (network restored)
 *
 * When the app returns to foreground / comes online:
 *  - Checks if global socket is disconnected
 *  - If so, triggers GlobalReconnectionManager.forceReconnect() immediately
 *  - Debounced by 500ms
 *
 * Proactive ticket renewal: refreshes user ticket every 45s while connected.
 */

import { getGlobalSocket } from "./socket-client";

const DEBOUNCE_MS = 500;
const TICKET_RENEW_MS = 45_000;

export class GlobalAppLifecycle {
  private onForeground: () => void;
  private lastTrigger = 0;
  private renewInterval: ReturnType<typeof setInterval> | null = null;

  private boundVisibility: () => void;
  private boundOnline: () => void;

  constructor(onForeground: () => void) {
    this.onForeground = onForeground;
    this.boundVisibility = this.handleVisibility.bind(this);
    this.boundOnline = this.handleOnline.bind(this);
  }

  start(): void {
    document.addEventListener("visibilitychange", this.boundVisibility);
    window.addEventListener("online", this.boundOnline);
    this.startTicketRenewal();
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.boundVisibility);
    window.removeEventListener("online", this.boundOnline);
    this.stopTicketRenewal();
  }

  private triggerIfDisconnected(): void {
    const now = Date.now();
    if (now - this.lastTrigger < DEBOUNCE_MS) return;
    const s = getGlobalSocket();
    if (s?.connected) return;
    this.lastTrigger = now;
    this.onForeground();
  }

  private handleVisibility(): void {
    if (document.visibilityState === "visible") {
      this.triggerIfDisconnected();
    }
  }

  private handleOnline(): void {
    this.triggerIfDisconnected();
  }

  // ── proactive ticket renewal ────────────────────────────────────

  private startTicketRenewal(): void {
    if (this.renewInterval) return;
    this.renewInterval = setInterval(() => {
      const s = getGlobalSocket();
      if (!s?.connected) return;
      void fetch("/api/ws/user-ticket", {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
    }, TICKET_RENEW_MS);
  }

  private stopTicketRenewal(): void {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }
  }
}
