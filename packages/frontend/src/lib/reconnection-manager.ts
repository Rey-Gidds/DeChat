/**
 * Two-tier Fibonacci reconnection manager.
 *
 * Tier 1 — Socket.IO's built-in reconnection loop:
 *   10 attempts with Fibonacci-like delays (1s → 21s cap via
 *   reconnectionDelay / reconnectionDelayMax / randomizationFactor).
 *
 * Tier 2 — ReconnectionManager fallback:
 *   Takes over when Socket.IO exhausts all 10 attempts and fires
 *   "reconnect_failed". Continues the Fibonacci sequence from fib(8)=34s
 *   upward, capped at fib(14)=610s (~10 minutes). Every 3rd attempt
 *   fetches a fresh WS ticket. Uses setTimeout — cleared immediately
 *   when forceReconnect() is called.
 *
 * forceReconnect():
 *   Kills the current socket (including any in-progress Socket.IO retry),
 *   clears the fallback timeout, fetches a fresh ticket, and creates a
 *   brand new io() connection. Sequence resets to index 0 on success.
 */

import { io, Socket } from "socket.io-client";
import { ACK_TIMEOUT_MS } from "./socket-client";
import { setSocket } from "./socket-client";

// ── Fibonacci helpers ─────────────────────────────────────────────────

const FIB: number[] = (() => {
  const seq = [1, 1];
  while (seq.length < 16) seq.push(seq[seq.length - 1] + seq[seq.length - 2]);
  return seq;
})();

function fibMs(index: number): number {
  const i = Math.min(index, FIB.length - 1);
  return FIB[i] * 1_000;
}

function jitter(ms: number): number {
  if (ms === 0) return 0;
  const factor = 1 + Math.random() * 0.4 - 0.2; // ±20%
  return Math.max(1_000, Math.floor(ms * factor));
}

// ── Config ────────────────────────────────────────────────────────────

const FALLBACK_TIER_START = 8;  // fib(8) = 34s

// ── ReconnectionManager ───────────────────────────────────────────────

export class ReconnectionManager {
  private roomId: string;
  private onReconnected: () => void | Promise<void>;
  private socket: Socket | null = null;
  private fibIndex = 0;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(roomId: string, onReconnected: () => void | Promise<void>) {
    this.roomId = roomId;
    this.onReconnected = onReconnected;
  }

  // ── Public API ──────────────────────────────────────────────────────

  start(socket: Socket): void {
    this.socket = socket;
    this.stopped = false;
    this.fibIndex = 0;

    this.socket.io.on("reconnect", this.handleReconnect);
    this.socket.io.on("reconnect_failed", this.handleReconnectFailed);
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

  /**
   * Called by AppLifecycle when the app returns to the foreground.
   * Immediately cancels the fallback timer, kills the current socket,
   * fetches a fresh ticket, and creates a new io().
   */
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

    void this.createFreshConnection().catch(() => {
      if (!this.stopped) {
        this.fibIndex = FALLBACK_TIER_START;
        this.scheduleFallbackAttempt();
      }
    });
  }

  // ── Event handlers ──────────────────────────────────────────────────

  private handleReconnect = async (): Promise<void> => {
    if (this.stopped || !this.socket) return;

    // Re-join the room
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("join_room timeout")), ACK_TIMEOUT_MS);
        this.socket!.timeout(ACK_TIMEOUT_MS).emit(
          "join_room",
          { roomId: this.roomId },
          (err: unknown, response: { ok: boolean; error?: string }) => {
            clearTimeout(timeout);
            if (err || !response?.ok) {
              reject(new Error(response?.error || "join_room failed on reconnect"));
            } else {
              resolve();
            }
          }
        );
      });
    } catch (err) {
      console.warn("[reconnection] join_room on reconnect failed:", err);
    }

    this.fibIndex = 0;
    if (!this.stopped) {
      await this.onReconnected();
    }
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

  // ── Tier 2 fallback loop ────────────────────────────────────────────

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
      await this.createFreshConnection();
      // If we get here, createFreshConnection resolved — but the socket
      // won't fire "reconnect" until it actually connects. Socket.IO's
      // built-in loop will call handleReconnect when it succeeds, or
      // handleReconnectFailed if it exhausts 10 attempts again.
    } catch {
      this.fibIndex++;
      this.scheduleFallbackAttempt();
    }
  }

  private async createFreshConnection(): Promise<void> {
    const res = await fetch("/api/ws/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ roomId: this.roomId }),
    });

    if (!res.ok) {
      throw new Error("Failed to obtain WS ticket for reconnect");
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
    setSocket(freshSocket);
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}
