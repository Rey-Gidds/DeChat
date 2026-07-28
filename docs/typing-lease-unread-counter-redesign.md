# Typing Lease & Unread Counter Redesign — Implementation Plan

## Overview

Replace the current typing `start`/`stop` event pair with a lease-based architecture using a Min-Heap for O(log n) expiry scheduling. Introduce a server-authoritative `UnreadCounter` MongoDB collection with in-memory write-through caching, replacing the purely client-side unread tracking.

---

## Part 1 — Typing Lease Architecture

### 1.1 Current State (what's broken)

| Issue | Detail |
|---|---|
| No server state | Server is a pure relay — never tracks who is typing |
| No late-joiner snapshot | Users joining mid-session don't see active typers |
| Stale indicators on crash | If client crashes/disconnects, `typing_stop` never fires — indicator stays forever |
| No disconnect cleanup | `disconnect` handler doesn't emit `typing_stopped` |

### 1.2 New Architecture

```
Client keystroke (throttled 300ms)
        │
        ▼
socket.emit("typing", { roomId, preview })
        │
        ▼
┌─────────────────────────────────────────────┐
│           TypingLeaseManager                 │
│                                              │
│  HashMap<"roomId:userId", expiresAt>         │
│  MinHeap<{expiresAt, roomId, userId}>        │
│  Single timer → heap root                    │
│                                              │
│  refreshLease(r,u, now+800)                  │
│    → map.set, heap.push, reschedule timer    │
│                                              │
│  onTimerFire()                               │
│    → heap.pop, check map match               │
│    → if stale → discard, pop next            │
│    → if match → map.delete, broadcast        │
│       typing_expired, schedule next          │
│                                              │
│  removeUser(r,u) [on disconnect]             │
│    → map.delete, broadcast typing_expired    │
│    → (heap entry becomes stale, cleaned      │
│       lazily on pop)                         │
│                                              │
│  getActiveTypers(roomId) → userId[]          │
│    → iterate map, filter by room prefix      │
└─────────────────────────────────────────────┘
```

### 1.3 New Events

| Direction | Event | Payload | Purpose |
|---|---|---|---|
| Client → Server | `typing` | `{ roomId, preview? }` | Lease renewal on keystroke |
| Server → Room | `typing_started` | `{ roomId, userId, preview? }` | Broadcast: new typer (only when map entry is *new*, not on refresh) |
| Server → Room | `typing_expired` | `{ roomId, userId }` | Broadcast: lease expired or user disconnected |
| Server → Client | `typing_snapshot` | `{ roomId, users: {userId, preview?}[] }` | Sent on join_room / subscribe_room |

### 1.4 Files to Create

#### `packages/websocket-server/src/typing-lease.ts`

```typescript
// ── Min-Heap + HashMap typing lease manager ──────────────────

interface HeapEntry {
  expiresAt: number;
  roomId: string;
  userId: string;
}

export class TypingLeaseManager {
  private readonly map = new Map<string, number>();  // key="roomId:userId" → expiresAt
  private readonly heap: HeapEntry[] = [];            // Min-Heap by expiresAt
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onExpire: (roomId: string, userId: string) => void;
  private readonly LEASE_DURATION_MS = 800;

  constructor(onExpire: (roomId: string, userId: string) => void) { ... }

  /** Called on every typing event — renews/extends lease */
  refreshLease(roomId: string, userId: string): void { ... }

  /** Called on disconnect — immediately removes and broadcasts expiry */
  removeUser(roomId: string, userId: string): void { ... }

  /** Called when room is deleted — cleanup all typers for that room */
  removeRoom(roomId: string): void { ... }

  /** Returns list of userIds currently typing in a room */
  getActiveTypers(roomId: string): string[] { ... }

  /** Clean up timer — call on server shutdown */
  stop(): void { ... }

  // ── Private helpers ──
  private static makeKey(roomId: string, userId: string): string { ... }
  private heapPush(entry: HeapEntry): void { ... }
  private heapPop(): HeapEntry | undefined { ... }
  private heapPeek(): HeapEntry | undefined { ... }
  private scheduleNext(): void { ... }
  private onTimerFire(): void { ... }
}
```

