# DeChat Architecture: Intelligent Room Reconnection & Sliding Working-Set Cache

## Objective

The goal of this architecture is to make room opening feel **instantaneous** — identical to opening an Instagram DM — regardless of whether the user was away for a few seconds or several months.

Instead of showing a full-screen "Connecting…" spinner that blocks the entire UI, the client renders the chat shell (header, message list, input box) immediately from a persistent local cache, while the WebSocket connection and synchronization happen silently in the background.

The design prioritizes:
- Zero blocking UI on room open.
- Constant reconnection latency (bounded sync payloads).
- Bounded client storage usage (sliding working-set cache).
- Strict separation of persistent cache from infinite-scroll memory history.
- Excellent perceived performance.
- Efficient MongoDB queries.
- Compatibility with cursor-based pagination.
- Full compatibility with the existing E2EE and outbox architecture.

---

## Stack Context

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), Socket.IO Client |
| WebSocket server | Express + Socket.IO 4.8, port 3001 |
| Database | MongoDB Atlas (native driver v6, no Mongoose) |
| Client storage | IndexedDB (`dechat-crypto-store`, DB_VERSION 5) |
| Crypto | AES-256-GCM messages, RSA-OAEP key wrap |
| Message outbox | Durable IndexedDB outbox (`message-outbox` store) |

---

## Core Principles

The client is **never the source of truth** for complete conversation history. The server maintains the complete message history, while the client maintains only a **bounded sliding working-set cache** of the most recent messages per room.

### The Four Independent Layers

1. **Server**: Single source of truth. Stores the complete, encrypted message history.
2. **IndexedDB (Client Cache)**: Persistent working-set cache only. Stores exactly one bounded cache window (latest 100 messages) per room to load the room instantly.
3. **React State**: Active room session state in memory. Combines the cached working-set, any temporary history pages fetched via infinite scroll, and optimistic/outbox messages.
4. **Cursor Pagination**: On-demand history loading. Fetches older messages from the server on-demand as the user scrolls up.

### Persistent Cache vs. Memory-Only History
To prevent IndexedDB from slowly expanding into an unbounded local history database:
- The persistent cache (IndexedDB) is **only used to load the rooms transitionally** and does not act as a history vault.
- The cache is updated **only** by live WebSocket messages, `DELTA` resume synchronization, and `REPLACE` resume synchronization.
- The cache is **never** updated when the user scrolls upward.
- Older pages fetched through cursor-based history pagination are inserted **only into the React state** in memory.
- When the user leaves the room, these temporary history pages are automatically discarded. Reopening the room will load only the latest persistent working-set from IndexedDB.

---

## Client Cache (IndexedDB)

### Database
```
Database:  dechat-crypto-store   (shared with crypto keys and outbox)
Version:   5  (bumped from 4)
```

### New Object Stores
```
message-cache        keyPath: "id"
  index: by-room     field: roomId   (non-unique)

room-cache-meta      keyPath: "roomId"
```

### Window Size Constants
```ts
export const CACHE_WINDOW_SIZE = 100;   // messages stored per room in IndexedDB
export const DELTA_LIMIT       = 200;   // query fetch limit (2 × CACHE_WINDOW_SIZE)
export const MAX_CACHED_ROOMS  = 100;   // LRU room eviction threshold
```

### Room Cache Metadata
Each cached room has one metadata record:
```ts
interface RoomCacheMeta {
  roomId: string;
  newestCachedMessageId: string;
  newestCachedCreatedAt: string;    // ISO 8601
  oldestCachedMessageId: string;
  oldestCachedCreatedAt: string;    // ISO 8601
  messageCount: number;
  lastAccessedAt: number;           // epoch ms — used for LRU eviction
}
```

### What Is Cached
The cache stores **raw encrypted `RealtimeRoomMessage` records** — exactly the shape received from the server over the socket or REST API:
- `ciphertext`, `iv`, `authTag`, `roomKeyVersion` are stored as-is.
- Decryption happens client-side at display time via `decryptBatch()`.
- If a cached message's `roomKeyVersion` is missing locally, that message is silently skipped.
- This ensures the cache is not a security regression since it stores the same ciphertext that transits the network.

### LRU Eviction
When the number of cached rooms in `room-cache-meta` exceeds `MAX_CACHED_ROOMS`, the room with the oldest `lastAccessedAt` is evicted from both `message-cache` and `room-cache-meta`. Temporary history pages never participate in LRU eviction because they are not persisted.

---

## Server — Room Latest Metadata

The resume endpoint requires the server to know the room's newest message without scanning the entire collection. A single `$set` piggybacks on every successful message persist:

