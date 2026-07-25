/**
 * Room-agnostic global reconnection manager.
 *
 * Tier 1 — Socket.IO's built-in reconnection loop:
 *   10 attempts with Fibonacci-like delays (1s → 21s cap).
 *
 * Tier 2 — Fallback loop on reconnect_failed:
 *   Continues Fibonacci from fib(8)=34s → fib(14)=610s (~10 min).
 *   Every 3rd attempt fetches a fresh user ticket.
 *
 * On reconnect:
 *   1. Server rebuilds subscriptions from MongoDB
 *   2. Client emits sync_metadata for unread count reconciliation
 *   3. Global outbox worker flushes all queued messages
 */

import { io, Socket } from "socket.io-client";
import { setGlobalSocket, ACK_TIMEOUT_MS } from "./socket-client";

const FIB: number[] = (() => {
  const seq = [1, 1];
  while (seq.length < 16) seq.push(seq[seq.length - 1] + seq[seq.length - 2]);
  return seq;
})();

function fibMs(index: number): number {
  return FIB[Math.min(index, FIB.length - 1)] * 1_000;
}

function jitter(ms: number): number {
  if (ms === 0) return 0;
  const factor = 1 + Math.random() * 0.4 - 0.2; // ±20%
  return Math.max(1_000, Math.floor(ms * factor));
}

const FALLBACK_TIER_START = 8; // fib(8) = 34s
const TICKET_REFRESH_INTERVAL = 3; // every 3rd fallback attempt

export type GlobalReconnectCallback = () => void | Promise<void>;

export class GlobalReconnectionManager {
  private socket: Socket | null = null;
  private fibIndex = 0;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attemptCount = 0;
  private onReconnected: GlobalReconnectCallback;

  constructor(onReconnected: GlobalReconnectCallback) {
    this.onReconnected = onReconnected;
  }

  // ── Public API ──────────────────────────────────────────────────

  start(socket: Socket): void {
    this.socket = socket;
    this.stopped = false;
    this.fibIndex = 0;
    this.attemptCount = 0;

    socket.io.on("reconnect", this.handleReconnect);
    socket.io.on("reconnect_failed", this.handleReconnectFailed);
  }

  stop(): void {
    this.stopped = true;
    this.clearFallbackTimer();
    if (this.socket) {
      this.socket.io.off("reconnect", this.handleReconnect);
      this.socket.io.off("reconnect_failed", this.handleReconnectFailed);
      this.socket = null;
    }
  }

  forceReconnect(): void {
    if (this.stopped) return;
    this.clearFallbackTimer();

    if (this.socket) {
      this.socket.io.off("reconnect", this.handleReconnect);
      this.socket.io.off("reconnect_failed", this.handleReconnectFailed);
      this.socket.disconnect();
      this.socket = null;
    }

    this.fibIndex = 0;
    this.attemptCount = 0;

    void this.createFreshConnection().catch(() => {
      if (!this.stopped) {
        this.fibIndex = FALLBACK_TIER_START;
        this.scheduleFallbackAttempt();
      }
    });
  }

  // ── Event handlers ──────────────────────────────────────────────

  private handleReconnect = (): void => {
    if (this.stopped) return;
    this.fibIndex = 0;
    this.attemptCount = 0;
    void this.onReconnected();
  };

  private handleReconnectFailed = (): void => {
    if (this.stopped) return;
    if (this.socket) {
      this.socket.io.off("reconnect", this.handleReconnect);
      this.socket.io.off("reconnect_failed", this.handleReconnectFailed);
      this.socket = null;
    }
    this.fibIndex = FALLBACK_TIER_START;
    this.scheduleFallbackAttempt();
  };

  // ── Tier 2 fallback loop ────────────────────────────────────────

  private scheduleFallbackAttempt(): void {
    if (this.stopped) return;
    const delay = jitter(fibMs(this.fibIndex));
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.stopped) return;
      void this.fallbackAttempt();
    }, delay);
  }

  private async fallbackAttempt(): Promise<void> {
    if (this.stopped) return;
    try {
      this.attemptCount++;
      await this.createFreshConnection();
    } catch {
      this.fibIndex++;
      this.scheduleFallbackAttempt();
    }
  }

  private async createFreshConnection(): Promise<void> {
    const res = await fetch("/api/ws/user-ticket", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error("Failed to obtain user WS ticket for reconnect");
    }
    const data = await res.json();

    const freshSocket = io(data.wsUrl, {
      auth: { ticket: data.ticket },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 21_000,
      randomizationFactor: 0.2,
    });

    freshSocket.io.on("reconnect", this.handleReconnect);
    freshSocket.io.on("reconnect_failed", this.handleReconnectFailed);

    this.socket = freshSocket;
    setGlobalSocket(freshSocket);
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}