**Min-Heap implementation details:**
- Array-based binary heap where `heap[0]` is always the smallest `expiresAt`
- `heapPush`: append to end, bubble up `while (i > 0 && heap[i].expiresAt < heap[parent].expiresAt)`
- `heapPop`: swap root with last, pop last, bubble down root
- `scheduleNext`: `clearTimeout(existing)`, peek root → `setTimeout(onTimerFire, root.expiresAt - Date.now())`
- Lazy deletion: never remove from heap on `removeUser`. On `onTimerFire`, after popping, check if `map.get(key) === popped.expiresAt`. If not → stale → discard and pop next.

### 1.5 Files to Modify

#### `packages/websocket-server/src/index.ts`

Changes to the `io.on("connection")` handler:

1. **Initialize** `TypingLeaseManager` instance at module level (like `presence`):
   ```typescript
   import { TypingLeaseManager } from "./typing-lease";
   const typingLeases = new TypingLeaseManager((roomId, userId) => {
     io.to(`room:${roomId}`).emit("typing_expired", { roomId, userId });
   });
   ```

2. **Replace `typing_start` handler** (lines ~915-950):
   - Rename listener to `typing` (keep old event name for backward compat or use new name)
   - Call `typingLeases.refreshLease(roomId, userId)` instead of broadcasting directly
   - Track whether this is a new lease (map had no previous entry for this key) → if new, broadcast `typing_started` to room

3. **Replace `typing_stop` handler** (lines ~954-978):
   - Either remove entirely or make it a no-op for backward compat
   - The lease expiry timer handles stopping now

4. **Add typing snapshot on `join_room`** (line ~364):
   ```typescript
   const activeTypers = typingLeases.getActiveTypers(roomId);
   if (activeTypers.length > 0) {
     socket.emit("typing_snapshot", { roomId, users: activeTypers.map(u => ({ userId: u })) });
   }
   ```

5. **Add typing snapshot on `subscribe_room`** (line ~347): same as above.

6. **Add disconnect cleanup** (in `disconnect` handler, line ~1042):
   ```typescript
   for (const roomId of rooms) {
     typingLeases.removeUser(roomId, userId);
   }
   ```

7. **Cleanup on server shutdown**: hook `typingLeases.stop()` if a shutdown handler exists.

#### `packages/frontend/src/lib/socket-client.ts`

1. **Add new event type exports** (interfaces):
   ```typescript
   export interface TypingExpiredPayload { roomId: string; userId: string; }
   export interface TypingSnapshotPayload { roomId: string; users: { userId: string; preview?: string }[]; }
   ```

2. **Replace emit functions** — rename `emitTypingStart` → `emitTyping` (lease renewal), remove `emitTypingStop`:
   ```typescript
   export async function emitTyping(roomId: string, preview?: string) {
     return emitWithAck<{ ok: boolean }>("typing", { roomId, preview });
   }
   export async function emitGlobalTyping(roomId: string, preview?: string) {
     return emitWithGlobalAck<{ ok: boolean }>("typing", { roomId, preview });
   }
   ```
   (Keep old functions as deprecated aliases for migration safety.)

#### `packages/frontend/src/app/rooms/[roomId]/page.tsx`

1. **Replace `onDraftChange` typing logic** (lines 1788-1803):
   ```typescript
   let lastTypingEmit = 0;
   const TYPING_THROTTLE_MS = 300;

   async function onDraftChange(value: string) {
     if (value.length > 500) return;
     setDraft(value);
     if (!roomId || status !== "Connected") return;
     if (roomDisabled) return;

     if (value.trim().length > 0) {
       const now = Date.now();
       if (now - lastTypingEmit >= TYPING_THROTTLE_MS) {
         lastTypingEmit = now;
         await emitTyping(roomId, value.slice(0, 40)).catch(() => undefined);
       }
       // No typing_stop timeout needed — server lease handles expiry
     }
     // Empty input: do nothing — lease will expire naturally
   }
   ```

2. **Remove `typingTimeoutRef`** — no longer needed.

3. **Remove `emitTypingStop` on message send** (line ~1694) — lease expires naturally.

4. **Add `typing_snapshot` handler** in socket effect:
   ```typescript
   socket.on("typing_snapshot", (payload: TypingSnapshotPayload) => {
     setTypingUsers(payload.users.map(u => u.userId));
   });
   ```

