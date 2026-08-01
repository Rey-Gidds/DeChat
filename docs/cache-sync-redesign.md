# Working Set Cache Synchronization Redesign

## Summary

Replace the HTTP-based resume sync with a WebSocket RPC that detects both **message gaps** (delta sync) AND **message mutations** (edits/deletes) by comparing version metadata. This guarantees cache freshness while keeping the instant IndexedDB render path intact.

---

## Current State vs Target

| Concern | Current | Target |
|---|---|---|
| **Resume transport** | HTTP `GET /api/rooms/[roomId]/messages/resume` | WebSocket RPC via extended `sync_since` |
| **Change detection** | Only detects NEW messages (anchor-based delta) | Detects NEW + EDITED + DELETED messages |
| **Mutation tracking** | None — `message_edited`/`message_deleted` update UI but not cache version | `mutationVersion` on room doc, `cacheVersion` on cache meta |
| **Socket live mutations → cache** | Edit: only via ACK. Delete: `removeFromCache()`. No version tracking. | Both update cache + bump `cacheVersion` |
| **Startup warming** | None done lazily per room | Same — no global warming, only per-room on mount |
| **Reconciliation safety** | `mergeMessages()` Map dedup works but race exists during bootstrap | Ref-based snapshot prevents live-message loss during resume |

---

## Architecture

### 1. New Metadata Fields

#### Server: `rooms` collection
```
mutationVersion: number  // default 0, incremented on each edit/delete
```

#### Client: `RoomCacheMeta` (IndexedDB `room-cache-meta` store)
```typescript
interface RoomCacheMeta {
  roomId: string;
  newestCachedMessageId: string;
  newestCachedCreatedAt: string;
  oldestCachedMessageId: string;
  oldestCachedCreatedAt: string;
  messageCount: number;
  lastAccessedAt: number;
  mutationVersion: number;   // NEW — synced from server on each resume
  cacheVersion: number;       // NEW — local counter, bumped on every cache write
  lastSyncedAt: number;       // NEW — epoch ms of last successful sync
}
```

### 2. WebSocket RPC: `sync_room_cache`

Extend the existing `sync_since` event with this payload:

**Client → Server:**
```typescript
{
  roomId: string;
  newestCachedMessageId?: string;     // anchor for delta detection
  newestCachedCreatedAt?: string;     // fallback anchor
  mutationVersion: number;            // client's last known mutationVersion
  cacheVersion: number;               // client's current cacheVersion
  cachedMessageIds: string[];         // all message IDs in the cache window (max 100)
}
```

**Server → Client:**
```typescript
{
  ok: boolean;
  strategy: "UP_TO_DATE" | "DELTA" | "REPLACE";
  messages: RealtimeRoomMessage[];      // delta messages (empty for UP_TO_DATE)
  mutationPatches?: {                   // only if DELTA && mutationVersion mismatch
    edits: RealtimeRoomMessage[];       // full objects for edited messages
    deletes: { messageId: string; deletedAt: string }[];
  };
  serverMutationVersion: number;        // always returned
}
```

### 3. Server-Side Logic (`sync_room_cache` handler)

```
1. Validate membership
2. Read room document → mutationVersion, latestMessageId
3. Determine message delta strategy (same as current resume endpoint):
   - Cold start (no newestCachedMessageId) → REPLACE
   - latestMessageId matches → UP_TO_DATE (no new messages)
   - Anchor found, ≤200 new messages → DELTA
   - Anchor not found or >200 → REPLACE
4. Determine mutation patches (ONLY when strategy is DELTA):
   - If client.mutationVersion !== room.mutationVersion:
     a. Fetch all existing messages from room_messages where _id IN cachedMessageIds
     b. Missing IDs → deletion patches
     c. Existing messages with non-null editedAt → edit patches (full objects)
5. Return combined response with serverMutationVersion
```

### 4. Server: `mutationVersion` Bumps

In `websocket-server/src/index.ts`, after successful edit and delete operations:

**edit_message handler:**
```typescript
// After successful updateMessageContent()
await db.collection("rooms").updateOne(
  { _id: new ObjectId(roomId) },
  { $inc: { mutationVersion: 1 } }
);
```

**delete_message handler:**
```typescript
// After successful deleteMessage()
await db.collection("rooms").updateOne(
  { _id: new ObjectId(roomId) },
  { $inc: { mutationVersion: 1 } }
);
```

