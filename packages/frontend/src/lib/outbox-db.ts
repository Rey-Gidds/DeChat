/**
 * IndexedDB CRUD layer for the durable message outbox.
 *
 * Store: "message-outbox" (keyPath: clientMessageId)
 * Database: "dechat-crypto-store" (shared with crypto.ts)
 * DB_VERSION: 4
 *
 * The outbox provides durable storage for messages that have not yet been
 * acknowledged by the server. Entries are deleted on successful ACK.
 * Failed entries are cleaned up after 24 hours.
 */

import { DB_NAME, DB_VERSION } from "@/lib/crypto";
import type { ReplyToInfo } from "./models";

export interface OutboxEntry {
  // ── Identity ──────────────────────────────────────────────────────
  clientMessageId: string;
  roomId: string;
  replyTo?: ReplyToInfo | null;

  // ── Encrypted Payload ─────────────────────────────────────────────
  ciphertext: string;
  iv: string;
  authTag: string;
  roomKeyVersion: number;

  // ── Plaintext Fallback (key rotation entries ONLY) ────────────────
  plaintextBody?: string;
  replyToPlaintextPreview?: string;
  isRotationQueued: boolean;

  // ── Display Content ───────────────────────────────────────────────
  messageType: "text" | "image" | "video" | "gif";
  displayBody: string;

  // ── Sender Identity ───────────────────────────────────────────────
  senderId: string;

  // ── Lifecycle State ───────────────────────────────────────────────
  status: "PENDING" | "RETRYING" | "FAILED";
  retryCount: number;
  nextRetryAt: number;
  maxRetries: number;

  // ── Timestamps ────────────────────────────────────────────────────
  createdAt: number;
  updatedAt: number;
  failedAt?: number;
}

const OUTBOX_STORE = "message-outbox";

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── CRUD Operations ─────────────────────────────────────────────────

export async function addOutboxEntry(entry: OutboxEntry): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      if (req.error?.name === "QuotaExceededError") {
        reject(req.error);
      } else {
        reject(req.error);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOutboxEntry(
  clientMessageId: string
): Promise<OutboxEntry | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const store = tx.objectStore(OUTBOX_STORE);
    const req = store.get(clientMessageId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getOutboxEntriesByRoom(
  roomId: string
): Promise<OutboxEntry[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const store = tx.objectStore(OUTBOX_STORE);
    const index = store.index("by-room");
    const req = index.getAll(roomId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getEligibleRetryEntries(
  roomId: string,
  now: number
): Promise<OutboxEntry[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const store = tx.objectStore(OUTBOX_STORE);
    const index = store.index("by-next-retry");
    const range = IDBKeyRange.upperBound(now);
    const req = index.getAll(range);
    req.onsuccess = () => {
      const entries = (req.result as OutboxEntry[]).filter(
        (e) => e.roomId === roomId && e.status !== "FAILED"
      );
      resolve(entries);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateOutboxEntry(
  clientMessageId: string,
  updates: Partial<OutboxEntry>
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const getReq = store.get(clientMessageId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`Outbox entry ${clientMessageId} not found`));
        return;
      }
      const updated = { ...existing, ...updates, updatedAt: Date.now() };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteOutboxEntry(
  clientMessageId: string
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const req = store.delete(clientMessageId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getRotationQueuedEntries(
  roomId: string
): Promise<OutboxEntry[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const store = tx.objectStore(OUTBOX_STORE);
    const index = store.index("by-room");
    const req = index.getAll(roomId);
    req.onsuccess = () =>
      resolve(
        (req.result as OutboxEntry[]).filter(
          (e) => e.isRotationQueued && e.status !== "FAILED"
        )
      );
    req.onerror = () => reject(req.error);
  });
}

export async function getFailedEntriesOlderThan(
  cutoff: number
): Promise<OutboxEntry[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const store = tx.objectStore(OUTBOX_STORE);
    const index = store.index("by-failed-at");
    const range = IDBKeyRange.upperBound(cutoff);
    const req = index.getAll(range);
    req.onsuccess = () => resolve(req.result as OutboxEntry[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllOutboxEntries(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function evictOldestFailedEntries(
  count: number
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    const store = tx.objectStore(OUTBOX_STORE);
    const index = store.index("by-status");
    const req = index.getAll("FAILED");
    req.onsuccess = () => {
      const entries = (req.result as OutboxEntry[]).sort(
        (a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0)
      );
      const toDelete = entries.slice(0, count);
      for (const entry of toDelete) {
        store.delete(entry.clientMessageId);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}