5. **Add `typing_expired` handler**:
   ```typescript
   socket.on("typing_expired", (payload: TypingExpiredPayload) => {
     setTypingUsers(prev => prev.filter(id => id !== payload.userId));
   });
   ```

#### `packages/frontend/src/lib/global-socket-context.tsx`

Add handlers for `typing_snapshot`, `typing_expired` on the global socket, updating room-level typing state. Since the global socket subscribes to all rooms, typing events arrive for which room the user may not be viewing — handle these for room-card indicators.

#### `packages/frontend/src/app/rooms/joined/page.tsx` and `room-discovery.tsx`

Replace `typing_started`/`typing_stopped` listeners (which track boolean per room) with `typing_started`/`typing_expired` listeners. No functional change needed — the boolean tracking pattern still works.

### 1.6 Edge Cases & Resilience

| Scenario | Behavior |
|---|---|
| **Client crashes while typing** | Server disconnect handler calls `removeUser` → immediate `typing_expired` broadcast. No stale indicators. |
| **Network partition (packets lost)** | One `typing` event lost → lease expires in 800ms, then next keystroke re-establishes. No permanent inconsistency. |
| **Rapid typing (lease constantly renewed)** | Every 300ms throttle → `refreshLease` updates map + pushes to heap. Old heap entries become stale, cleaned on pop. Timer reschedules only if new root is earlier. |
| **Server restart** | Process-local state is lost. Clients re-emit `typing` on next keystroke. Acceptable per user's process-local decision. |
| **Multiple tabs typing in same room** | Each tab emits independently. On disconnect of one tab, only that tab's socket triggers `removeUser`. Other tabs keep the lease alive. Need to track per-socket? **Decision:** Simplify — multiple tabs from same user in same room is rare; the last tab to disconnect will clean it up. Acceptable. |
| **Room deletion while users typing** | Call `typingLeases.removeRoom(roomId)` in the room deletion handler (if one exists). |
| **Heap memory growth** | Each typing event pushes to heap. A very active user could add many stale entries. **Mitigation:** periodically compact the heap (e.g., every 60s, rebuild heap from only active map entries). Add a `compact()` method. |
| **Timer precision / drift** | `setTimeout` can fire late. The `onTimerFire` compares `popped.expiresAt <= Date.now()` — if the timer fired early (impossible) or the heap had stale entries past due, process them all in a loop until heap root > now. |

---

## Part 2 — Unread Counter Redesign

### 2.1 Current State (what's broken)

| Issue | Detail |
|---|---|
| No server-side source of truth | Unread counts exist only in client IndexedDB + Zustand memory |
| Lost increments on disconnect | `user_unread_increment` events during offline never delivered |
| No reconnect reconciliation | `loadFromDB()` reads IndexedDB, but IndexedDB may be stale or empty |
| No mark-as-read persistence | `clearUnread()` is client-only; if IndexedDB is cleared, counts reset to 0 incorrectly |
| Membership lifecycle gaps | No cleanup when user leaves or is removed from a room |

### 2.2 New Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MONGODB (authoritative)                       │
│                                                                  │
│  collection: unread_counters                                     │
│  document: { userId, roomId, unreadCount, version,              │
│              updatedAt, lastMessageTimestamp }                   │
│                                                                  │
│  indexes:                                                        │
│    { userId:1, roomId:1 } UNIQUE                                │
│    { userId:1 }                                                  │
│    { roomId:1 }                                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    write-through
                    read on cache miss
                             │
┌────────────────────────────┴────────────────────────────────────┐
│              UnreadCache (in-memory, server-side)                │
│                                                                  │
│  Map<`${userId}:${roomId}`, number>                              │
│                                                                  │
│  get(userId, roomId) → number | undefined                        │
│  set(userId, roomId, count)                                      │
│  delete(userId, roomId)                                          │
│  deleteByRoom / deleteByUser                                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    WebSocket events
                    REST API
                             │