**HTTP resume endpoint** — add `mutationVersion` projection and include `serverMutationVersion` in response. For backward compat, `cachedMessageIds` is optional; if absent, skip mutation patch logic.

### 5. Client: Bootstrap Flow Changes

In `frontend/src/app/rooms/[roomId]/page.tsx`, `bootstrap()`:

**Phase 0 — Unchanged:** Instant render from IndexedDB.

**Phase 1 — Replace HTTP resumeSync with WebSocket RPC:**
```typescript
// OLD: HTTP call
const resumeRes = await resumeSync(roomId, newestCachedMessageId, newestCachedCreatedAt);

// NEW: WebSocket RPC (global socket path)
const cacheMeta = await getRoomCacheMeta(roomId);
const cachedMessages = await getCachedMessages(roomId);
const cachedMessageIds = cachedMessages.map(m => m.id);

// Use a ref to capture live messages that arrive during sync
pendingLiveMessagesRef.current = [];

const syncRes = await syncRoomCache({
  roomId,
  newestCachedMessageId: cacheMeta?.newestCachedMessageId,
  newestCachedCreatedAt: cacheMeta?.newestCachedCreatedAt,
  mutationVersion: cacheMeta?.mutationVersion ?? 0,
  cacheVersion: cacheMeta?.cacheVersion ?? 0,
  cachedMessageIds,
});
```

**Phase 3 — Apply result:**

```
If UP_TO_DATE: no changes to cache or state
If DELTA:
  - mergeMessages(cached + decrypted deltas + optimistic + pendingLiveMessages)
  - appendToCache(delta messages)
  - Apply mutation patches:
    - edits → updateInCache() for each, patch React state
    - deletes → removeFromCache() for each, filter React state
  - bumpCacheVersion(roomId) if any patches applied
If REPLACE:
  - mergeMessages(decrypted + optimistic + pendingLiveMessages)
  - replaceCache(all messages)
  - bumpCacheVersion(roomId)
- store cacheMeta with new mutationVersion from server
```

### 6. Live Socket Events → Cache Update + Version Bump

**`message_edited` handler (both per-room and global):**
- Update React state in-place (already done)
- Add: `updateInCache(roomId, message.id, updatedFields)`
- Add: `incrementCacheVersion(roomId)`

**`message_deleted` handler:**
- Filter from React state (already done)
- `removeFromCache(roomId, messageId)` (already done)
- Add: `incrementCacheVersion(roomId)`

**`room_message` handler (new message):**
- `appendDecrypted([incoming], false)` (already done)
- `appendToCache(roomId, [incoming], CACHE_WINDOW_SIZE)` (already done)
- Add: `incrementCacheVersion(roomId)`

**New helper:**
```typescript
async function incrementCacheVersion(roomId: string) {
  const db = await getDB();
  const tx = db.transaction("room-cache-meta", "readwrite");
  const store = tx.objectStore("room-cache-meta");
  const meta = await new Promise<RoomCacheMeta | undefined>((res, rej) => {
    const req = store.get(roomId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (meta) {
    meta.cacheVersion = (meta.cacheVersion ?? 0) + 1;
    store.put(meta);
  }
}
```

### 7. Duplicate Prevention

**Problem:** During bootstrap, live socket messages arriving between Phase 0 and Phase 3 could be overwritten by `setMessages()` in Phase 3 operating on stale captured state.

**Fix — use a ref queue:**

```typescript
const pendingLiveMessagesRef = useRef<UiMessage[]>([]);

// In room_message handler (during bootstrap):
if (isBootstrapping) {
  pendingLiveMessagesRef.current.push(msg);
} else {
  // normal appendDecrypted flow
}

// In Phase 3, merge pending live messages:
setMessages(mergeMessages(
  mergeMessages(resolvedFromCache, resumeDecrypted),
  [...optimistic, ...pendingLiveMessagesRef.current]
));
pendingLiveMessagesRef.current = [];
```

The `mergeMessages()` function already deduplicates by `id` via Map — no code change needed there.

### 8. IndexedDB Schema Migration