```js
// Inside persistEncryptedMessage(), after insertOne():
db.collection("rooms").updateOne(
  { _id: new ObjectId(roomId) },
  { $set: {
      latestMessageId: result.insertedId.toHexString(),
      latestMessageCreatedAt: now,
  }}
);
```

Added to the `rooms` collection schema:

| Field | Type | Notes |
|---|---|---|
| `latestMessageId` | string? | hex ObjectId of the newest message |
| `latestMessageCreatedAt` | Date? | Date of the newest message |

---

## Resume Endpoint

```
GET /api/rooms/:roomId/messages/resume
```

Query parameters:
```
newestCachedMessageId   string?   — client's newest cached message _id (hex)
newestCachedCreatedAt   string?   — client's newest cached message ISO timestamp
```

### Decision Tree & Bounded Delta Fetching
To avoid the "transition boundary drop" (where a gap of exactly `CACHE_WINDOW_SIZE + 1` causes one message to be lost during the transition from delta to full-replace), DeChat queries up to `DELTA_LIMIT` (200) messages during a delta check:

```
1. Auth + membership check (APPROVED, not blocked)
2. Point-read room doc → latestMessageId, latestMessageCreatedAt

3. If both query params are absent (cold start / empty cache):
     → fetch latest CACHE_WINDOW_SIZE (100) messages → strategy: REPLACE

4. If newestCachedMessageId === room.latestMessageId:
     → strategy: UP_TO_DATE, messages: []

5. Query: messages after (newestCachedCreatedAt, newestCachedMessageId)
            sort (createdAt ASC, _id ASC), limit: DELTA_LIMIT + 1 (201)

6. If count ≤ DELTA_LIMIT (≤ 200):
     → strategy: DELTA, messages: [those N messages]

7. Else (gap > 200):
     → fetch latest CACHE_WINDOW_SIZE (100) messages (sort DESC limit 100, then reverse)
     → strategy: REPLACE, messages: [latest 100]
```

### Response Shape
```ts
{
  strategy: "UP_TO_DATE" | "DELTA" | "REPLACE";
  messages: RealtimeRoomMessage[];   // enriched with senderName, senderUserIndex
}
```

The `joinedAt` lower-bound is enforced at query time — no pre-join messages are ever returned.

---

## Room Opening Flow

### Phase 0 — Instant Shell (synchronous, < 1 ms)
1. Read cached messages from IndexedDB  →  `getCachedMessages(roomId)`
2. Read outbox optimistic messages      →  `loadOptimisticMessages(roomId, ...)`
3. Render: chat header + message list (with cache) + input box
4. Set `isBootstrapping = true`
   - Overlay spinner appears over message area
   - Send button is disabled

*Optimistic messages are always appended after the latest cached messages. Because optimistic entries use `Date.now()` as `createdAt`, `mergeMessages()` naturally sorts them to the tail of the list.*

### Phase 1 — Background Parallel Fetch
Simultaneously dispatch:
- `GET /api/rooms/:roomId` (room meta + membership)
- `GET /api/rooms/:roomId/membership`
- `GET /api/rooms/:roomId/messages/resume` (with cache meta params if available)
- `connectToRoom(roomId)` (WS ticket + socket join)

### Phase 2 — Process Keys
1. Unwrap key distributions from `/api/rooms/:roomId/key-distributions`
2. `storeRoomKeyVersion()` for each distribution
3. Set roomKeyRef, roomKeyRotation state

### Phase 3 — Apply Resume Result
- **`UP_TO_DATE`**:
  - Cached messages already rendered — do nothing.
- **`DELTA`**:
  - `decryptBatch(messages)` → merge into React state.
  - `appendToCache(roomId, messages, CACHE_WINDOW_SIZE)`
  - `evictLRURooms(MAX_CACHED_ROOMS)`
- **`REPLACE`**:
  - `decryptBatch(messages)` → set React state (merge with optimistic).
  - `replaceCache(roomId, messages)`
  - `evictLRURooms(MAX_CACHED_ROOMS)`

Finally:
- Update `lastMessageRef` (for `runSync` anchor)
- Set `historyCursor = resumeRes.messages[0].id` (oldest in window → enables scrollback)

### Phase 4 — Live
1. Set `isBootstrapping(false)` (overlay disappears, send button activates)
2. Set status to `"Connected"`
3. Start `OutboxRetryWorker` (flushes any pending outbox messages)
4. Register socket listeners: `room_message`, `message_edited`, `message_deleted`, `typing_started`, `typing_stopped`, etc.
5. Fetch members list in background (non-blocking)