┌────────────────────────────┴────────────────────────────────────┐
│                      CLIENT                                      │
│                                                                  │
│  IndexedDB (client cache, not authoritative)                     │
│  Zustand useUnreadStore (reactive state)                         │
│                                                                  │
│  On boot: GET /api/unread-counts → IndexedDB → Zustand           │
│  On reconnect: GET /api/unread-counts → IndexedDB → Zustand      │
│  Live: user_unread_increment / unread_count_updated events       │
│  On room open: mark_as_read with version guard                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 New Events & API

#### REST API

**`GET /api/unread-counts`**
- Auth: session cookie
- Response: `{ counts: { roomId: string; unreadCount: number; version: number; lastMessageTimestamp: number }[] }`
- Called on boot and reconnect

**Internal endpoint: `POST /internal/unread-counters/reset`** (server-internal)
- Body: `{ userId, roomId, version }`
- Atomically resets unreadCount to 0 only if DB version matches
- Returns `{ ok: boolean, actualCount?: number, actualVersion?: number }`

#### WebSocket Events

| Direction | Event | Payload | Purpose |
|---|---|---|---|
| Server → User channel | `user_unread_increment` | `{ roomId, unreadCount, version, senderId?, messageType?, createdAt? }` | Live increment (includes current count + version for reconciliation) |
| Client → Server | `mark_as_read` | `{ roomId, version }` | Force-reset unread count with version guard |
| Server → User channel | `unread_count_updated` | `{ roomId, unreadCount: 0, version }` | Confirmation of mark-as-read |

### 2.4 Files to Create

#### `packages/websocket-server/src/unread-counter.ts`

```typescript
// ── Unread counter manager (DB + cache) ──────────────────────

export class UnreadCounterManager {
  private readonly cache = new Map<string, number>(); // key="${userId}:${roomId}" → count

  /** Atomically increment unread count for a user in a room. Returns new count + version. */
  async increment(userId: string, roomId: string, timestamp: Date): Promise<{ count: number; version: number }> { ... }

  /** Atomically reset unread count to 0 with version guard. Returns { success, actualCount, actualVersion }. */
  async resetIfVersion(userId: string, roomId: string, expectedVersion: number): Promise<{ success: boolean; actualCount: number; actualVersion: number }> { ... }

  /** Get unread count (cache-first, DB fallback). */
  async get(userId: string, roomId: string): Promise<number> { ... }

  /** Get all unread counters for a user. */
  async getAllForUser(userId: string): Promise<UnreadCounterDoc[]> { ... }

  /** Delete counter for a user+room pair (on leave/kick/block). */
  async delete(userId: string, roomId: string): Promise<void> { ... }

  /** Delete all counters for a room (on room deletion). */
  async deleteByRoom(roomId: string): Promise<void> { ... }

  /** Ensure the unread_counters collection and indexes exist. */
  static async ensureIndexes(): Promise<void> { ... }

  private static makeKey(userId: string, roomId: string): string { ... }
  private updateCache(userId: string, roomId: string, count: number): void { ... }
}
```

**Increment implementation:**
```typescript
// Uses findOneAndUpdate with $inc + upsert
const result = await db.collection("unread_counters").findOneAndUpdate(
  { userId: new ObjectId(userId), roomId: new ObjectId(roomId) },
  {
    $inc: { unreadCount: 1, version: 1 },
    $set: { updatedAt: now, lastMessageTimestamp: timestamp },
    $setOnInsert: { createdAt: now },
  },
  { upsert: true, returnDocument: "after" }
);
this.updateCache(userId, roomId, result.value.unreadCount);
return { count: result.value.unreadCount, version: result.value.version };
```

**Reset implementation (optimistic concurrency):**
```typescript
const result = await db.collection("unread_counters").findOneAndUpdate(
  { userId: new ObjectId(userId), roomId: new ObjectId(roomId), version: expectedVersion },
  { $set: { unreadCount: 0, updatedAt: now }, $inc: { version: 1 } },
  { returnDocument: "after" }
);
if (!result.value) {
  // Version mismatch — fetch current doc
  const current = await db.collection("unread_counters").findOne({ userId, roomId });
  return { success: false, actualCount: current?.unreadCount ?? 0, actualVersion: current?.version ?? 0 };
}
this.updateCache(userId, roomId, 0);
return { success: true, actualCount: 0, actualVersion: result.value.version };
```

#### `packages/frontend/src/app/api/unread-counts/route.ts`

