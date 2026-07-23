/**
 * App foreground/background + network status detection.
 *
 * Watches visibilitychange and online events. When the app returns to the
 * foreground or the network comes back online, checks whether the socket is
 * disconnected and triggers the onForeground callback if so.
 *
 * Per-room: instantiated once per room mount, stopped on unmount.
 */

import { getSocket } from "./socket-client";

const DEBOUNCE_MS = 500;

export class AppLifecycle {
  private onForeground: () => void;
  private lastTrigger = 0;

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
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.boundVisibility);
    window.removeEventListener("online", this.boundOnline);
  }

  private triggerIfDisconnected(): void {
    const now = Date.now();
    if (now - this.lastTrigger < DEBOUNCE_MS) return;
    const s = getSocket();
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
}
