# WebSocket Fibonacci Reconnection Strategy

## Overview

Augment the existing Socket.IO reconnection with a Fibonacci-delay backoff layer, add app lifecycle detection (foreground/visibility change + online/offline), and implement sequential outbox flushing on reconnect. The reconnection is invisible to the user — no banners, no toasts.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  useAppLifecycle                                                 │
│  - visibilitychange, online/offline                              │
│  - triggers ReconnectionManager.forceReconnect() on foreground   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│  ReconnectionManager (new class)                                 │
│  - Wraps socket.io Manager events                                │
│  - Falls back to Fibonacci when manager exhausts attempts        │
│  - Calls flush callback on successful reconnect                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│  SequentialOutboxFlusher (new class)                             │
│  - Loads all outbox entries sorted by createdAt ASC              │
│  - Sends one at a time, waits for ACK, then sends next           │
│  - On ACK: delete entry + reconcile optimistic → real message    │
│  - On failure: follows existing RETRYING/FAILED state machine    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Files to Create

### 1. `packages/frontend/src/lib/reconnection-manager.ts` — NEW

Fibonacci backoff logic + Socket.IO augmentation.

**Fibonacci sequence:** `[1, 1, 2, 3, 5, 8, 13, 21, 34]` seconds, capped at 34s.
- Each value gets ±20% jitter to avoid thundering herd.
- Sequence resets after a successful connection.
- Adds `reconnectionDelay` and `reconnectionDelayMax` to Socket.IO's Manager opts — this shadows the default exponential backoff with our Fibonacci. Socket.IO still handles the transport-level reconnect loop, but with our delay curve.

**Exported API:**

```ts
export class ReconnectionManager {
  constructor(onReconnected: () => void | Promise<void>)
  start(socket: Socket): void    // begins listening to manager events
  stop(): void                   // tears down listeners
  forceReconnect(): void         // called from lifecycle hook when app foregrounds
}
```

**Behavior:**

1. `start()` — intercepts Socket.IO Manager's `reconnect_attempt` to log, plus:
   - On `reconnect` (success): calls `onReconnected` callback, resets Fibonacci index
   - On `reconnect_failed` (Socket.IO exhausted all 10 attempts): takes over with Fibonacci-based retries — creates new `io()` connection with fresh ticket every Nth attempt (every 3 fib steps) to handle ticket expiry
2. `forceReconnect()` — if socket is disconnected:
   - Optionally disconnects the current socket to force a clean slate
   - Fetches a fresh ticket via `POST /api/ws/ticket`
   - Creates a new `io()` connection
   - Restarts the Fibonacci sequence from index 0
3. When reconnection succeeds, calls `onReconnected`
4. When the socket is intentionally disconnected (user leaves room), the manager stops

**Socket.IO Manager options override:**

```ts
socket = io(wsUrl, {
  auth: { ticket },
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: fib(0) * 1000,         // 1000ms
  reconnectionDelayMax: fib(8) * 1000,      // 34000ms  
  randomizationFactor: 0.2,                  // ±20% jitter
});
```

Socket.IO's internal backoff will approximate Fibonacci since `reconnectionDelay` starts at 1s and doubles-ish (via the randomization factor) until hitting the 34s cap.

---

### 2. `packages/frontend/src/lib/lifecycle.ts` — NEW

App foreground/background + network status detection.

```ts
export type LifecycleCallback = () => void;

export class AppLifecycle {
  constructor(onForeground: LifecycleCallback)
  start(): void
  stop(): void
}
```

**Detects:**
- `document.addEventListener("visibilitychange", ...)` — when `document.visibilityState === "visible"`, trigger `onForeground`
- `window.addEventListener("online", ...)` — trigger `onForeground` when network returns
- `window.addEventListener("offline", ...)` — log only (no action needed)
- Skips duplicate triggers within a 500ms debounce window
- On foreground: checks `socket?.connected` — if disconnected, calls the callback

---

### 3. `packages/frontend/src/lib/outbox-flusher.ts` — NEW

Sequential outbox flushing for guaranteed message delivery order.

```ts
export class SequentialOutboxFlusher {
  constructor(roomId: string, transmit: TransmitFn)
  async flushAll(currentUserId: string): Promise<void>
}
```

**TransmitFn** is the same type from `outbox-worker.ts`:
```ts
type TransmitResult = "sent" | "failed" | "retry";
type TransmitFn = (entry: OutboxEntry) => Promise<TransmitResult>;
```

