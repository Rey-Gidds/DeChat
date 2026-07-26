/**
 * Background retry worker for the durable message outbox.
 *
 * Polls IndexedDB every 2 seconds for eligible outbox entries and retries
 * them with exponential backoff. Also handles rotation-queue flushing and
 * stale cleanup.
 */

import {
  type OutboxEntry,
  getEligibleRetryEntries,
  getAllPendingEntries,
  updateOutboxEntry,
  deleteOutboxEntry,
  getRotationQueuedEntries,
  getFailedEntriesOlderThan,
  evictOldestFailedEntries,
} from "@/lib/outbox-db";
import { encryptMessagePreview } from "./quoted-message";

// ── Retry Schedule ──────────────────────────────────────────────────

const RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length; // 5
const WORKER_POLL_MS = 2_000;
const CLEANUP_POLL_MS = 60 * 60 * 1_000;
const MAX_ROTATION_AGE_MS = 5 * 60 * 1_000;

function withJitter(delayMs: number): number {
  if (delayMs === 0) return 0;
  const factor = 1 + Math.random() * 0.4 - 0.2; // ±20%
  return Math.max(1_000, Math.floor(delayMs * factor));
}

export function getNextRetryAt(retryCount: number): number {
  const delayIndex = Math.min(retryCount, RETRY_DELAYS_MS.length - 1);
  const baseDelay = RETRY_DELAYS_MS[delayIndex];
  return Date.now() + withJitter(baseDelay);
}

// ── Manual Retry ───────────────────────────────────────────────────

/**
 * Resets a failed entry's retry schedule for immediate re-attempt.
 */
export async function manualRetry(clientMessageId: string): Promise<void> {
  await updateOutboxEntry(clientMessageId, {
    status: "RETRYING",
    retryCount: 0,
    nextRetryAt: 0,
    failedAt: undefined,
    updatedAt: Date.now(),
  });
}

// ── Stale Cleanup ──────────────────────────────────────────────────

/**
 * Deletes FAILED entries older than the cutoff (default: 24 hours).
 */
async function cleanupStaleFailedEntries(): Promise<void> {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1_000;
  const stale = await getFailedEntriesOlderThan(cutoffMs);
  for (const entry of stale) {
    await deleteOutboxEntry(entry.clientMessageId);
  }
}

// ── Flush Rotation Queue ───────────────────────────────────────────

/**
 * Re-encrypts rotation-queued entries with the new key and promotes them
 * to regular outbox entries (isRotationQueued → false, nextRetryAt → 0).
 * Discards entries older than 5 minutes.
 */
export async function flushRotationQueue(
  roomId: string,
  newKeyVersion: number,
  encryptMessage: (
    plaintext: string,
    key: CryptoKey
  ) => Promise<{ ciphertext: string; iv: string; authTag: string }>,
  getRoomKey: (
    roomId: string,
    version: number
  ) => Promise<CryptoKey | null>
): Promise<void> {
  const entries = await getRotationQueuedEntries(roomId);
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.plaintextBody) continue;

    // Discard entries older than 5 minutes
    if (now - entry.createdAt > MAX_ROTATION_AGE_MS) {
      await updateOutboxEntry(entry.clientMessageId, {
        status: "FAILED",
        failedAt: now,
        updatedAt: now,
      });
      continue;
    }

    const newKey = await getRoomKey(roomId, newKeyVersion);
    if (!newKey) continue;

    const reEncrypted = await encryptMessage(entry.plaintextBody, newKey);
    
    let replyTo = entry.replyTo;
    if (replyTo && entry.replyToPlaintextPreview) {
      try {
        const previewEncrypted = await encryptMessagePreview(
          entry.replyToPlaintextPreview,
          replyTo.messageType,
          newKey
        );
        replyTo = {
          ...replyTo,
          previewIv: previewEncrypted.previewIv,
          previewCiphertext: previewEncrypted.previewCiphertext,
          previewAuthTag: previewEncrypted.previewAuthTag,
        };
      } catch (err) {
        console.warn("Failed to encrypt reply preview in rotation flush:", err);
      }
    }

    await updateOutboxEntry(entry.clientMessageId, {
      ciphertext: reEncrypted.ciphertext,
      iv: reEncrypted.iv,
      authTag: reEncrypted.authTag,
      roomKeyVersion: newKeyVersion,
      isRotationQueued: false,
      plaintextBody: undefined,
      replyTo,
      replyToPlaintextPreview: undefined,
      status: "PENDING",
      nextRetryAt: 0,
      updatedAt: now,
    });
  }
}

// ── Retry Worker ───────────────────────────────────────────────────

export type TransmitResult = "sent" | "failed" | "retry";
export type TransmitFn = (entry: OutboxEntry) => Promise<TransmitResult>;

/**
 * Singleton-per-room worker that polls IndexedDB and retries eligible
 * outbox entries. Stops cleanly on room unmount.
 */
export class OutboxRetryWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();
  private _isRunning = false;

  constructor(
    private roomId: string,
    private transmit: TransmitFn
  ) {}

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;

    // Initial cleanup on start
    void cleanupStaleFailedEntries().catch(() => undefined);

    // Worker poll: every 2 seconds
    this.intervalId = setInterval(() => void this.tick(), WORKER_POLL_MS);

    // Cleanup poll: every hour
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

  /**
   * Called immediately when socket reconnects — skips the 2s poll delay
   * and flushes ALL pending entries regardless of nextRetryAt schedule.
   */
  async flushImmediate(): Promise<void> {
    const eligible = await getAllPendingEntries(this.roomId);
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
    const now = Date.now();
    const eligible = await getEligibleRetryEntries(this.roomId, now);
    for (const entry of eligible) {
      if (this.inFlight.has(entry.clientMessageId)) continue;
      this.inFlight.add(entry.clientMessageId);
      void this.attempt(entry).finally(() => {
        this.inFlight.delete(entry.clientMessageId);
      });
    }
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