/**
 * Singleton, room-agnostic outbox retry worker.
 *
 * Polls IndexedDB every 2 seconds for eligible entries across ALL rooms.
 * Groups entries by roomId, flushes each group sequentially.
 * Different rooms flush in parallel.
 *
 * Socket connectivity guard: checks before transmit.
 * IN_FLIGHT guard: prevents duplicate concurrent transmits per clientMessageId.
 */

import {
  type OutboxEntry,
  getAllEligibleRetryEntries,
  updateOutboxEntry,
  deleteOutboxEntry,
  getEligibleRetryEntries,
  getFailedEntriesOlderThan,
} from "@/lib/outbox-db";
import { getGlobalSocket } from "@/lib/socket-client";
import {
  getNextRetryAt,
  flushRotationQueue,
} from "@/lib/outbox-worker";

type TransmitResult = "sent" | "failed" | "retry";
type TransmitFn = (entry: OutboxEntry) => Promise<TransmitResult>;

const WORKER_POLL_MS = 2_000;
const CLEANUP_POLL_MS = 60 * 60 * 1_000; // 1 hour

async function cleanupStaleFailedEntries(): Promise<void> {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1_000;
  const stale = await getFailedEntriesOlderThan(cutoffMs);
  for (const entry of stale) {
    await deleteOutboxEntry(entry.clientMessageId);
  }
}

export class GlobalOutboxWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private _isRunning = false;
  private transmit: TransmitFn;

  constructor(transmit: TransmitFn) {
    this.transmit = transmit;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;

    void cleanupStaleFailedEntries().catch(() => undefined);

    this.intervalId = setInterval(() => void this.tick(), WORKER_POLL_MS);
    this.cleanupIntervalId = setInterval(
      () => void cleanupStaleFailedEntries().catch(() => undefined),
      CLEANUP_POLL_MS
    );
  }

  stop(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId);
    if (this.cleanupIntervalId !== null) clearInterval(this.cleanupIntervalId);
    this.intervalId = null;
    this.cleanupIntervalId = null;
    this._isRunning = false;
    this.inFlight.clear();
  }

  /** Drain all rooms immediately — called after reconnect. */
  async flushImmediate(): Promise<void> {
    await this.tick();
  }

  /** Drain a specific room immediately — called when a room page opens. */
  async flushRoomImmediate(roomId: string): Promise<void> {
    const now = Date.now();
    const eligible = await getEligibleRetryEntries(roomId, now);
    for (const entry of eligible) {
      if (this.inFlight.has(entry.clientMessageId)) continue;
      this.inFlight.add(entry.clientMessageId);
      void this.attempt(entry).finally(() => {
        this.inFlight.delete(entry.clientMessageId);
      });
    }
  }

  private async tick(): Promise<void> {
    if (!this._isRunning) return;

    // Connectivity guard
    const s = getGlobalSocket();
    if (!s?.connected) return;

    const now = Date.now();
    const eligible = await getAllEligibleRetryEntries(now);

    // Group by roomId — flush sequentially within each room, parallel across rooms
    const byRoom = new Map<string, OutboxEntry[]>();
    for (const entry of eligible) {
      if (this.inFlight.has(entry.clientMessageId)) continue;
      const list = byRoom.get(entry.roomId) || [];
      list.push(entry);
      byRoom.set(entry.roomId, list);
    }

    await Promise.all(
      Array.from(byRoom.values()).map(async (entries) => {
        for (const entry of entries) {
          if (this.inFlight.has(entry.clientMessageId)) continue;
          this.inFlight.add(entry.clientMessageId);
          await this.attempt(entry).finally(() => {
            this.inFlight.delete(entry.clientMessageId);
          });
        }
      })
    );
  }

  private async attempt(entry: OutboxEntry): Promise<void> {
    const result = await this.transmit(entry);
    if (result === "sent") {
      await deleteOutboxEntry(entry.clientMessageId);
    } else if (result === "retry") {
      const nextRetry = entry.retryCount + 1;
      if (nextRetry < entry.maxRetries) {
        await updateOutboxEntry(entry.clientMessageId, {
          status: "RETRYING",
          retryCount: nextRetry,
          nextRetryAt: getNextRetryAt(nextRetry),
          updatedAt: Date.now(),
        });
      } else {
        await updateOutboxEntry(entry.clientMessageId, {
          status: "FAILED",
          failedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    } else {
      await updateOutboxEntry(entry.clientMessageId, {
        status: "FAILED",
        failedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
}