**flushAll behavior:**
1. Loads ALL outbox entries for the room via `getOutboxEntriesByRoom(roomId)` (no status filter, not just eligible ones)
2. Sorts by `createdAt` ascending
3. For each entry, in sequence:
   - Calls `transmit(entry)` (which encrypts and sends via WebSocket)
   - On `"sent"`: calls `deleteOutboxEntry(entry.clientMessageId)` + calls `reconcileOptimisticMessage(...)` to swap the optimistic UI message with the real one
   - On `"retry"`: updates entry per existing retry schedule → falls into normal worker poll
   - On `"failed"`: marks as FAILED per existing state machine
4. Returns only after ALL entries have been processed
5. If the socket disconnects mid-flush, remaining entries are left for the next flush cycle (no partial state corruption)

---

## Files to Modify

### 4. `packages/frontend/src/lib/socket-client.ts` — MODIFY

**Changes:**
- Expose the Socket.IO Manager options for Fibonacci delays
- Add `reconnectionDelay`, `reconnectionDelayMax`, `randomizationFactor` to the `io()` call in `connectToRoom`
- Export `activeRoomId` getter so the lifecycle hook can check connection state
- Accept a `reconnectCallback` parameter in `connectToRoom` or provide a setter so `ReconnectionManager` registers its callback

### 5. `packages/frontend/src/app/rooms/[roomId]/page.tsx` — MODIFY

**Changes:**

1. Import and instantiate `ReconnectionManager` with a reconnect callback that:
   - Calls `runSync()` (existing message sync)
   - Calls `sequentialFlusher.flushAll(currentUserId)` to drain the outbox

2. Import and instantiate `AppLifecycle` with a foreground callback that calls `reconnectionManager.forceReconnect()`

3. Import and instantiate `SequentialOutboxFlusher` with the room's transmit function

4. In the socket connection bootstrap (after `connectToRoom`):
   - `reconnectionManager.start(socket)`
   - `lifecycle.start()`

5. In the cleanup:
   - `lifecycle.stop()`
   - `reconnectionManager.stop()`
   - Keep existing: `disconnectSocket()`, `workerRef.current?.stop()`

6. Remove the existing `onSocketReconnect` callback that calls `runSync()` and `flushImmediate()` — these are now owned by `ReconnectionManager`

---

## Lifecycle Integration Flow

```
User opens room →
  connectToRoom(roomId) →
    Socket connects, join_room ACK →
      reconnectionManager.start(socket)
      lifecycle.start()
      workerRef.current.start()

App goes to background (OS sleep / tab switch) →
  Socket.IO detects transport close →
    Built-in 10-attempt Fibonacci reconnection begins
    If connection resumes quickly: socket reconnects, no user impact

App stays backgrounded, Socket.IO exhausts 10 attempts →
  reconnectionManager detects "reconnect_failed" →
    Enters poll loop: every Nth Fibonacci step, fetch fresh ticket + new io()

User returns / foregrounds app →
  lifecycle detects visibilitychange / online event →
    Calls reconnectionManager.forceReconnect() →
      Fetches fresh ticket, creates new io() →
        On "reconnect": calls onReconnected callback →
          runSync() to get missed messages
          sequentialFlusher.flushAll() to drain outbox in order
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| **User rapidly switches tabs** | 500ms debounce on visibility change prevents duplicate reconnects |
| **Ticket expires during reconnect** | Every 3rd Fibonacci attempt fetches a fresh ticket |
| **Socket reconnects while flush is running** | Flush loop checks `socket?.connected` before each entry; stops gracefully on disconnect |
| **User intentionally leaves room** | `lifecycle.stop()` + `reconnectionManager.stop()` called on unmount; no reconnect triggered |
| **Network offline → online** | `online` event triggers `forceReconnect()` |
| **Outbox has 50+ messages** | Sequential flush ensures order; each message ACK'd before next sent. Socket is free for real-time messages between flushes since we're using ACK-based emit, not blocking the socket |
| **Key rotation happens while disconnected** | Outbox entries will fail to decrypt — flush catches this, marks as FAILED, user can see the failure |

---

## Verification

1. **Fibonacci backoff timing:**
   - Disconnect WebSocket server, observe reconnect attempts in browser console
   - Delays should follow ~1s, 1s, 2s, 3s, 5s, 8s... with jitter
   - After 10 Socket.IO attempts, our fallback continues

2. **Foreground reconnect:**
   - Open room, switch to another tab for 2+ minutes
   - Switch back — socket should reconnect within ~1s
   - Messages sent while backgrounded should flush

3. **Outbox sequential flush:**
   - Send 3 messages while disconnected
   - Reconnect — all 3 should appear in order, no duplicates
   - Check IndexedDB — outbox entries deleted after successful ACK

4. **Online/offline:**
   - Toggle airplane mode on/off — should trigger reconnect
   - No duplicate connections

5. **Clean unmount:**
   - Leave room — no reconnection attempts continue
   - Navigate to another room — old room's manager stopped, new one started