```typescript
// GET /api/unread-counts — returns all unread counters for auth'd user
export async function GET(request: NextRequest) {
  const session = await getCachedSession();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const counters = await db.collection("unread_counters")
    .find({ userId: new ObjectId(session.user.id) })
    .project({ roomId: 1, unreadCount: 1, version: 1, lastMessageTimestamp: 1, _id: 0 })
    .toArray();

  return NextResponse.json({
    counts: counters.map(c => ({
      roomId: c.roomId.toString(),
      unreadCount: c.unreadCount,
      version: c.version,
      lastMessageTimestamp: c.lastMessageTimestamp?.getTime() ?? 0,
    })),
  });
}
```

### 2.5 Files to Modify

#### `packages/websocket-server/src/index.ts`

1. **Initialize `UnreadCounterManager`**:
   ```typescript
   import { UnreadCounterManager } from "./unread-counter";
   const unreadCounters = new UnreadCounterManager();
   ```

2. **Modify `send_message` handler** (lines 676-688):
   Replace the direct `io.to(...)emit("user_unread_increment")` loop with:
   ```typescript
   for (const s of nonViewerSubscribers) {
     const { count, version } = await unreadCounters.increment(s.data.userId, roomId, savedMessage.createdAt);
     io.to(`user:${s.data.userId}`).emit("user_unread_increment", {
       roomId,
       unreadCount: count,
       version,
       senderId: socket.data.userId,
       senderName: senderInfo.name,
       messageType,
       createdAt: savedMessage.createdAt,
     });
   }
   ```
   **Performance note:** The loop now makes individual `findOneAndUpdate` calls. For large rooms (>100 members), batch with `bulkWrite` instead:
   ```typescript
   const bulkOps = nonViewerSubscribers.map(s => ({
     updateOne: {
       filter: { userId: new ObjectId(s.data.userId), roomId: new ObjectId(roomId) },
       update: { $inc: { unreadCount: 1, version: 1 }, $set: { updatedAt: now, lastMessageTimestamp: savedMessage.createdAt }, $setOnInsert: { createdAt: now } },
       upsert: true,
     }
   }));
   await db.collection("unread_counters").bulkWrite(bulkOps);
   // Then fetch results for emission...
   ```

3. **Add `mark_as_read` handler**:
   ```typescript
   socket.on("mark_as_read", async (payload: { roomId: string; version: number }, ack) => {
     const { roomId, version } = payload;
     const userId = socket.data.userId;
     const roomIdFinal = roomId || socket.data.roomId;
     if (!roomIdFinal || !userId) { ack?.({ ok: false, error: "Missing roomId/userId" }); return; }

     const result = await unreadCounters.resetIfVersion(userId, roomIdFinal, version);
     if (result.success) {
       io.to(`user:${userId}`).emit("unread_count_updated", { roomId: roomIdFinal, unreadCount: 0, version: result.actualVersion });
       ack?.({ ok: true });
     } else {
       // Version mismatch — another message arrived. Return actual count.
       ack?.({ ok: true, conflict: true, unreadCount: result.actualCount, version: result.actualVersion });
     }
   });
   ```

4. **Add cleanup on membership lifecycle events**:
   In the existing `POST /internal/membership-updated` handler or equivalent room-leave/kick paths:
   ```typescript
   await unreadCounters.delete(userId, roomId);
   ```
   Also in the `disconnect` handler? **No** — counter persists across disconnects. Only delete on leave/kick/block.

5. **Call `ensureIndexes()` at server startup**:
   ```typescript
   await UnreadCounterManager.ensureIndexes();
   ```

#### `packages/frontend/src/lib/unread-store.ts`

Add `version` tracking alongside counts:
```typescript
interface UnreadState {
  counts: Record<string, number>;
  timestamps: Record<string, number>;
  versions: Record<string, number>;  // NEW: per-room version for optimistic concurrency
  increment: (roomId: string, count: number, version: number, timestamp?: number) => Promise<void>;
  clear: (roomId: string, version: number) => Promise<void>;  // updated
  set: (roomId: string, count: number, version: number, timestamp?: number) => Promise<void>;  // updated
  loadFromDB: () => Promise<void>;
  syncFromServer: (entries: ServerUnreadEntry[]) => Promise<void>;  // NEW
}

// NEW: syncFromServer — replaces local counts with server-authoritative data
syncFromServer: async (entries) => {
  for (const e of entries) {
    await writeUnread(e.roomId, e.unreadCount, e.lastMessageTimestamp);
  }
  // Also delete any local entries not in the server list
  // ...
}
```