---

## Sending During Bootstrap

- The **input box is always rendered** and accepts keyboard input.
- The **send button is `disabled`** while `isBootstrapping === true`.
- Typing indicators are not emitted until the socket is ready.
- Once Phase 4 completes, the outbox worker auto-flushes any messages typed during the bootstrap window.

This matches the outbox pattern already in place: encrypt → write to outbox → show optimistic message → worker delivers when socket is ready.

---

## Reconnect Flow (`runSync`)

Called by `onSocketReconnect` whenever the socket reconnects (tab resume, brief network drop, etc.).

1. Read current cache metadata: `const meta = await getRoomCacheMeta(roomId);`
2. Hit the resume endpoint with the cache anchor: `const resume = await resumeSync(roomId, meta?.newestCachedMessageId, meta?.newestCachedCreatedAt);`
3. Apply the result — same logic as Phase 3.

This replaces the previous `syncSince` WebSocket event + `syncMessagesSince` REST calls, both of which returned unbounded deltas.

---

## Live Message Cache Update

Every incoming `room_message` socket event updates the cache:

```ts
socket.on("room_message", async (incoming) => {
  // ... existing reconcile + appendDecrypted logic ...

  // Also update the sliding window cache
  await appendToCache(roomId, [incoming], CACHE_WINDOW_SIZE);
});
```

`appendToCache` trims the oldest entry whenever the window exceeds `CACHE_WINDOW_SIZE` to keep the cache size strictly bounded.

---

## Cursor Pagination & History Scrollback

History scrollback is independent of the cache and remains unchanged:

```
GET /api/rooms/:roomId/messages?cursor=<id>&limit=30
```

- The `historyCursor` is seeded from the oldest message in the initial window (`resumeRes.messages[0].id` or `oldestCachedMessageId`).
- Scrolling up loads older pages behind the cached window.
- Older pages fetched via pagination are inserted **only into the React state** in memory.
- **Critical Invariant**: Older history pages are **never written to IndexedDB**. The local page caches are strictly utilized to load rooms instantaneously and do not act as an offline history repository. When the user exits the room, these history pages are discarded.

---

## Database Index

The following compound index serves all message queries (already defined in `setup-indexes`):

```js
db.collection("room_messages").createIndex(
  { roomId: 1, createdAt: 1, _id: 1 },
  { name: "roomId_createdAt_id" }
)
```

---

## Synchronization Decision Summary

| Situation | Strategy | Cost |
|---|---|---|
| Cache up-to-date | `UP_TO_DATE` | 1 point read (room doc) |
| Small gap (≤ DELTA_LIMIT) | `DELTA` | 1 range scan, N messages |
| Large gap (> DELTA_LIMIT) | `REPLACE` | 1 sort+limit scan, window size messages |
| Cold start (no cache) | `REPLACE` | 1 sort+limit scan, window size messages |

Reconnection sync payload size is always bounded — never O(gap size).

---

## UX States

| State | What the user sees |
|---|---|
| `isBootstrapping = true` (cache hit) | Full chat shell + cached messages + overlay spinner |
| `isBootstrapping = true` (cold start) | Full chat shell + empty list + overlay spinner |
| `isBootstrapping = false` | Full chat, send button active, live messages flowing |
| Key rotation pending | "Updating security…" banner, send allowed via outbox |
| Not a member / rejected | Full-screen status message (unchanged) |
| Pending approval | Pending banner (unchanged) |

---

## Architectural Invariants

1. **Server is Source of Truth**: The client never stores the full room history locally.
2. **IndexedDB is Working-Set Only**: IndexedDB stores only a bounded working-set of the latest 100 messages per room.
3. **Memory-Only Scrollback**: Infinite-scroll pages are kept in React memory only and are discarded on room exit. They are never written to IndexedDB.
4. **Cache Updates are Bounded**: Only WebSocket live updates and resume synchronizations (DELTA/REPLACE) write to the persistent cache. Upward scroll never updates the persistent cache.
5. **Independent Cursor Pagination**: Cursor pagination operates independently of cache management.
6. **Background Sync**: Room opening always initializes instantly from the cached working-set and performs synchronization/reconnection in the background.
7. **REPLACE Strategy for Large Gaps**: Large synchronization gaps (>200 messages) fallback to REPLACE instead of downloading unbounded deltas, keeping network and client costs constant.
8. **Optimistic Ordering**: Optimistic messages always sort to the bottom (tail) of the message list based on their newer `createdAt` value, ensuring a clean and correct flow.
