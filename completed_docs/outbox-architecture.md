# DeChat — Durable Message Outbox Architecture

**Status:** AWAITING APPROVAL  
**Target:** Replace the in-memory failed message queue with a production-grade IndexedDB-backed outbox system  
**Scope:** Client-side only (no database schema changes) — the server's `room_messages` collection is unchanged

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Current Flow Diagram](#2-current-flow-diagram)
3. [Identified Weaknesses](#3-identified-weaknesses)
4. [Proposed Architecture Overview](#4-proposed-architecture-overview)
5. [IndexedDB Schema Design](#5-indexeddb-schema-design)
6. [Message Lifecycle & State Machine](#6-message-lifecycle--state-machine)
7. [WebSocket Acknowledgement Protocol Changes](#7-websocket-acknowledgement-protocol-changes)
8. [Retry Strategy & Exponential Backoff](#8-retry-strategy--exponential-backoff)
9. [Background Retry Worker](#9-background-retry-worker)
10. [Reconnect Strategy](#10-reconnect-strategy)
11. [Plaintext Queue vs Encrypted Outbox (Key Rotation Separation)](#11-plaintext-queue-vs-encrypted-outbox-key-rotation-separation)
12. [Timeline Ordering Strategy](#12-timeline-ordering-strategy)
13. [Optimistic UI Integration](#13-optimistic-ui-integration)
14. [UI Changes](#14-ui-changes)
15. [Cleanup Strategy](#15-cleanup-strategy)
16. [Migration Strategy](#16-migration-strategy)
17. [Edge Case Analysis](#17-edge-case-analysis)
18. [Pagination Implications](#18-pagination-implications)
19. [Affected Files](#19-affected-files)
20. [Commit Breakdown](#20-commit-breakdown)
21. [Open Questions](#21-open-questions)

---

## 1. Current Architecture Analysis

### Current Messaging Flow (Optimistic Path)

When a user sends a text message today:

1. **`onSend()`** in `page.tsx:685` is called.
2. If `isRotating`, the message is queued in-memory via `queueMessageForRotation()` in `key-rotation.ts:128`.
   - Queue lives in `let messageQueueMap = new Map<string, PendingMessage[]>()` at module level — pure JavaScript heap memory.
3. If NOT rotating, `encryptMessage()` is called → then `sendEncryptedMessage()` is called via Socket.IO `send_message` event with a **7-second ACK timeout** (`ACK_TIMEOUT_MS = 7_000`).
4. The server receives the event, calls `persistEncryptedMessage()`, broadcasts `room_message` to all room members, and ACKs with `{ ok: true, message: outbound }`.
5. The client receives the ACK, calls `appendDecrypted([response.message])` which merges the persisted message into the UI.
6. **There is no optimistic rendering before transmission** — the user sees nothing until the server ACKs.
7. On failure, `setStatus(err.message)` is called — the message is **completely lost** with no recovery path.

### Current Key Rotation Queue

The `key-rotation.ts` module maintains an **in-memory** `messageQueueMap`:

- Messages queued during rotation are stored as `{ roomId, plaintext, clientMessageId, createdAt }`.
- `flushQueuedMessages()` re-encrypts and sends them after the new room key is ready.
- Messages older than **5 minutes** (`MAX_QUEUE_AGE_MS = 5 * 60 * 1000`) are discarded silently.
- **All queued messages are lost on page refresh, tab close, or browser restart.**
- The `messageQueueRef` in `page.tsx:231` (`Array<{ id: string; status: "sending" | "sent" | "failed" }>`) is entirely unused beyond being pushed to — it drives no UI and is read nowhere.
- `flushQueuedMessages()` uses a **local duplicate** of `sendEncryptedMessage` via a raw `fetch("/api/ws/send-message")` call — an entirely different code path from the Socket.IO `sendEncryptedMessage` in `socket-client.ts`.

### Current `UiMessage` Type (message-list.tsx)

```typescript
export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
  messageType?: "text" | "image" | "video" | "gif";
  mediaMetadata?: MediaMetadata;
  gifMetadata?: GifMetadata;
}
// No status field. No clientMessageId. No concept of optimistic state.
```

### Current `OutboundEncryptedMessage` (socket-client.ts)

```typescript
export interface OutboundEncryptedMessage {
  roomId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  roomKeyVersion?: number;
  messageType?: "text" | "image" | "video" | "gif";
}
// No clientMessageId. Server cannot correlate ACK to an optimistic UI entry.
```

### Existing IndexedDB Database (`dechat-crypto-store`, version 3)

Three existing stores:
- `private-keys` — RSA private keys keyed by `userId`
- `room-keys` — AES room keys keyed by `roomId`
- `room-key-versions` — AES keys keyed by `roomId:version` string

The outbox will be added as a **fourth store** via a version bump to **4**.

---

## 2. Current Flow Diagram

```
User Types → onSend() → encryptMessage() → sendEncryptedMessage() ─────────────────────────────┐
                                                                    Socket.IO "send_message"    │
                                                                             │                  │
                                                                   Server: persistEncryptedMessage()
                                                                             │
                                                                   Server: io.to(room).emit("room_message")
                                                                             │
                                                                   Server ACK: { ok, message } │
                                                                             │                  │
                                            appendDecrypted([response.message]) ◄───────────────┘
                                                             │
                                            setMessages(mergeMessages(prev, decrypted))
                                                             │
                                                    Message visible in UI

FAILURE PATH: setStatus(error) → Message permanently LOST
KEY ROTATION PATH: queueMessageForRotation() → in-memory Map → flushQueuedMessages() after key ready
                    └─ LOST on any page close, refresh, or browser restart
```

---

## 3. Identified Weaknesses

| # | Weakness | Severity |
|---|----------|----------|
| 1 | **No optimistic rendering** — UI shows nothing until server ACK | High |
| 2 | **Failed messages permanently lost** — single attempt, no recovery | Critical |
| 3 | **In-memory key rotation queue** — all messages lost on refresh/close | Critical |
| 4 | **No `clientMessageId`** — server ACK cannot be correlated to a specific optimistic message | High |
| 5 | **`messageQueueRef` in `page.tsx` is dead code** — never drives any UI or retry logic | Medium |
| 6 | **No retry backoff** — single attempt, immediate failure declaration | High |
| 7 | **`window.onbeforeunload` warning** — only protects rotation queue, incomplete | Medium |
| 8 | **`flushQueuedMessages()` uses raw `fetch` HTTP path** — inconsistent with socket send path | Medium |
| 9 | **No per-message status indicator** — `isSending` is a single global boolean | Medium |
| 10 | **`mergeMessages()` sorts by client `createdAt`** — no server persistence time used | High |
| 11 | **`roomKeyVersion` not stored in DB** — server `send_message` handler ignores this field | Low (confirmed) |
| 12 | **`EncryptedMessagePayloadType` in `key-rotation.ts:216`** — undefined type reference | Low (bug) |

---

## 4. Proposed Architecture Overview

### New Modules

```
packages/frontend/src/lib/
├── outbox-db.ts          ← IndexedDB CRUD layer for the outbox store
├── outbox-worker.ts      ← Background retry worker + reconnect flush + rotation flush
└── outbox-reconcile.ts   ← Optimistic → persisted message reconciliation helpers
```

### Modified Modules

```
packages/frontend/src/lib/
├── crypto.ts             ← DB_VERSION bump (3 → 4), new store in onupgradeneeded
├── socket-client.ts      ← clientMessageId in OutboundEncryptedMessage + RealtimeRoomMessage
└── key-rotation.ts       ← Remove in-memory map, delegate to outbox-db

packages/frontend/src/components/chat/
├── message-list.tsx      ← UiMessage status fields + status indicators + unsent banner
└── chat-input.tsx        ← Minor: remove full-disable on "sending"

packages/frontend/src/app/rooms/[roomId]/
└── page.tsx              ← Wire outbox lifecycle: send flow, ACK reconcile, worker, banner

packages/websocket-server/src/
└── index.ts              ← Echo clientMessageId in send_message ACK
```

### High-Level Flow (New Architecture)

```
User Types → onSend()
    │
    ├─ 1. Generate clientMessageId = crypto.randomUUID()
    ├─ 2. encryptMessage(draft, roomKey) → { ciphertext, iv, authTag }
    ├─ 3. addToOutbox({ clientMessageId, status: "PENDING", ... })   ← IndexedDB write
    ├─ 4. renderOptimistic(clientMessageId, displayBody)              ← UI update (instant)
    ├─ 5. sendEncryptedMessage({ clientMessageId, ...payload })       ← Socket emit
    │
    ├── ACK SUCCESS ──────────────────────────────────────────────────────────────┐
    │   Server: { ok: true, message: { id, createdAt, clientMessageId, ... } }   │
    │   → deleteOutboxEntry(clientMessageId)                                      │
    │   → reconcileOptimisticMessage(clientMessageId, persistedMessage)           │
    │   → UiMessage: optimistic entry removed, server entry inserted at server ts │
    │                                                                              │
    └── ACK FAILURE (timeout / network / server error) ──────────────────────────┘
        → updateOutboxEntry: status = RETRYING, nextRetryAt = now + backoff[n]
        → UI: subtle "retrying" indicator (no alarm)
        → Background worker picks up on nextRetryAt
        → After maxRetries exhausted → status = FAILED
        → UI: ⚠ "Failed · Retry" on the message bubble
```

---

## 5. IndexedDB Schema Design

### Database

The outbox will live in the **existing** `dechat-crypto-store` IndexedDB database.  
Version bumped: **3 → 4**.

> **Rationale for same DB:** Multiple `indexedDB.open()` calls for the same database name with different versions will conflict. Centralising all stores in one `dechat-crypto-store` DB avoids this. The existing `onupgradeneeded` handler is structured to be safely extended.

### New Object Store: `message-outbox`

**Key path:** `clientMessageId` (inline key — no separate key generator)

```typescript
interface OutboxEntry {
  // ── Identity ──────────────────────────────────────────────────────
  clientMessageId: string;       // crypto.randomUUID() — client-generated primary key
  roomId: string;                // Room this message belongs to

  // ── Encrypted Payload ─────────────────────────────────────────────
  ciphertext: string;            // Base64 AES-256-GCM ciphertext
  iv: string;                    // Base64 IV (12 bytes)
  authTag: string;               // Base64 GCM auth tag (16 bytes)
  roomKeyVersion: number;        // Key version used to encrypt this payload

  // ── Plaintext Fallback (key rotation entries ONLY) ────────────────
  // ONLY populated when isRotationQueued = true.
  // Allows re-encryption after a new room key becomes available.
  // NOT stored for regular network-failure retry entries.
  plaintextBody?: string;
  isRotationQueued: boolean;

  // ── Display Content ───────────────────────────────────────────────
  messageType: "text" | "image" | "video" | "gif";
  displayBody: string;           // Decrypted text for optimistic UI rendering

  // ── Sender Identity ───────────────────────────────────────────────
  senderId: string;              // currentUserId at send time

  // ── Lifecycle State ───────────────────────────────────────────────
  status: "PENDING" | "RETRYING" | "FAILED";
  retryCount: number;            // How many transmission attempts have been made
  nextRetryAt: number;           // Unix ms — epoch when next retry should occur (0 = immediate)
  maxRetries: number;            // Retry ceiling (default: 5 attempts total)

  // ── Timestamps ────────────────────────────────────────────────────
  createdAt: number;             // Unix ms — when the user pressed Send
  updatedAt: number;             // Unix ms — last state transition
  failedAt?: number;             // Unix ms — when status became FAILED (for 24-hour cleanup)
}
```

> **Note:** There is no `SENT` status in the outbox. Upon successful ACK, the entry is **deleted immediately**. `SENT` is a transient UI state displayed on the `UiMessage`, not persisted in the outbox.

### Indexes

```typescript
// Defined inside onupgradeneeded when creating the "message-outbox" store:
const store = db.createObjectStore("message-outbox", { keyPath: "clientMessageId" });

// 1. All outbox entries for a specific room (primary query pattern)
store.createIndex("by-room", "roomId", { unique: false });

// 2. All entries eligible for retry (worker's polling query)
store.createIndex("by-next-retry", "nextRetryAt", { unique: false });

// 3. All entries by status (count failed messages for banner)
store.createIndex("by-status", "status", { unique: false });

// 4. Compound: room + status (efficient banner queries per room)
store.createIndex("by-room-status", ["roomId", "status"], { unique: false });

// 5. Cleanup: find old FAILED entries by their failedAt timestamp
store.createIndex("by-failed-at", "failedAt", { unique: false });
```

### Dual-Mode Entry Design: Network Retry vs Key Rotation Queue

| Field | Network Retry Entry | Key Rotation Entry |
|-------|--------------------|--------------------|
| `isRotationQueued` | `false` | `true` |
| `plaintextBody` | **absent** | **present** (the original plaintext) |
| `ciphertext / iv / authTag` | Present — usable for immediate retry | Present but **stale** — must re-encrypt before sending |
| `roomKeyVersion` | Current version at send time | Old version — replaced after re-encryption |
| Initial `status` | `PENDING` | `PENDING` |
| Retry trigger | `nextRetryAt` elapsed or reconnect | `KEY_ROTATION_COMPLETE` socket event |
| Re-encrypt before sending? | **No** | **Yes** — using the new `roomKeyVersion` |
| `nextRetryAt` while waiting for rotation | N/A | `Infinity` — rotation queue entries are NOT retried by the timer worker |

---

## 6. Message Lifecycle & State Machine

```
              ──────────────────── onSend() ────────────────────
                                       │
                              ┌────────▼────────┐
                              │    PENDING       │  (written to IndexedDB, rendered in UI)
                              └────────┬────────┘
                                       │  sendEncryptedMessage() emitted
                              ┌────────▼────────┐
                              │  Awaiting ACK    │
                              └────┬────────┬───┘
                                   │        │
                          ACK ok   │        │  timeout / error
                                   │        │
                       ┌───────────▼─┐   ┌──▼──────────────────┐
                       │    SENT     │   │  retryCount < max?   │
                       │ (deleted    │   └──┬──────────────┬────┘
                       │  from IDB)  │    YES             NO
                       └─────────────┘     │               │
                                    ┌──────▼──────┐   ┌────▼────┐
                                    │  RETRYING   │   │  FAILED │
                                    │ (nextRetryAt│   │(failedAt│
                                    │  scheduled) │   │  set)   │
                                    └──────┬──────┘   └────┬────┘
                                           │               │
                                    Worker ticks      User clicks
                                    nextRetryAt        "Retry"
                                    elapsed            │
                                           │      ┌────▼─────────────┐
                                    ┌──────▼──┐   │ retryCount = 0   │
                                    │Attempt  │   │ status = RETRYING │
                                    │send     │   │ nextRetryAt = 0   │
                                    └────┬────┘   └──────────────────┘
                                    (loops back to "Awaiting ACK")
```

### State Transitions

| From | To | Trigger |
|------|----|---------|
| — | `PENDING` | User presses Send |
| `PENDING` | *(deleted)* | ACK `{ ok: true }` received |
| `PENDING` | `RETRYING` | ACK timeout or socket error, `retryCount < maxRetries` |
| `PENDING` | `FAILED` | ACK timeout or socket error, `retryCount >= maxRetries` |
| `RETRYING` | *(deleted)* | Retry ACK `{ ok: true }` received |
| `RETRYING` | `RETRYING` | Retry attempt fails, `retryCount < maxRetries` |
| `RETRYING` | `FAILED` | Retry attempt fails, `retryCount >= maxRetries` |
| `FAILED` | `RETRYING` | User clicks manual Retry (resets `retryCount = 0`) |
| `FAILED` | *(deleted)* | 24-hour cleanup job runs |

---

## 7. WebSocket Acknowledgement Protocol Changes

### 7.1 Client → Server: `clientMessageId` Added

```typescript
// socket-client.ts — MODIFIED
export interface OutboundEncryptedMessage {
  roomId: string;
  clientMessageId: string;       // ← NEW: crypto.randomUUID() from client
  ciphertext: string;
  iv: string;
  authTag: string;
  roomKeyVersion?: number;
  messageType?: "text" | "image" | "video" | "gif";
}
```

### 7.2 Server → Client: `clientMessageId` Echoed in ACK Only

```typescript
// websocket-server/src/index.ts — MODIFIED send_message handler
const outbound = {
  id: savedMessage._id,
  roomId,
  senderId: socket.data.userId,
  clientMessageId: payload.clientMessageId,  // ← NEW: echoed back to sender only
  ciphertext,
  iv,
  authTag,
  messageType,
  createdAt: savedMessage.createdAt,
  roomKeyVersion: payload.roomKeyVersion,
  senderName: senderInfo.name,
  senderUserIndex: senderInfo.userIndex,
};

// ACK back to the sender (includes clientMessageId)
ack?.({ ok: true, message: outbound });

// Broadcast to room (clientMessageId stripped — other members have no outbox entry for it)
io.to(`room:${roomId}`).emit("room_message", {
  ...outbound,
  clientMessageId: undefined,
});
```

> **Why strip `clientMessageId` from the broadcast?** Other room members have no outbox entry for the sender's `clientMessageId`. Broadcasting it leaks internal client state and wastes bandwidth. The sender's client handles reconciliation entirely locally.

### 7.3 `RealtimeRoomMessage` Updated

```typescript
// socket-client.ts
export interface RealtimeRoomMessage extends OutboundEncryptedMessage {
  id: string;
  senderId: string;
  roomKeyVersion?: number;
  createdAt: string;
  senderName?: string | null;
  senderUserIndex?: number | null;
  clientMessageId?: string;   // ← NEW: present in ACK only; absent in broadcasts
}
```

### 7.4 Server Validation

The server must validate `clientMessageId` is a non-empty string when present, but must NOT reject messages without one (for backward compatibility during rollout):

```typescript
// websocket-server/src/index.ts
const clientMessageId = typeof payload.clientMessageId === "string"
  ? payload.clientMessageId.slice(0, 64)   // max 64 chars, sanitised
  : null;
```

---

## 8. Retry Strategy & Exponential Backoff

### Retry Schedule

| Attempt | Delay Before This Attempt | Notes |
|---------|--------------------------|-------|
| 1st (initial send) | 0 ms | Immediate on user action |
| 2nd | 5 seconds | First automatic retry |
| 3rd | 15 seconds | |
| 4th | 30 seconds | |
| 5th | 60 seconds | Final automatic retry |
| → FAILED | — | All retries exhausted |

`maxRetries = 5` total attempts (1 initial + 4 retries).

```typescript
// lib/outbox-worker.ts
const RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length; // 5

function getNextRetryAt(retryCount: number): number {
  // retryCount is 0-indexed: 0 = about to make first attempt
  // After the first attempt fails, retryCount becomes 1, so delay is RETRY_DELAYS_MS[1] = 5000
  const delayIndex = Math.min(retryCount, RETRY_DELAYS_MS.length - 1);
  const baseDelay = RETRY_DELAYS_MS[delayIndex];
  return Date.now() + withJitter(baseDelay);
}
```

### Jitter (±20%)

Prevents thunderstorm effect on reconnect when many users simultaneously retry:

```typescript
function withJitter(delayMs: number): number {
  if (delayMs === 0) return 0; // Immediate retries are always immediate
  const factor = 1 + (Math.random() * 0.4 - 0.2); // ±20%
  return Math.max(1_000, Math.floor(delayMs * factor));
}
```

### Retry Count Progression

```
Initial send:  retryCount = 0, nextRetryAt = 0 (immediate)
1st failure:   retryCount = 1, nextRetryAt = now + ~5s
2nd failure:   retryCount = 2, nextRetryAt = now + ~15s
3rd failure:   retryCount = 3, nextRetryAt = now + ~30s
4th failure:   retryCount = 4, nextRetryAt = now + ~60s
5th failure:   retryCount = 5, status → FAILED (no more retries)
```

---

## 9. Background Retry Worker

### Design Goals

- Singleton per room session (not global — each room mount gets its own worker instance).
- Polls IndexedDB every **2 seconds** for eligible entries.
- Never sends a message that is already in-flight.
- Stops cleanly when the room page unmounts.

### Core Worker Class

```typescript
// lib/outbox-worker.ts
export class OutboxRetryWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();   // clientMessageIds currently being sent
  private isRunning = false;

  constructor(
    private roomId: string,
    private transmit: (entry: OutboxEntry) => Promise<"sent" | "failed" | "retry">
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Initial cleanup on start
    void cleanupStaleFailedEntries();
    // Worker poll: every 2 seconds
    this.intervalId = setInterval(() => void this.tick(), 2_000);
    // Cleanup poll: every hour
    this.cleanupIntervalId = setInterval(
      () => void cleanupStaleFailedEntries(),
      60 * 60 * 1_000
    );
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.cleanupIntervalId) clearInterval(this.cleanupIntervalId);
    this.intervalId = null;
    this.cleanupIntervalId = null;
    this.isRunning = false;
    this.inFlight.clear();
  }

  // Called immediately when socket reconnects (skips the 2s poll delay)
  async flushImmediate(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return;
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
    } else if (result === "retry" && entry.retryCount + 1 < entry.maxRetries) {
      await updateOutboxEntry(entry.clientMessageId, {
        status: "RETRYING",
        retryCount: entry.retryCount + 1,
        nextRetryAt: getNextRetryAt(entry.retryCount + 1),
        updatedAt: Date.now(),
      });
    } else {
      await updateOutboxEntry(entry.clientMessageId, {
        status: "FAILED",
        failedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
}
```

### Manual Retry

Manual retry (user clicks "Retry" on a failed message) resets the retry schedule:

```typescript
async function manualRetry(clientMessageId: string): Promise<void> {
  await updateOutboxEntry(clientMessageId, {
    status: "RETRYING",
    retryCount: 0,         // Full retry schedule reset
    nextRetryAt: 0,        // Attempt on next worker tick (immediate)
    failedAt: undefined,   // Clear the failed timestamp
    updatedAt: Date.now(),
  });
  // Worker picks it up within 2 seconds
}
```

---

## 10. Reconnect Strategy

### Trigger

`socket.io.on("reconnect")` already fires `reconnectHandlers` in `socket-client.ts:91`. We extend this:

```typescript
// page.tsx — onSocketReconnect handler (modified)
const offReconnect = onSocketReconnect(async () => {
  void runSync();                          // existing: fetch missed messages
  void worker.flushImmediate();            // NEW: immediately drain eligible outbox entries
});
```

### What `flushImmediate()` Does

On reconnect, the worker's `tick()` is called immediately without waiting for the 2-second polling interval. This means:
- Any `PENDING` entries with `nextRetryAt = 0` are retried at once.
- Any `RETRYING` entries whose `nextRetryAt` has elapsed are retried at once.
- `FAILED` entries are NOT automatically retried on reconnect (they require manual retry or were exhausted intentionally).

### In-Flight Guard on Reconnect

If the socket reconnects while a send is in-flight (the `emitWithAck` promise is still pending):
- The socket's existing `reconnection: true` in `socket-client.ts:87` means Socket.IO re-establishes the connection.
- The pending `emitWithAck` will reject with a timeout (7 seconds).
- The worker will then pick up the entry on its next tick.
- The `inFlight` set prevents double-sending.

---

## 11. Plaintext Queue vs Encrypted Outbox (Key Rotation Separation)

### The Problem

During key rotation, the current room key changes. A message encrypted with the **old key version** cannot be safely retried after rotation completes:
- Other members who only have the new key cannot decrypt old-key ciphertexts.
- The server stores ciphertext opaquely — it does not reject old key versions, but decryption clients will fail.

Therefore, rotation-queued messages must be **re-encrypted with the new key** before transmission.

### Solution: `isRotationQueued` Flag

```
isRotationQueued = false  →  Regular outbox entry
  ┌──────────────────────────────────────────────────────────────────┐
  │  • ciphertext/iv/authTag: valid, encrypted with current key      │
  │  • plaintextBody: absent                                         │
  │  • Retry: emit stored ciphertext directly via socket             │
  │  • Worker trigger: nextRetryAt elapsed or reconnect              │
  └──────────────────────────────────────────────────────────────────┘

isRotationQueued = true   →  Key rotation pending entry
  ┌──────────────────────────────────────────────────────────────────┐
  │  • ciphertext/iv/authTag: stale (encrypted with old key)         │
  │    → stored only so the entry can display displayBody in the UI  │
  │  • plaintextBody: present (the original unencrypted text)        │
  │  • Retry: re-encrypt plaintextBody with new key, then emit       │
  │  • Worker trigger: NOT timer-based. Only on KEY_ROTATION_COMPLETE│
  │  • nextRetryAt: Number.MAX_SAFE_INTEGER (never ticked by worker) │
  └──────────────────────────────────────────────────────────────────┘
```

### New `queueMessageForRotation()` (replaces in-memory version)

```typescript
// lib/outbox-worker.ts (or outbox-db.ts)
export async function queueMessageForRotation(
  roomId: string,
  plaintext: string,
  clientMessageId: string,
  senderId: string,
  staleEncrypted: EncryptedMessagePayload,  // stale ciphertext for display
  oldKeyVersion: number
): Promise<void> {
  await addOutboxEntry({
    clientMessageId,
    roomId,
    ciphertext: staleEncrypted.ciphertext,
    iv: staleEncrypted.iv,
    authTag: staleEncrypted.authTag,
    roomKeyVersion: oldKeyVersion,
    plaintextBody: plaintext,
    isRotationQueued: true,
    messageType: "text",
    displayBody: plaintext,               // plaintext is safe to use for display
    senderId,
    status: "PENDING",
    retryCount: 0,
    nextRetryAt: Number.MAX_SAFE_INTEGER, // never retried by timer
    maxRetries: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
```

### `flushRotationQueue()` Called on `KEY_ROTATION_COMPLETE`

```typescript
// lib/outbox-worker.ts
export async function flushRotationQueue(
  roomId: string,
  newKeyVersion: number,
  getRoomKey: (roomId: string, version: number) => Promise<CryptoKey | null>
): Promise<void> {
  const entries = await getRotationQueuedEntries(roomId);
  const MAX_ROTATION_AGE_MS = 5 * 60 * 1_000; // 5 minutes (matches existing limit)
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
    await updateOutboxEntry(entry.clientMessageId, {
      ciphertext: reEncrypted.ciphertext,
      iv: reEncrypted.iv,
      authTag: reEncrypted.authTag,
      roomKeyVersion: newKeyVersion,
      isRotationQueued: false,    // ← promoted to regular outbox entry
      status: "PENDING",
      nextRetryAt: 0,             // immediate retry
      updatedAt: now,
    });
  }
  // Worker's next tick will pick up these promoted entries
}
```

### Updated `KEY_ROTATION_COMPLETE` Handler in `page.tsx`

```typescript
socket.on("KEY_ROTATION_COMPLETE", async (payload) => {
  if (payload.roomId !== roomId) return;
  setRoomKeyRotation((prev) => ({
    ...prev,
    pendingKeyRotation: false,
    lastKeyVersion: payload.version,
    currentKeyVersion: payload.version,
  }));
  setStatus("Connected");
  setIsRotating(false);
  // NEW: flush rotation-queued outbox entries
  await flushRotationQueue(roomId, payload.version, getRoomKeyVersion);
});
```

---

## 12. Timeline Ordering Strategy

### Core Principle

> **The server's `createdAt` timestamp (MongoDB `new Date()` at insertion time) is the single, authoritative source of truth for ALL message ordering across ALL clients.**

The optimistic UI entry is a **temporary local representation only**. It exists to give immediate feedback. It must never dictate final ordering.

### Optimistic Message Position

While a message is `PENDING` or `RETRYING`:
- It appears at the **visual bottom** of the currently loaded timeline.
- Its `createdAt` is the **client's send time** (a best-effort estimate).
- It carries `id = "optimistic:" + clientMessageId` — a non-ObjectId ID that sorts after all valid MongoDB ObjectIds.

### After ACK — Reconciliation

When ACK arrives with server `createdAt`:

1. We do NOT sort or re-order the message list on the sender's client. The message remains at the exact position it was optimistically rendered (at the bottom of the timeline).
2. Replace the optimistic entry in-place with the persisted message:
   ```typescript
   setMessages((prev) =>
     prev.map((m) =>
       m.id === `optimistic:${clientMessageId}`
         ? toUiMessage(persistedMessage, currentUserId)
         : m
     )
   );
   ```
3. This prevents any sudden layout shift or message jumping for the sender. On page rejoin, refresh, or scrolls, the messages are fetched from the server database in their correct sorted order.

### `mergeMessages()` — Sort Logic for Fetching/Syncing Only

The `mergeMessages()` helper is used for historical fetches, sync runs, and new messages from other users:

```typescript
function mergeMessages(existing: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const msg of incoming) map.set(msg.id, msg);
  // Sort only by time for server-fetched messages. Optimistic messages stay appended at the bottom.
  return Array.from(map.values()).sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
```

### No Autoscroll on New Messages

Do not automatically scroll the chat viewport/timeline to the bottom when a new message (either local optimistic or remote incoming) is added. The user must use the existing down arrow indicator with the message count (already implemented) to scroll down manually.

### Server Must Never Backdate

The server's `persistEncryptedMessage()` uses `new Date()` at the moment of database insertion. It does not accept, store, or use a `clientSentAt` field. This is correct and remains unchanged.

### Loading Outbox Entries on Room Open

When a user opens a room:

1. Fetch the latest 40 persisted messages from the server API.
2. Scroll to the bottom of the persisted messages.
3. Load any outbox entries for this room from IndexedDB.
4. Append outbox entries as optimistic messages **below** the latest server message.
5. **Do NOT scroll to outbox entries.** Preserve the existing scroll-to-bottom behavior for persisted messages.

---

## 13. Optimistic UI Integration

### Optimistic Message Construction

```typescript
// lib/outbox-reconcile.ts
export function buildOptimisticUiMessage(
  entry: OutboxEntry,
  currentUserId: string
): UiMessage {
  return {
    id: `optimistic:${entry.clientMessageId}`,
    clientMessageId: entry.clientMessageId,
    senderId: entry.senderId,
    body: entry.displayBody,
    createdAt: new Date(entry.createdAt).toISOString(),
    isOwn: entry.senderId === currentUserId,
    senderName: null,               // optimistic messages don't have sender enrichment
    senderUserIndex: null,
    messageType: entry.messageType,
    status: entry.status.toLowerCase() as "pending" | "retrying" | "failed",
  };
}
```

### Reconciliation on ACK

```typescript
// lib/outbox-reconcile.ts
export function reconcileOptimisticMessage(
  clientMessageId: string,
  persistedMessage: RealtimeRoomMessage,
  currentUserId: string,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>
): void {
  const persisted = toUiMessage(persistedMessage, currentUserId);
  setMessages((prev) =>
    prev.map((m) => (m.id === `optimistic:${clientMessageId}` ? persisted : m))
  );
}
```

### Implicit Reconciliation via Broadcast (EC-02 Protection)

When `room_message` arrives from `senderId === currentUserId` without a `clientMessageId` (e.g., ACK was lost but broadcast arrived):

```typescript
// page.tsx — room_message handler (extended)
socket.on("room_message", async (incoming: RealtimeRoomMessage) => {
  if (incoming.roomId !== roomId) return;

  if (incoming.senderId === currentUserId) {
    // Attempt ciphertext-based implicit reconciliation
    const matched = await findOutboxEntryByCipherprint(
      roomId,
      incoming.ciphertext.slice(0, 16) + incoming.iv.slice(0, 8)
    );
    if (matched) {
      await deleteOutboxEntry(matched.clientMessageId);
      reconcileOptimisticMessage(matched.clientMessageId, incoming, currentUserId, setMessages);
      return; // Don't double-append
    }
  }

  await appendDecrypted([incoming]);
});
```

---

## 14. UI Changes

### 14.1 Extended `UiMessage` Type

```typescript
// components/chat/message-list.tsx
export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
  messageType?: "text" | "image" | "video" | "gif";
  mediaMetadata?: MediaMetadata;
  gifMetadata?: GifMetadata;
  // ── NEW ────────────────────────────────────────────────────────
  status?: "pending" | "retrying" | "failed";  // absent = sent (normal)
  clientMessageId?: string;                     // for reconciliation lookups
  onRetry?: () => void;                         // manual retry callback
}
```

### 14.2 Per-Message Status Indicators

For `isOwn` messages only, rendered inside `MessageBubble` below the timestamp:

| Status | Visual | Behavior |
|--------|--------|----------|
| `undefined` (sent) | No indicator | Default |
| `"pending"` | Animated grey pulsing dot `●` | Replaces the timestamp area subtly |
| `"retrying"` | Animated amber spinner + "Sending..." in `text-[9px]` | Subtle, no alarm |
| `"failed"` | `⚠` red symbol + `"Failed · Retry"` tappable text | Manual retry on click |

The `⚠ Failed · Retry` text calls `onRetry()` which triggers `manualRetry(clientMessageId)`.

```tsx
// Inside MessageBubble (isOwn messages only):
{message.isOwn && message.status === "pending" && (
  <span className="text-[9px] text-neutral-500 animate-pulse">●</span>
)}
{message.isOwn && message.status === "retrying" && (
  <span className="text-[9px] text-amber-500 animate-pulse">Sending…</span>
)}
{message.isOwn && message.status === "failed" && (
  <button
    onClick={message.onRetry}
    className="text-[9px] text-red-500 hover:text-red-400 transition-colors"
  >
    ⚠ Failed · Retry
  </button>
)}
```

### 14.3 Unsent Messages Banner

Displayed above the `MessageList` (inside the `canChat` block in `page.tsx`) when there are outbox entries **outside the currently loaded scroll window** — i.e., entries that existed before the current session's loaded pages:

```
┌───────────────────────────────────────────────────────────────┐
│  ⚠  2 unsent messages  ·  Retry All  ·  ✕                   │
└───────────────────────────────────────────────────────────────┘
```

**Banner Rules:**
- **Only shown** when `failedOutboxCount > 0` AND those entries are from a previous session (their `clientMessageId` does not appear in the current `messages` state).
- Clicking `Retry All` calls `manualRetry()` on all FAILED entries.
- Clicking `✕` instantly removes all failed messages for the room from IndexedDB, which cleans up the state and ensures the banner does not reappear.
- **Never scroll to these messages automatically.**
- No "jump to" action offered — user may scroll manually.

### 14.4 `ChatInput` — Remove Global Send Lock

Currently `disabled={!canChat || roomDisabled}` and `sending={isSending}` together disable the entire input while a message is sending. With the outbox, users should be able to compose and queue new messages while a previous one is retrying:

```tsx
// BEFORE:
disabled={disabled || sending || mediaSending || !draft.trim()}

// AFTER: only mediaSending blocks the send button; isSending no longer used for gating
disabled={disabled || mediaSending || !draft.trim()}
```

The `isSending` state transitions to a per-message concern tracked via the outbox.

---

## 15. Cleanup Strategy

### Rule 1: Immediate Deletion on ACK

Upon `{ ok: true }` ACK, `deleteOutboxEntry(clientMessageId)` is called immediately. No SENT entries ever persist in the outbox.

### Rule 2: 24-Hour FAILED State TTL

Any entry in `FAILED` state with `failedAt` older than **24 hours** is automatically deleted.

```typescript
// lib/outbox-worker.ts
async function cleanupStaleFailedEntries(): Promise<void> {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1_000;
  const stale = await getFailedEntriesOlderThan(cutoffMs);
  for (const entry of stale) {
    await deleteOutboxEntry(entry.clientMessageId);
    // Remove the corresponding optimistic UiMessage from state (if visible)
    // This is handled via a cleanup callback provided by page.tsx
  }
}
```

**When cleanup runs:**
1. **On room mount** — immediately before the worker starts.
2. **Every hour** — via a secondary `setInterval` inside the worker.

### Rule 3: No Rotation Entries Older Than 5 Minutes

Rotation-queued entries (`isRotationQueued: true`) that are older than **5 minutes** are moved to `FAILED` during `flushRotationQueue()`. This matches the existing `MAX_QUEUE_AGE_MS` behavior.

### Rule 4: Logout Clears All Entries

```typescript
// wherever logout is called — page.tsx or auth flow
async function onLogout() {
  await clearAllOutboxEntries(); // deletes all entries across all rooms
  disconnectSocket();
  // ... rest of logout
}
```

### Rule 5: Quota Exceeded Handling

```typescript
// lib/outbox-db.ts — addOutboxEntry
try {
  await idbPut("message-outbox", entry);
} catch (err) {
  if (err instanceof DOMException && err.name === "QuotaExceededError") {
    // Evict oldest FAILED entries first
    await evictOldestFailedEntries(10);
    // Retry once
    await idbPut("message-outbox", entry);
  } else {
    throw err;
  }
}
```

---

## 16. Migration Strategy

### Server-Side: No Changes to `room_messages` Schema

The MongoDB `room_messages` collection is **not modified**. The `clientMessageId` is a client-side reconciliation token only and is **never stored in the database**.

### Client-Side: IndexedDB Version Bump (3 → 4)

```typescript
// lib/crypto.ts — MODIFIED
const DB_VERSION = 4; // bumped from 3

request.onupgradeneeded = (event) => {
  const db = request.result;
  const oldVersion = event.oldVersion;

  // Existing stores — created only if missing (safe for upgrades from v1/v2/v3)
  if (!db.objectStoreNames.contains("private-keys")) {
    db.createObjectStore("private-keys");
  }
  if (!db.objectStoreNames.contains("room-keys")) {
    db.createObjectStore("room-keys");
  }
  if (!db.objectStoreNames.contains("room-key-versions")) {
    db.createObjectStore("room-key-versions");
  }

  // NEW in v4
  if (!db.objectStoreNames.contains("message-outbox")) {
    const outboxStore = db.createObjectStore("message-outbox", {
      keyPath: "clientMessageId",
    });
    outboxStore.createIndex("by-room", "roomId", { unique: false });
    outboxStore.createIndex("by-next-retry", "nextRetryAt", { unique: false });
    outboxStore.createIndex("by-status", "status", { unique: false });
    outboxStore.createIndex("by-room-status", ["roomId", "status"], { unique: false });
    outboxStore.createIndex("by-failed-at", "failedAt", { unique: false });
  }
};
```

### In-Memory Queue Removal

The following exports from `key-rotation.ts` will be **removed**:
- `messageQueueMap` (module-level `let`)
- `queueMessageForRotation()` — replaced by outbox-backed version
- `getMessageQueue()` — no longer needed
- `clearMessageQueue()` — no longer needed
- `flushQueuedMessages()` — replaced by `flushRotationQueue()`
- Local duplicate `sendEncryptedMessage()` function (lines 192–211)
- Local duplicate `encryptMessage()` function (lines 213–235)

These are consumed by `page.tsx` which will be updated to use the outbox equivalents.

### Dead Code Removal

From `page.tsx`:
- `messageQueueRef` (`useRef<Array<{ id: string; status }>>`) — remove
- `window.onbeforeunload` in the cleanup return — remove (outbox provides durable persistence)

### Rollout Safety

- `clientMessageId` is added as a required field on the client but the server treats it as optional (echoed back if present, ignored if absent). This allows a safe rollout without needing a coordinated server + client deploy.
- The IndexedDB version bump is non-destructive: existing stores are preserved, the new store is added.

---

## 17. Edge Case Analysis

### EC-01: Tab Duplication
**Scenario:** Same room open in two tabs. Both tabs have the outbox worker running.  
**Risk:** Double-send of the same outbox entry.  
**Mitigation:** IndexedDB transactions are atomic. When Tab A ACKs and deletes the entry, Tab B's worker finds it gone on the next tick and skips silently. The `inFlight` Set prevents concurrent sends within a single tab. Cross-tab double-send window is 2 seconds (worker poll interval) — acceptable for text messaging.

### EC-02: ACK Lost, Broadcast Delivered
**Scenario:** Server persists the message and emits `room_message` to the room, but the ACK never reaches the client (socket drops between persist and ACK delivery).  
**Risk:** User sees their message twice — once as optimistic, once from the broadcast.  
**Mitigation:** When `room_message` arrives from `senderId === currentUserId`, attempt ciphertext fingerprint matching against outbox entries. If matched, treat as implicit ACK: delete outbox entry and reconcile. Fingerprint: `ciphertext.slice(0, 16) + iv.slice(0, 8)` (24 chars, collision probability negligible for same-session messages).

### EC-03: Key Rotation During Retry
**Scenario:** A network-retry entry (`isRotationQueued: false`) is in `RETRYING` state. While waiting for the next retry, a key rotation completes, advancing `currentKeyVersion`.  
**Risk:** Retrying with an old key version — other members may not have the old key anymore.  
**Mitigation:** When a key rotation occurs, the outbox worker will iterate through all existing pending/retrying outbox entries for the room, decrypt them using their respective room key versions retrieved from the local `room-key-versions` store, re-encrypt them using the new room key version, and update their entries in the outbox (updating ciphertext, iv, authTag, and roomKeyVersion). This ensures all subsequent retries use the latest room key version.

### EC-04: IndexedDB Quota Exceeded
**Scenario:** Accumulated outbox entries fill the browser's storage quota.  
**Risk:** New messages cannot be queued; `addOutboxEntry` throws.  
**Mitigation:** On `QuotaExceededError`, evict the 10 oldest `FAILED` entries and retry once. If still failing, surface a user-visible warning in the status bar: "Storage full — oldest unsent messages removed." The 24-hour cleanup normally prevents accumulation.

### EC-05: User Logs Out
**Scenario:** User logs out. Outbox entries remain from the session.  
**Risk:** On next login (potentially different user if shared device), stale entries attempt to send with invalid auth.  
**Mitigation:** `clearAllOutboxEntries()` is called during logout before `disconnectSocket()`. The WebSocket ticket is invalidated on logout; any in-flight sends will fail gracefully.

### EC-06: Offline on Page Load
**Scenario:** User opens the room page while offline. Socket never connects. Bootstrap fails.  
**Risk:** Outbox worker never starts; previous session's entries never retry.  
**Mitigation:** The worker only starts after `connectToRoom()` resolves. When the socket eventually connects (after network restoration), `onSocketReconnect` fires `flushImmediate()`. The worker also starts after successful connection. Previous session entries are loaded from IndexedDB and displayed as optimistic messages on room open regardless of connection status.

### EC-07: Media Message Retry
**Scenario:** Image/video message — S3 upload succeeded, but the final socket `send_message` emit failed.  
**Risk:** Media blob is uploaded but the metadata message is lost.  
**Mitigation:** The outbox entry stores the encrypted metadata ciphertext (which includes the S3 `objectKey`). Retrying the socket emit re-sends the existing ciphertext — no re-upload is needed. If the S3 presigned URL expires before the message is delivered, the media link will appear broken — an acceptable edge case for a message that has been failing for >24 hours (when the entry would be cleaned up anyway).

### EC-08: Race — IndexedDB Write vs Socket ACK
**Scenario:** `addOutboxEntry` is async. If the socket ACK arrives before the IndexedDB write completes, the reconciliation handler finds no entry to delete.  
**Mitigation:** Strict ordering in `onSend()`:
```
await addOutboxEntry(entry);           // 1. Persist first
renderOptimistic(entry);                // 2. Update UI
const res = await sendEncryptedMessage(); // 3. Send
if (res.ok) {
  await deleteOutboxEntry(...);         // 4. Clean up
  reconcile(...);                       // 5. Replace in UI
}
```
The `sendEncryptedMessage` call is not made until `addOutboxEntry` resolves. ACK cannot arrive before the entry is written.

### EC-09: `crypto.randomUUID()` Browser Support
**Scenario:** Older browsers may not support `crypto.randomUUID()`.  
**Mitigation:** The existing codebase already uses `window.crypto.subtle` extensively (see `crypto.ts`), implying a modern browser baseline. `crypto.randomUUID()` is supported in Chrome 92+, Firefox 95+, Safari 15.4+. Add a simple polyfill for any gap:
```typescript
const clientMessageId = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
```

### EC-10: Page Crash Mid-Write (Crash Recovery)
**Scenario:** Browser crashes between `addOutboxEntry()` and `sendEncryptedMessage()`. The entry is in `PENDING` state with `nextRetryAt = 0`.  
**Outcome:** On next page load, the outbox worker starts and finds the entry eligible for immediate retry. The message is retried automatically. The user sees it as a "retrying" message — correct behavior.

---

## 18. Pagination Implications

### Server-Paginated History

`fetchMessageHistory()` and `syncMessagesSince()` query the `room_messages` MongoDB collection. They return only **server-persisted** messages. Outbox entries are **not included** in API responses.

### Behavior When Loading Older Pages

`loadOlder()` prepends older server messages to the list. Optimistic/outbox messages remain pinned at the visual bottom of the timeline, unaffected by older page loads. No scroll hijack occurs.

### Behavior When Outbox Entries Exist on Room Open

```
Page loads → fetch latest 40 messages from server
           → scroll to bottom of server messages  (preserving existing behavior)
           → load outbox entries for this room from IndexedDB
           → buildOptimisticUiMessage() for each entry
           → append to messages state
           → DO NOT re-scroll
           → if any entries not in viewport → show unsent banner (§14.3)
```

### After ACK — Pagination Position

Once a message is acknowledged, it gains a server `createdAt` timestamp. On subsequent pagination loads (e.g., user loads older history), the message will appear in its correct chronological position as determined by the server. No special pagination logic is required.

### `nextCursor` Integrity

The `historyCursor` state tracks the cursor for loading older server pages. It is not affected by outbox entries. Outbox entries have `id = "optimistic:..."` which is not a valid MongoDB ObjectId and would never be used as a cursor.

---

## 19. Affected Files

### New Files (3)

| File | Purpose |
|------|---------|
| `packages/frontend/src/lib/outbox-db.ts` | IndexedDB CRUD layer: add, get, update, delete, query entries |
| `packages/frontend/src/lib/outbox-worker.ts` | Retry worker, flush logic, rotation queue flush, cleanup |
| `packages/frontend/src/lib/outbox-reconcile.ts` | Optimistic message builder, ACK reconciler, broadcast reconciler |

### Modified Files (7)

| File | Changes Summary |
|------|----------------|
| `packages/frontend/src/lib/crypto.ts` | `DB_VERSION` 3→4; add `message-outbox` store + 5 indexes in `onupgradeneeded` |
| `packages/frontend/src/lib/socket-client.ts` | `clientMessageId` in `OutboundEncryptedMessage`; `clientMessageId?` in `RealtimeRoomMessage` |
| `packages/frontend/src/lib/key-rotation.ts` | Remove in-memory queue (5 exports deleted); fix `EncryptedMessagePayloadType` bug; remove duplicate local functions |
| `packages/frontend/src/components/chat/message-list.tsx` | Extend `UiMessage`; add status indicators in `MessageBubble`; add `UnsentMessagesBanner` component |
| `packages/frontend/src/components/chat/chat-input.tsx` | Remove `isSending`-based send button disable |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Full outbox lifecycle wiring; updated send flow; ACK reconciliation; worker start/stop; rotation flush trigger; banner state |
| `packages/websocket-server/src/index.ts` | Echo `clientMessageId` in `send_message` ACK; strip from broadcast |

---

## 21. Open Questions

> [!IMPORTANT]
> Please answer or confirm these before implementation begins.

### Q1: `clientMessageId` in Room Broadcasts
Should the `room_message` broadcast to other room members include the sender's `clientMessageId`? Including it would enable cleaner EC-02 (duplicate detection) on the sender's client without ciphertext fingerprinting.  
**My recommendation:** Exclude from broadcast (privacy + bandwidth). Use ciphertext fingerprinting for EC-02.  
**Your preference?** Your recommendation is correct, dont include it in the broadcast.

---

### Q2: `plaintextBody` Security in IndexedDB
Rotation-queued entries store **unencrypted plaintext** in IndexedDB. IndexedDB is accessible by any JavaScript running on the same origin. The private RSA key is also stored in IndexedDB in the same DB.  
Is this security boundary acceptable, or should `plaintextBody` be encrypted before storage (e.g., AES-wrapped with a session-derived key or the user's public key)?  
**My recommendation:** Accept current security boundary — consistent with how private keys are stored. Encrypting `plaintextBody` with the private key that is also in IndexedDB does not meaningfully improve the threat model.  
**Your preference?** This security boundary is acceptable and needs no changes or plainText encryption is not required.

---

### Q3: Media Messages in the Outbox
Should media messages (images, videos, GIFs) be included in the outbox for the final socket emit step?  
- Images/videos: S3 upload + final socket emit. Outbox would only retry the socket emit (no re-upload).  
- GIFs: No upload, just a socket emit of encrypted metadata.  
**My recommendation:** Yes, include all message types. The outbox stores the ciphertext regardless of type.  
**Confirmed?** Yes, include all message types (metadata for gifs, images, videos).

---

### Q4: `maxRetries` Per Message Type
Should media messages have a different retry count than text messages?  
**My recommendation:** Use `maxRetries = 5` for all types in v1. Differentiate in a future iteration.  
**Confirmed?** Current count is perfect.

---

### Q5: `onSend()` Behaviour During Disconnection
Currently if `status !== "Connected"`, the input is disabled (`canChat = false`). With the outbox, should users be able to send messages while disconnected (queued immediately to outbox, retried on reconnect)?  
**My recommendation:** Not in this iteration. Keep `canChat` check. Disconnected sends add complexity and the 7s ACK timeout already handles brief disconnects gracefully.  
**Your preference?** Not in this iteration. Keep `canChat` check.

---

### Q6: `roomKeyVersion` Server Storage
Confirmed in code review: the server's `persistEncryptedMessage()` does NOT store `roomKeyVersion` in the `room_messages` document. The `roomKeyVersion` field in `OutboundEncryptedMessage` is forwarded to the broadcast only for client decryption use. No server-side change is needed regarding this field.  
**Please confirm** this understanding is correct before implementation.

---

### Q7: Logout Flow Location
Where is the user logout currently handled on the frontend? I need to add `clearAllOutboxEntries()` to the logout flow. I did not find an explicit logout trigger in the examined files (only `disconnectSocket()` references).  
**Please point me to the logout handler file/function.**

---

### Q8: TypeScript Bug in `key-rotation.ts`
Line 216 references `EncryptedMessagePayloadType` which is not imported and does not exist in the codebase. The correct type is `EncryptedMessagePayload` exported from `crypto.ts`.  
**Should I fix this in Commit 6 (migration commit)?** → Yes, confirmed.

---

*Document version: 1.0*  
*Created: 2026-06-23*  
*Author: Antigravity (AI coding assistant)*  
*Status: AWAITING APPROVAL — no code changes have been made*