#### `packages/frontend/src/lib/global-socket-context.tsx`

1. **Update `onUnreadIncrement` handler** (lines 120-124):
   ```typescript
   const onUnreadIncrement = (p: { roomId: string; unreadCount: number; version: number; createdAt?: string | number }) => {
     void set(p.roomId, p.unreadCount, p.version, p.createdAt ? new Date(p.createdAt).getTime() : undefined);
     revalidateRooms(globalMutate);
   };
   ```

2. **Add `unread_count_updated` handler**:
   ```typescript
   const onUnreadUpdated = (p: { roomId: string; unreadCount: number; version: number }) => {
     if (p.unreadCount === 0) {
       void clear(p.roomId, p.version);
     } else {
       void set(p.roomId, p.unreadCount, p.version);
     }
   };
   ```

3. **On connect/reconnect**, call `GET /api/unread-counts`:
   ```typescript
   async function syncUnreadCounts() {
     try {
       const res = await fetch("/api/unread-counts");
       const data = await res.json();
       if (data.counts) {
         await syncFromServer(data.counts);
       }
     } catch (err) {
       console.warn("Failed to sync unread counts from server", err);
     }
   }
   // Call on connect and on reconnect
   ```

#### `packages/frontend/src/app/rooms/[roomId]/page.tsx`

1. **Add `mark_as_read` call when opening a room** (replace `clearUnread`):
   ```typescript
   const version = useUnreadStore.getState().versions[roomId] ?? 0;
   socket.emit("mark_as_read", { roomId, version }, (ack: any) => {
     if (ack?.conflict) {
       // A message arrived concurrently — accept the server's actual count
       void useUnreadStore.getState().syncFromServer([{
         roomId, unreadCount: ack.unreadCount, 
         version: ack.version, lastMessageTimestamp: Date.now()
       }]);
     } else {
       // Successfully reset
       void clearUnread(roomId, ack?.version ?? version + 1);
     }
   });
   // Still do clearUnread locally immediately for optimistic UI
   void clearUnread(roomId, version);
   ```

2. **Remove the old `clearUnread` call** on line ~1342.

### 2.6 Edge Cases & Resilience

| Scenario | Behavior |
|---|---|
| **Message arrives while opening room** | `mark_as_read` uses version guard. If message `$inc`d between client reading version and sending `mark_as_read`, the reset is rejected. Server returns actual count → client displays it. |
| **User offline for hours** | On reconnect, `GET /api/unread-counts` returns authoritative counts from MongoDB. No event loss possible. |
| **Cache loss (server restart)** | Cache is empty. First `get()` call for a user hits MongoDB, then populates cache. No data loss. |
| **User leaves / is kicked** | `unread_counters.delete(userId, roomId)` removes the document. Next `GET /api/unread-counts` won't include it. |
| **Room deleted** | `unread_counters.deleteByRoom(roomId)` cleans up all counters. |
| **IndexedDB corruption / cleared** | `GET /api/unread-counts` on next app boot restores correct state. |
| **Thundering herd on reconnect** | `GET /api/unread-counts` returns per-user data — no contention. Each user fetches their own counters. |
| **Client message flood (DoS)** | No additional risk — amount of DB writes scales with room size. The current system already iterates room sockets. The `bulkWrite` optimization mitigates the DB overhead. |

### 2.7 Client-Side Storage Strategy

**Decision: IndexedDB as the client cache layer**

Rationale:
- **It's already in place** — `unread-counts` store exists in IndexedDB
- **Survives tab close/refresh** — unlike Zustand memory-only state
- **Speed**: `loadFromDB()` hydrates Zustand in <50ms on app boot (IndexedDB read is local, no network)
- **Offline capability**: app shows last-known counts even before server sync completes
- **Server cache (write-through Map)** handles the realtime path; client IndexedDB handles the boot path

