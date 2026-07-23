# Online/Offline & Presence State Handling

## Overview

The application maintains real-time online/offline presence for room members across three coordinated systems: a client heartbeat, a server-side in-memory presence store with staleness eviction, and a two-tier Fibonacci reconnection strategy for backgrounded apps.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT (room page)                                             │
│                                                                 │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ AppLifecycle     │  │ Reconnection    │  │ Heartbeat     │  │
│  │ visibilitychange │  │ Manager         │  │ 30s interval  │  │
│  │ online event     │  │ Tier 1: built-in│  │ emit("heart-  │  │
│  │ → forceReconnect │  │ Tier 2: fallback│  │ beat")        │  │
│  └──────────────────┘  └─────────────────┘  └───────────────┘  │
│           │                     │                    │          │
│           ▼                     ▼                    ▼          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  Socket.IO Connection                       │ │
│  │  reconnection: true, 10 attempts, 1s→21s Fibonacci + jitter│ │
│  └─────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ WebSocket
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  SERVER (WebSocket)                                             │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              InMemoryPresenceStore                          │ │
│  │  Map<roomId, Map<userId, { connectionCount, lastHeartbeat }>>│ │
│  │                                                             │ │
│  │  connect()     → ++connectionCount, emit PRESENCE_UPDATED   │ │
│  │  disconnect()  → --connectionCount, emit PRESENCE_UPDATED   │ │
│  │  heartbeat()   → update lastHeartbeat                       │ │
│  │  evictStale()  → remove entries > 60s, emit PRESENCE_UPDATED│ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │ Presence API     │  │ Staleness Cleanup (every 30s)        │ │
│  │ /internal/       │  │ evictStale() → PRESENCE_UPDATED      │ │
│  │ presence         │  │ (isOnline: false)                    │ │
│  └──────────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Client Heartbeat

**File:** `packages/frontend/src/lib/socket-client.ts`

A module-level `setInterval` fires every 30 seconds while the user is in a room. Each tick checks `socket?.connected && activeRoomId` and emits a `heartbeat` event with the room ID.

```ts
// socket-client.ts
const HEARTBEAT_INTERVAL_MS = 30_000;

export function startHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (socket?.connected && activeRoomId) {
      socket.emit("heartbeat", { roomId: activeRoomId });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
```

**Lifecycle:** Started after `connectToRoom()` resolves (Phase 4 of bootstrap). Stopped on component unmount (cleanup). Lives for the duration of a single room mount.

---

## 2. Server-Side Presence Store

**File:** `packages/websocket-server/src/presence-store.ts`

### Data Structure

```ts
Map<roomId, Map<userId, { connectionCount: number; lastHeartbeat: number }>>
```

A two-level map keyed by room then user. Each entry tracks how many socket connections a user has to the room and when they last heartbeated.

### Interface

| Method | Description |
|---|---|
| `connect(roomId, userId)` | Increments `connectionCount`. Returns new count. |
| `disconnect(roomId, userId)` | Decrements `connectionCount`. Removes entry at 0. Cleans up empty room maps. Returns new count (0 if removed). |
| `disconnectAll(userId)` | Removes user from all rooms. Returns list of affected roomIds. |
| `heartbeat(roomId, userId)` | Updates `lastHeartbeat` to `Date.now()`. |
| `isOnline(roomId, userId)` | Returns `true` if `connectionCount > 0` AND heartbeat is within 60s. |
| `onlineUsers(roomId)` | Returns `Set<string>` of userIds currently online in the room. |
| `evictStale()` | Scans all entries, removes those with heartbeat older than 60s. Returns list of evicted `{roomId, userId}` pairs. |

### Staleness Threshold

`HEARTBEAT_DRIFT_MS = 60_000` (60 seconds). A user is considered offline when their last heartbeat is older than this threshold. This is the safety net for cases where a socket disconnects unexpectedly without a clean TCP teardown (browser crash, network partition).

### Periodic Cleanup

Every 30 seconds, `evictStale()` runs. For each evicted user, the callback emits `PRESENCE_UPDATED` with `isOnline: false` to the room.

### Connection Counting

`connect()` and `disconnect()` are **counted**, not boolean. A user opening two tabs to the same room has `connectionCount: 2`. When one tab closes, `disconnect()` decrements to 1 — the user stays online. Only when `connectionCount` hits 0 is the user marked offline.

---

## 3. PRESENCE_UPDATED Event Flow

### When PRESENCE_UPDATED is emitted (server side)

| Trigger | `isOnline` | Emitted to |
|---|---|---|
| User joins room (`join_room` handler) | `true` | `room:<roomId>` |
| User leaves room (`leave_room` handler) | `false` if `remaining ≤ 0` | `room:<roomId>` |
| Socket disconnects (`disconnect` handler) | `false` if `remaining ≤ 0` | Each joined room |
| Staleness eviction (every 30s) | `false` | Each affected room |

### Disconnect Handler (server side)

```ts
// websocket-server/src/index.ts
socket.on("disconnect", () => {
  const userId = socket.data.userId;
  for (const roomId of socket.data.joinedRooms) {
    const remaining = presence.disconnect(roomId, userId);
    const isOnline = remaining > 0;
    io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", { roomId, userId, isOnline });
  }
  socket.data.joinedRooms.clear();
});
```

### Client-Side Receiver

```ts
// page.tsx
socket.on("PRESENCE_UPDATED", (payload) => {
  if (payload.roomId !== roomId) return;
  setOnlineUserIds((prev) => {
    const next = new Set(prev);
    if (payload.isOnline) next.add(payload.userId);
    else next.delete(payload.userId);
    return next;
  });
});
```

`onlineUserIds` is a `Set<string>` in React state, passed to `RoomOptionsPage` where each member gets a green/neutral online indicator dot.

---

## 4. Initial Presence Population (REST)

On room bootstrap, the members list is fetched via REST:

```
GET /api/rooms/<roomId>/members
```

The handler in `members/route.ts` does two things:
1. Queries MongoDB for all APPROVED, non-blocked memberships
2. **Calls out to the WebSocket server's internal endpoint:**

```ts
// GET /internal/presence?roomId=<roomId>
// Authenticated: x-internal-secret header
// Timeout: 2 seconds (best-effort)
// Response: { onlineUserIds: string[] }
```

The result is merged per-member as `isOnline: onlineUserIds.has(m.userId)`. Back in the frontend, the initial `onlineUserIds` set is built from `members.filter(m => m.isOnline).map(m => m.userId)`.

After this initial load, live `PRESENCE_UPDATED` events keep the set in sync.

The `refreshMembers()` callback (used after kickouts, role changes) re-fetches and rebuilds `onlineUserIds` the same way.

---

## 5. Reconnection Strategy

**Files:** `packages/frontend/src/lib/reconnection-manager.ts`, `packages/frontend/src/lib/socket-client.ts`

### Tier 1 — Socket.IO Built-In Reconnection

Configured in the `io()` call:

```ts
socket = io(wsUrl, {
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1_000,       // start at 1s
  reconnectionDelayMax: 21_000,   // cap at 21s
  randomizationFactor: 0.2,       // ±20% jitter
});
```

This gives 10 automatic retries with delays that grow via Socket.IO's internal backoff (approximating Fibonacci), capped at 21 seconds. This handles transient network blips (Wi-Fi handoff, brief tunnel loss).

### Tier 2 — ReconnectionManager Fallback

When Socket.IO exhausts all 10 attempts, it fires `reconnect_failed`. The `ReconnectionManager` takes over with its own `setTimeout`-based loop:

| Attempt | Delay | Notes |
|---|---|---|
| fib(8) = 34s | ~34s ± 20% | First fallback attempt |
| fib(9) = 55s | ~55s ± 20% | |
| fib(10) = 89s | ~89s ± 20% | |
| fib(11) = 144s | ~144s ± 20% | |
| fib(12) = 233s | ~233s ± 20% | |
| fib(13) = 377s | ~377s ± 20% | |
| fib(14) = 610s | ~10 min ± 20% | Cap — all subsequent attempts use 610s |

The sequence continues from where Tier 1 left off (fibIndex 8). Every attempt creates a **brand new `io()` connection** with a **fresh WS ticket** fetched from `POST /api/ws/ticket`. If the fresh `io()` also fails its 10 attempts, `reconnect_failed` fires again, advancing to the next Fibonacci step.

The sequence resets to index 0 after any successful connection.

### forceReconnect()

Called by `AppLifecycle` when the app returns to the foreground:

1. **Immediately clears** any in-flight `setTimeout` from the Tier 2 fallback
2. Disconnects the current socket (killing any in-progress Tier 1 retries)
3. Unregisters event listeners from the old socket
4. Fetches a fresh WS ticket
5. Creates a brand new `io()` connection
6. Resets `fibIndex` to 0

### On Reconnect Success

The `ReconnectionManager.handleReconnect` handler:
1. Emits `join_room` with ACK to re-register on the server
2. Server calls `presence.connect()` → broadcasts `PRESENCE_UPDATED(isOnline: true)`
3. Calls the `onReconnected` callback: `runSync()` (catches up missed messages) + `worker.flushImmediate()` (retries pending outbox messages)

---

## 6. AppLifecycle (Foreground Detection)

**File:** `packages/frontend/src/lib/lifecycle.ts`

Detects when the user returns to the app after backgrounding:

| Event | Trigger | Action |
|---|---|---|
| `visibilitychange` | `document.visibilityState === "visible"` | Check socket state → if disconnected, call `forceReconnect()` |
| `online` | Network comes back online | Same check → `forceReconnect()` |

Both triggers are debounced with a 500ms window. If the socket is already connected, nothing happens (no unnecessary reconnect).

The lifecycle is **per-room**: one `AppLifecycle` instance per room mount, started after `connectToRoom()` succeeds, stopped on unmount.

---

## 7. Typing Indicator

**File:** `packages/frontend/src/app/rooms/[roomId]/page.tsx` (function `onDraftChange`)

### Client-Side Auto-Stop (900ms timeout)

| Trigger | Action |
|---|---|
| User types (non-empty) | Emit `typing_start` → reset 900ms timer |
| Each keystroke | Clear previous timer → emit `typing_start` → set new 900ms timer |
| 900ms of inactivity | Emit `typing_stop` |
| User clears input | Immediately emit `typing_stop` |
| User sends message | Explicit `typing_stop` in `onSend()` |

### Event Flow

1. Client A types → emits `typing_start({ roomId, preview })` via Socket.IO
2. Server receives `typing_start` → broadcasts `typing_started` to `socket.to(room:<roomId>)` (excluding sender)
3. Other clients receive `typing_started` → add `userId` to `typingUsers` array
4. 900ms pass or user stops → Client A emits `typing_stop`
5. Server broadcasts `typing_stopped` to other clients
6. Other clients remove `userId` from `typingUsers`

### Typing Display

```ts
const typingSummary =
  typingUsers.length === 0 ? ""
  : typingUsers.length === 1 ? "Someone is typing..."
  : `${typingUsers.length} people are typing...`;
```

Rendered below the message list. No names or preview text shown — only count.

### Known Limitation

No `typing_stop` is sent on socket disconnect. If a user abruptly closes their tab while typing, their typing indicator persists on other clients until overwritten by a new event from someone else. There is no server-side typing timeout.

---

## 8. End-to-End Lifecycle Flow

```
USER OPENS ROOM
  │
  ├─ Phase 0: Render from IndexedDB cache
  ├─ Phase 1: REST fetch room meta + membership + resume sync
  ├─ Phase 2: Key unwrapping
  ├─ Phase 3: Apply resume result
  └─ Phase 4: connectToRoom(roomId)
       │
       ├─ GET /api/ws/ticket → io(wsUrl, ticket)
       ├─ On "connect": emit join_room → presence.connect()
       │   └─ Server broadcasts PRESENCE_UPDATED(isOnline: true)
       ├─ startHeartbeat() → 30s heartbeat emit
       ├─ ReconnectionManager.start(socket)
       │   └─ Listens: "reconnect" / "reconnect_failed"
       ├─ AppLifecycle.start()
       │   └─ Listens: visibilitychange / online
       └─ Register listeners: room_message, typing, presence, edits, deletes, keys
       
USER DISCONNECTS (background / network loss / tab close)
  │
  ├─ Server: "disconnect" handler fires
  │   ├─ For each joinedRoom: presence.disconnect(roomId, userId)
  │   └─ Broadcast PRESENCE_UPDATED(isOnline: false if remaining ≤ 0)
  │
  ├─ Client: console.warn("[socket] disconnected")
  │
  ├─ Tier 1: Socket.IO 10 retries (1s → 21s Fibonacci)
  │   ├─ Success → "reconnect" → handleReconnect
  │   │   ├─ emit join_room → presence.connect()
  │   │   ├─ runSync() → catch up missed messages
  │   │   └─ flushImmediate() → retry pending outbox entries
  │   └─ Exhausted → "reconnect_failed" → Tier 2
  │
  └─ Tier 2: setTimeout Fibonacci loop (34s → 610s)
       └─ Fresh ticket + new io() each attempt → back to Tier 1

USER RETURNS TO FOREGROUND
  │
  ├─ visibilitychange → visible / online event
  ├─ AppLifecycle.triggerIfDisconnected()
  │   └─ socket.connected? → skip (already connected)
  │   └─ socket disconnected? → rm.forceReconnect()
  │       ├─ Clear fallback timer
  │       ├─ Kill old socket
  │       ├─ Fresh ticket + new io()
  │       └─ Reset fibIndex = 0

STALENESS SAFETY NET (server, every 30s)
  │
  └─ presence.evictStale()
       ├─ Remove entries with lastHeartbeat > 60s ago
       └─ Broadcast PRESENCE_UPDATED(isOnline: false) per evicted user
```

---

## 9. Known Gaps & Edge Cases

| Scenario | Handling | Gap? |
|---|---|---|
| User backgrounds tab without navigating | Heartbeat keeps running (component stays mounted). Server staleness won't trigger. User appears online. | ✅ Intentional |
| User backgrounds and mobile OS suspends tab | Socket may die without clean disconnect. 60s staleness eviction catches it. | ✅ Covered |
| User rapidly switches tabs | 500ms debounce on visibilitychange prevents duplicate reconnects | ✅ Covered |
| WS ticket expires during long background | Tier 2 fetches fresh ticket every attempt | ✅ Covered |
| User has two tabs open to same room | `connectionCount` tracks both. Only goes offline when both disconnect. | ✅ Covered |
| User closes tab while typing | No `typing_stop` sent. Indicator persists on other clients. | ⚠️ Gap |
| User navigates away (component unmounts) | Heartbeat stops, socket disconnects cleanly, presence updated immediately | ✅ Covered |
| No `pagehide`/`beforeunload` handler | Relies on Socket.IO disconnect detection + 60s staleness. Not ideal for mobile. | ⚠️ Minor |