- DB version: `6 → 7`
- In `crypto.ts` `onupgradeneeded`: no structural changes needed — `room-cache-meta` store already exists and new fields (`mutationVersion`, `cacheVersion`, `lastSyncedAt`) are additive on the existing object shape
- Code handles missing fields: `meta?.mutationVersion ?? 0`

### 9. Offline Handling

When user is offline and opens a room:
1. Cache renders immediately from IndexedDB (Phase 0)
2. WebSocket RPC fails → fallback: don't touch cache, re-decrypt with cached userId if needed
3. When connectivity returns, next room mount will have a stale `mutationVersion` → server returns full mutation patches
4. Deleted messages removed, edited messages updated — cache brought to fresh state

No special offline logic needed — the version mismatch naturally forces reconciliation on next online mount.

### 10. Per-Room Socket Path (Legacy)

For the per-room socket path, keep the existing HTTP resume endpoint as fallback (the socket isn't connected early enough). The server-side mutation versioning and the HTTP resume endpoint extension still apply — the HTTP endpoint also returns `mutationPatches` and `serverMutationVersion` for the same feature parity.

---

## Files to Modify

### Frontend

| File | Changes |
|---|---|
| `frontend/src/lib/crypto.ts` | Bump DB_VERSION to 7 |
| `frontend/src/lib/message-cache.ts` | Add `mutationVersion`, `cacheVersion`, `lastSyncedAt` to `RoomCacheMeta`. Add `incrementCacheVersion()`. Add `storeRoomCacheMeta()` for updating meta in-place. Update `updateCacheMeta()` to preserve existing version fields. |
| `frontend/src/lib/socket-client.ts` | Add `SyncRoomCachePayload` and `SyncRoomCacheResponse` types. Add `syncRoomCache()` RPC function. Add `syncRoomCacheGlobal()` for global socket path. |
| `frontend/src/lib/messages-client.ts` | Extend `ResumeResponse` to include `mutationPatches`, `serverMutationVersion`. |
| `frontend/src/app/rooms/[roomId]/page.tsx` | Major changes: replace HTTP `resumeSync()` in Phase 1 with WebSocket `syncRoomCache()`. Add `pendingLiveMessagesRef` for bootstrap-safe message capture. Update Phase 3 to apply mutation patches. Wire live socket handlers to bump `cacheVersion`. Add `incrementCacheVersion` calls in edit/delete/new-message socket handlers. |
| `frontend/src/app/api/rooms/[roomId]/messages/resume/route.ts` | Add `mutationVersion` and `cachedMessageIds` query params. Add mutation patch logic (id-based diff). Include `serverMutationVersion` in all responses. |

### WebSocket Server

| File | Changes |
|---|---|
| `websocket-server/src/db.ts` | Add `incrementMutationVersion(roomId)` helper. Add `fetchMutationPatches(roomId, cachedMessageIds)` function that diffs cached IDs against DB. No schema changes to MongoDB collections (new field on existing `rooms` doc). |
| `websocket-server/src/index.ts` | Extend `sync_since` handler (or add new `sync_room_cache` handler). Add `mutationVersion` bump in `edit_message` and `delete_message` handlers. |

---

## Verification

### Manual Tests

1. **Warm cache re-mount:** Open room, close, reopen → messages appear instantly, no flash, sync completes silently
2. **Edit during absence:** Have another user edit a message while you're in another room → reopen room → edited message shows latest content
3. **Delete during absence:** Have another user delete a message → reopen → message is gone
4. **New messages during absence:** Messages sent while away appear after sync
5. **Offline mount:** Open room while disconnected → cache renders, no crash
6. **Offline → online:** Send messages from another device while offline, then reconnect and reopen → delta + mutations applied
7. **Duplicate check:** Send a message, quickly close and reopen room → no duplicate message
8. **Live event during bootstrap:** Send a message to a room while another client is opening it (simulate via slow network) → no lost messages
9. **Large gap:** Scroll far back in history, then reopen → REPLACE strategy fires correctly
10. **mutationVersion integrity:** After multiple edits/deletes, reopen room → mutationVersion on client matches server

### Automated Checks

- `mutationVersion` in room doc increments atomically on each server-side edit/delete
- `cacheVersion` on client increments on every local cache mutation
- `mergeMessages()` dedup Map prevents same-ID duplicates regardless of arrival order
- `pendingLiveMessagesRef` prevents live message loss during bootstrap window