The flow:
1. App boots → `loadFromDB()` hydrates Zustand from IndexedDB (instant)
2. Socket connects → `syncFromServer()` fetches `GET /api/unread-counts`, overwrites IndexedDB + Zustand with authoritative data
3. Live events → update IndexedDB + Zustand together (write-through)
4. App in background → IndexedDB holds last-known state; on foreground, `syncFromServer()` reconciles

**No change needed to IndexedDB infrastructure** — the `writeUnread()` function already handles the `unread-counts` store. Just add `version` to the stored object.

---

## Part 3 — Migration Plan

### 3.1 Backward Compatibility

The `typing` lease model is backward-compatible if we:
1. Keep listening on the old `typing_start` event name for a transition period
2. Accept both `typing_start` and `typing` client events
3. Ignore `typing_stop` events (no-op on server)
4. Clients that haven't updated will still work — their `typing_start` events act as lease renewals, and the `typing_stop` timeout is just ignored. Stale indicators last up to 800ms (acceptable).

For unread:
1. Keep emitting `user_unread_increment` in the same format, just add `unreadCount` and `version` fields
2. Old clients ignore unknown fields — still get the increment event
3. New `mark_as_read` event is additive — old clients don't emit it, so the DB may accumulate counters that never get reset. **Mitigation:** On next app update, the first `syncFromServer()` call resets local state to match server.

### 3.2 Database Migration

Run once at server startup or via a setup script:
```typescript
// In ensureIndexes():
const db = await getDb();
const collections = await db.listCollections({ name: "unread_counters" }).toArray();
if (collections.length === 0) {
  await db.createCollection("unread_counters");
}
await db.collection("unread_counters").createIndex(
  { userId: 1, roomId: 1 },
  { unique: true }
);
await db.collection("unread_counters").createIndex({ userId: 1 });
await db.collection("unread_counters").createIndex({ roomId: 1 });
```

### 3.3 Feature Flag Strategy

Both changes can be deployed behind feature flags:
- `USE_GLOBAL_SOCKET` (already exists) — typing leases are only relevant when the global socket is used (room-scoped sockets will also benefit but keep backward compat)
- Add `NEXT_PUBLIC_TYPING_LEASE` (default `"true"`) — toggles the lease-based typing on the client
- Unread counter changes should be **server-first**: deploy the server-side collection + cache first, then update the client

---

## Part 4 — Performance Considerations

### Typing Leases
- **Heap memory**: Each active typing event pushes a `HeapEntry` (3 fields, ~48 bytes). At 10,000 concurrent typers (extreme), heap is ~480KB. Negligible.
- **Heap compaction**: If a user types 60 WPM (~5 chars/sec) with 300ms throttle, that's ~3 events/sec/user. After 1 minute, 180 heap entries per user. With 100 active users = 18,000 entries. Run `compact()` every 60 seconds to rebuild heap from active map entries (O(n)). Acceptable.
- **Timer scheduling**: `setTimeout` for the next expiration is O(1). On each `refreshLease`, reschedule only if new root is earlier (rare — usually the same or later).
- **getActiveTypers scan**: O(n) over map entries. For a room with 100 typers, iterating the full map (~10,000 entries at worst) is fast. Could be optimized with a secondary `Map<roomId, Set<userId>>` if needed, but not worth the complexity yet.

### Unread Counters
- **`bulkWrite` for increments**: For large rooms (>100 members), the current approach iterates sockets one by one. The `bulkWrite` path replaces N individual calls with 1 atomic operation. For a 1000-member room, this is significant.
- **Cache hit rate**: The write-through cache ensures any `get()` after an increment is O(1). The REST endpoint reads directly from MongoDB (no cache), which is fine — it's called on boot/reconnect, not on every event.
- **Version field**: A single incrementing integer. MongoDB's `$inc` is atomic and fast. No distributed counter concerns.
- **Index bloat**: The `unread_counters` collection has one document per (user × room). For a 10,000-user app with avg 10 rooms/user, that's 100,000 documents. MongoDB handles this easily. TTL index on `updatedAt` could auto-clean 0-count entries if desired (future optimization).

---

## Part 5 — Verification Plan

### 5.1 Typing Leases

1. **Unit tests for `TypingLeaseManager`**:
   - `refreshLease` adds to map + heap, timer schedules correctly
   - `getActiveTypers` returns correct set after multiple refreshes
   - Lazy deletion: stale heap entries are skipped on pop
   - `removeUser` removes from map, next pop skips stale entry
   - `compact()` rebuilds heap correctly
   - Edge: rapid refreshLease calls, timer only reschedules when new root is earlier

2. **Integration tests**:
   - Two clients in same room: Client A types, Client B receives `typing_started`
   - Client A stops typing → 800ms later, both clients receive `typing_expired`
   - Client C joins room while A is typing → receives `typing_snapshot` with A's userId
   - Client A disconnects while typing → Client B receives `typing_expired` immediately
   - Client A crashes (force kill) → Client B receives `typing_expired` on disconnect

3. **Manual QA**:
   - Open two browser windows, verify typing indicators appear/disappear
   - Join room midway through someone typing — verify snapshot
   - Disconnect network while typing — verify indicator disappears within 800ms

### 5.2 Unread Counters

1. **Unit tests for `UnreadCounterManager`**:
   - `increment` on new (userId, roomId) → upserts with count=1
   - `increment` on existing → count=2, version incremented
   - `resetIfVersion` with matching version → count=0
   - `resetIfVersion` with stale version → returns conflict + actual count
   - `getAllForUser` returns all counters
   - `delete` removes from DB + cache

2. **Integration tests**:
   - User A sends message to room → User B gets `user_unread_increment` with count and version
   - User B opens room → `mark_as_read` resets count to 0
   - Concurrent: message arrives between B reading version and sending `mark_as_read` → conflict returned
   - User B goes offline → messages arrive → reconnects → `GET /api/unread-counts` returns correct counts
   - User B leaves room → counter deleted from DB

3. **Manual QA**:
   - Badge counts persist across page refreshes
   - Opening a room clears the badge
   - Receiving messages while in another room increments badge
   - Force-reload after messages arrive while tab was closed → counts are correct
```

---

## File Change Summary

| File | Action | Description |
|---|---|---|
| `packages/websocket-server/src/typing-lease.ts` | **CREATE** | Min-Heap + HashMap typing lease manager |
| `packages/websocket-server/src/unread-counter.ts` | **CREATE** | Server-side unread counter manager (DB + cache) |
| `packages/websocket-server/src/index.ts` | **MODIFY** | Integrate TypingLeaseManager + UnreadCounterManager into event handlers |
| `packages/frontend/src/lib/socket-client.ts` | **MODIFY** | New event types, `emitTyping()` replaces `emitTypingStart`/`emitTypingStop` |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | **MODIFY** | Replace typing timeout with throttle + lease, add `mark_as_read` |
| `packages/frontend/src/lib/unread-store.ts` | **MODIFY** | Add version tracking, `syncFromServer()` |
| `packages/frontend/src/lib/global-socket-context.tsx` | **MODIFY** | Handle new typing + unread events, add `syncUnreadCounts()` on connect |
| `packages/frontend/src/app/api/unread-counts/route.ts` | **CREATE** | REST endpoint for authoritative unread counts |
| `packages/frontend/src/app/rooms/joined/page.tsx` | **MODIFY** | Replace `typing_stopped` with `typing_expired` listener |
| `packages/frontend/src/app/rooms/room-discovery.tsx` | **MODIFY** | Replace `typing_stopped` with `typing_expired` listener |
| `packages/websocket-server/src/db.ts` | **MODIFY** | Add `ensureIndexes()` for `unread_counters` collection |

---

## Implementation Order

1. **Server: `TypingLeaseManager`** (new file + integration in `index.ts`) — can deploy independently
2. **Server: `UnreadCounterManager` + indexes** (new file + `ensureIndexes` in `db.ts`) — deploy before client changes
3. **Server: `send_message` + `mark_as_read` handlers** in `index.ts`
4. **Client API: `GET /api/unread-counts`** endpoint
5. **Client: `socket-client.ts`** new types
6. **Client: `unread-store.ts`** version + `syncFromServer`
7. **Client: `global-socket-context.tsx`** event handlers + sync on connect
8. **Client: `[roomId]/page.tsx`** typing throttle + `mark_as_read`
9. **Client: joined/room-discovery pages** updated event listeners
10. **Testing + QA** for both systems
