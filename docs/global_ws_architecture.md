# Global WebSocket Migration — Implementation Plan

> **Decision log**: Socket boot = On login | Migration = Dual-path with feature flag | Unread delivery = Per-message on user channel | Membership events = Dual channel (room broadcast + user channel) | Multi-tab outbox = Defer leader election, use IN_FLIGHT guard

---

## 1. Current State Inventory

### 1.1 Server-Side Files

| File | Lines | Purpose |
|---|---|---|
| `packages/websocket-server/src/index.ts` | 790 | Express + Socket.IO server: ticket verification middleware (L178-195), all event handlers (join_room, send_message, edit_message, delete_message, typing_start/stop, sync_since, heartbeat, disconnect), internal HTTP endpoints for membership-updated / key-rotation |
| `packages/websocket-server/src/db.ts` | 262 | MongoDB operations: `isActiveMember(roomId, userId)`, `isRoomDisabled`, `persistEncryptedMessage`, `fetchMessagesSince`, `updateMessageContent`, `deleteMessage`, `getSenderInfo` |
| `packages/websocket-server/src/presence-store.ts` | 185 | `InMemoryPresenceStore`: roomId→userId→{connectionCount, lastHeartbeat}, TTL=60s, cleanup interval=30s |
| `packages/websocket-server/src/ws-ticket.ts` | 49 | Ticket verify: HMAC-SHA256 validation, 60s TTL, type="room" requires roomId |

### 1.2 Client-Side Files

| File | Lines | Purpose |
|---|---|---|
| `packages/frontend/src/lib/socket-client.ts` | 302 | Module-level `let socket` singleton. `connectToRoom(roomId)` fetches room ticket, creates `io()` with `auth.ticket`, emits `join_room`. `connectAsUser()` already exists for user-scoped ticket. `startHeartbeat()`/`stopHeartbeat()` per-room. `sendEncryptedMessage`, `editEncryptedMessage`, `deleteEncryptedMessage`, `syncSince`, `emitTypingStart/Stop`. `disconnectSocket()` kills the singleton. `setSocket()` for ReconnectionManager. |
| `packages/frontend/src/lib/reconnection-manager.ts` | 220 | Two-tier Fibonacci: Socket.IO 10 attempts (1s→21s) + fallback from fib(8)=34s to fib(14)=610s. Room-scoped (hardcoded `this.roomId`). `createFreshConnection()` fetches room ticket. |
| `packages/frontend/src/lib/lifecycle.ts` | 56 | Per-room `AppLifecycle`: watches `visibilitychange` + `online`, calls `onForeground` if socket disconnected. |
| `packages/frontend/src/lib/outbox-worker.ts` | 241 | `OutboxRetryWorker` room-scoped (constructor takes roomId). Polls IndexedDB every 2s via `getEligibleRetryEntries(roomId, now)`. Retry schedule: 0, 5s, 15s, 30s, 60s. |
| `packages/frontend/src/lib/outbox-db.ts` | 234 | IndexedDB "message-outbox" store keyed by `clientMessageId`, indexed by `by-room`, `by-next-retry`, `by-failed-at`, `by-status`. |
| `packages/frontend/src/lib/outbox-reconcile.ts` | 104 | `buildOptimisticUiMessage`, `reconcileOptimisticMessage`, `findOutboxEntryByCipherprint` (ciphertext fingerprint for lost-ACK recovery, EC-02). |
| `packages/frontend/src/lib/message-cache.ts` | 290 | IndexedDB "message-cache" + "room-cache-meta" stores. `getCachedMessages`, `appendToCache`, `replaceCache`, `evictLRURooms` (LRU cap=100 rooms, window=100 msgs). |
| `packages/frontend/src/lib/quoted-message.ts` | 65 | `encryptMessagePreview` (60-char truncation), `decryptReplyPreview`. |
| `packages/frontend/src/lib/messages-client.ts` | 94 | REST: `fetchMessageHistory`, `resumeSync` (UP_TO_DATE / DELTA / REPLACE), `fetchMessagesAround`. |
| `packages/frontend/src/lib/models.ts` | 214 | Type definitions: Room, RoomMembership, ImageMetadata, VideoMetadata, GifMetadata, ReplyToInfo, RoomMessage, RoomKeyVersion, RoomKeyDistribution. |
| `packages/frontend/src/lib/key-rotation.ts` | 107 | `claimRotationLock`, `completeRotation`, `syncKeyVersion`, `fetchMyKeyDistributions`. |
| `packages/frontend/src/lib/swr-config.ts` | 23 | SWR keys: `/api/me`, `/api/rooms/mine`, `/api/rooms/requests`, `/api/rooms`, `/api/tags/popular`, `/api/tags/trending`. |
| `packages/frontend/src/lib/ws-ticket.ts` | 49 | Client-side ticket creation (createWsTicket, createUserWsTicket). |
| `packages/frontend/src/hooks/use-swr-hooks.ts` | 206 | `useUser()`, `useMyRooms()`, `usePendingRequests()` (creates a user socket for REQUEST_APPROVED/REJECTED events — this will need to switch to global socket), `useDiscoveryRooms()`. |
| `packages/frontend/src/components/providers.tsx` | 19 | Wraps app in `SWRConfig` with global fetcher. |
| `packages/frontend/src/components/layout/app-shell.tsx` | 164 | Shell layout: header, nav, footer. `signOut` calls `clearAllOutboxEntries()`. This is where `GlobalSocketProvider` will be mounted. |
| `packages/frontend/src/app/layout.tsx` | 50 | Root layout: `<Providers><AppShell>{children}</AppShell></Providers>`. |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | 2000+ | **The room page** — the hub of all socket activity. Full bootstrap: Phase 0 (IDB cache) → Phase 1 (parallel REST) → Phase 2 (keys) → Phase 3 (delta/replace) → Phase 4 (connectToRoom + event handlers + outbox worker). Unmount kills all. |
| `packages/frontend/src/app/rooms/joined/page.tsx` | 77 | Static room list: SWR `useMyRooms("APPROVED")`. No live data. |
| `packages/frontend/src/app/api/ws/ticket/route.ts` | 49 | POST /api/ws/ticket — room-scoped ticket, checks APPROVED membership. |
| `packages/frontend/src/app/api/ws/user-ticket/route.ts` | 15 | POST /api/ws/user-ticket — user-scoped ticket, no roomId, any authenticated user. |

### 1.3 Complete Event Inventory

**Server emits → Client listens:**

| Event | Server emission (index.ts line) | Room scope | Current client handler(s) |
|---|---|---|---|
| `room_message` | `io.to('room:X').emit(...)` (L423) | Per room broadcast | `room/[roomId]/page.tsx` L1044 |
| `message_edited` | `io.to('room:X').emit(...)` (L565) | Per room broadcast | `room/[roomId]/page.tsx` L1101 |
| `message_deleted` | `io.to('room:X').emit(...)` (L638) | Per room broadcast | `room/[roomId]/page.tsx` L1133 |
| `typing_started` | `socket.to('room:X').emit(...)` (L674) | Per room broadcast (excludes sender) | `room/[roomId]/page.tsx` L1141 |
| `typing_stopped` | `socket.to('room:X').emit(...)` (L702) | Per room broadcast (excludes sender) | `room/[roomId]/page.tsx` L1148 |
| `PRESENCE_UPDATED` | Emitted on join (L237), leave (L255), disconnect (L757), stale eviction (L780) | Per room broadcast | `room/[roomId]/page.tsx` L1153 |
| `PENDING_KEY_ROTATION` | `/internal/key-rotation-pending` → `io.to('room:X').emit` (L91) | Per room broadcast | `room/[roomId]/page.tsx` L1174 |
| `KEY_ROTATION_COMPLETE` | `/internal/key-rotation-complete` → `io.to('room:X').emit` (L119) | Per room broadcast | `room/[roomId]/page.tsx` L1185 |
| `KEY_ROTATION_FAILED` | Room page handler only (L1199) | Per room broadcast | `room/[roomId]/page.tsx` L1199 |
| `REQUEST_APPROVED` | `/internal/membership-updated` → `io.to('user:Y').emit` (L63) | User channel | `usePendingRequests()` L167 |
| `REQUEST_REJECTED` | `/internal/membership-updated` → `io.to('user:Y').emit` (L65) | User channel | `usePendingRequests()` L168 |
| `membership_updated` | `/internal/membership-updated` → `io.to('user:Y').emit` (L67) | User channel | `usePendingRequests()` L169 |

**New events added by this migration (server emits → client listens):**

| Event | Server emission | Scope | Purpose |
|---|---|---|---|
| `room_new_message_notify` | `io.to('room:X').emit(...)` in `send_message` handler | Room broadcast | Lightweight signal for room-list reordering. NO ciphertext. |
| `user_unread_increment` | `io.to('user:Y').emit(...)` in `send_message` handler | User channel (per non-viewing subscriber) | Per-message unread count increment targeted at each subscriber NOT viewing the room. Carries `{ roomId, senderId, senderName, messageType, createdAt }`. |
| `viewing_room_start` | `io.to('room:X').emit(...)` in `join_room` handler | Room broadcast | Notifies room members that a user started viewing. |
| `viewing_room_stop` | `io.to('room:X').emit(...)` in `leave_room` handler | Room broadcast | Notifies room members that a user stopped viewing. |
| `room_member_joined` | `io.to('room:X').emit(...)` + `io.to('user:Y').emit(...)` | Dual channel | Fired when a new member joins the room. Room broadcast updates member list for viewers. User channel notifies the joined user with full room metadata. |
| `room_member_left` | `io.to('room:X').emit(...)` + `io.to('user:Y').emit(...)` | Dual channel | Fired when a member leaves. Room broadcast updates member list. User channel notifies the leaving user (confirmation). |
| `room_member_kicked` | `io.to('room:X').emit(...)` + `io.to('user:Y').emit(...)` | Dual channel | Fired when a member is kicked. Room broadcast updates member list. User channel triggers immediate UI reaction (redirect, toast). |
| `room_deleted` | `io.to('room:X').emit(...)` + `io.to('user:Y').emit(...)` | Dual channel | Fired when a room is deleted. All subscribers are notified. User-channel delivery ensures the room-card page can react immediately. |
| `room_renamed` | `io.to('room:X').emit(...)` | Room broadcast | Updates room name in cached metadata. |
| `room_disabled` | `io.to('room:X').emit(...)` | Room broadcast | Updates disabled status in cached metadata. |

**Client emits → Server handles (with ACK):**

| Event | Client function | Server handler (index.ts line) | Auth check |
|---|---|---|---|
| `join_room` | `connectToRoom` (L122/152) | L216 | `isActiveMember` |
| `send_message` | `sendEncryptedMessage` (L255) | L269 | `isActiveMember` + `isRoomDisabled` + reply validation |
| `edit_message` | `editEncryptedMessage` (L294) | L433 | `isActiveMember` + `isRoomDisabled` + message ownership + 15min window + max 2 edits |
| `delete_message` | `deleteEncryptedMessage` (L300) | L575 | `isActiveMember` + `isRoomDisabled` + message ownership |
| `typing_start` | `emitTypingStart` (L273) | L648 | `isActiveMember` + `isRoomDisabled` |
| `typing_stop` | `emitTypingStop` (L277) | L683 | `isActiveMember` + `isRoomDisabled` |
| `sync_since` | `syncSince` (L263) | L709 | `isActiveMember` |
| `sync_metadata` | (new — client emits on reconnect) | (new handler) | `isActiveMember` for each room |
| `subscribe_room` | (new — `GlobalSocketProvider`) | (new handler) | `isActiveMember` |
| `unsubscribe_room` | (new — triggered by membership changes) | (new handler) | no auth check (server-side only or trusted client) |
| `heartbeat` | `startHeartbeat` (L90) → `startGlobalHeartbeat` | L767 | `socket.data.userId` (roomId optional) |
| `watch_room_membership` | `watchRoomMembership` (L219) | L206 | ACK only |
| `leave_room` | (no direct caller — server emit only) | L245 | no auth check |
| `viewing_room_start` | (new — room page mount) | (new handler) | `isActiveMember` |
| `viewing_room_stop` | (new — room page unmount) | (new handler) | no auth check |

### 1.4 Authentication/Authorization Flow

```
Client → POST /api/ws/ticket { roomId }
  → requireSession() (better-auth cookie)
  → getMembership(roomId, userId) → must be APPROVED + not blocked
  → createWsTicket(userId, roomId) → HMAC-SHA256 { userId, roomId, exp: +60s, type: "room" }
  → return { ticket, wsUrl }

Client → io(wsUrl, { auth: { ticket } })
Server middleware (index.ts L178-195):
  → verifyWsTicket(ticket)
  → socket.data.userId = payload.userId
  → socket.data.roomId = payload.roomId   ← KEY: baked at connection time

Per-event (send_message, etc.):
  → const roomId = payload?.roomId || socket.data.roomId
  → isActiveMember(roomId, userId)  ← MongoDB query EVERY event
```

### 1.5 Reconnection Flow (Current)

```
Socket disconnects
  → Socket.IO Tier 1: 10 Fibonacci attempts (1s → 21s cap)
  → On reconnect: handleReconnect() → emit "join_room" with ACK → runSync() → outbox.flushImmediate() → refreshMembers
  → On reconnect_failed: ReconnectionManager Tier 2 (34s → 610s cap)
     → createFreshConnection() → fetch /api/ws/ticket with roomId → new io()
```

### 1.6 Outbox Flow (Current)

```
User sends message → addOutboxEntry (PENDING, nextRetryAt: now+10s)
  → Optimistic UI (buildOptimisticUiMessage)
  → sendEncryptedMessage over socket
     → ACK received → deleteOutboxEntry → reconcileOptimisticMessage
     → ACK error → entry moved to RETRYING, retryCount=1, nextRetryAt: now+5s
     → Socket disconnected → OutboxRetryWorker polls every 2s
        → getEligibleRetryEntries(roomId, now)
        → transmit(entry) → "sent" / "failed" / "retry"
        → max 5 retries → FAILED → cleanup after 24h

Lost ACK recovery (EC-02):
  → Broadcast room_message with same cipherprint arrives
  → findOutboxEntryByCipherprint matches → delete entry + reconcile
```

### 1.7 Presence Flow (Current)

```
Socket joins room:
  → presence.connect(roomId, userId) increments connectionCount
  → io.to('room:X').emit('PRESENCE_UPDATED', { isOnline: true })

Heartbeat every 30s:
  → startHeartbeat() sends { roomId: activeRoomId }
  → presence.heartbeat(roomId, userId) updates lastHeartbeat

Socket leaves/disconnects:
  → presence.disconnect(roomId, userId) decrements → if 0, user removed
  → io.to('room:X').emit('PRESENCE_UPDATED', { isOnline: false })

Stale eviction (every 30s):
  → entries with lastHeartbeat > 60s ago → emit isOnline: false + evict

Cleanup callback in index.ts (L779):
  → for each evicted: io.to(roomId).emit(PRESENCE_UPDATED, isOnline: false)
```

### 1.8 Key Rotation Flow (Current)

```
Trigger: PENDING_KEY_ROTATION event from /internal/key-rotation-pending
  → Client: setPendingKeyRotation=true, setIsRotating=true

On room bootstrap (already in rotation):
  → Lock acquisition: claimRotationLock(roomId, version)
  → If acquired: generateRoomKey → wrapForAllMembers → completeRotation → syncKeyVersion
  → flushRotationQueue: re-encrypt queued outbox entries with new key

Mid-session:
  → PENDING_KEY_ROTATION event on socket → same rotate-queue flow
  → KEY_ROTATION_COMPLETE → flushRotationQueue with new version
```

---

## 2. Architecture Changes Required

### 2.1 Server Changes (websocket-server)

#### 2.1.1 New File: `subscription-manager.ts`

```typescript
class SubscriptionManager {
  // Called once per connection — bulk subscribes based on DB query
  async initializeSubscriptions(socket: AuthedSocket): Promise<number>

  // Dynamic subscribe mid-session (user joins new room)
  async subscribeRoom(socket: AuthedSocket, roomId: string): Promise<boolean>

  // Dynamic unsubscribe (user is kicked / leaves)
  async unsubscribeRoom(socket: AuthedSocket, roomId: string): Promise<void>

  // Cleanup on disconnect — iterate subscribedRooms, disconnect presence for each
  async handleDisconnect(socket: AuthedSocket): Promise<void>

  getSubscribedRooms(socket: AuthedSocket): Set<string>
}
```

#### 2.1.2 Changes to `index.ts`

**Middleware (L178-195):**
- Must handle TWO ticket types:
  - Type `"room"`: existing flow → sets `socket.data.roomId` (backward compat)
  - Type `"user"`: new global flow → sets only `socket.data.userId`, NO `roomId`
- Add `socket.data.subscribedRooms = new Set<string>()` to middleware or connection handler.

**Connection handler (L197→):**
- After `socket.join('user:' + userId)` (L204):
  - Add: `await subscriptionManager.initializeSubscriptions(socket)`
  - Queries `room_memberships` for all `{ userId, status: APPROVED, isBlocked: false }`

**`join_room` handler (L216-243):**
- Under global socket: room is already joined from `initializeSubscriptions`
- Still verify `isActiveMember` (user may have been kicked and rejoined)
- If not already in `socket.data.subscribedRooms`, call `subscriptionManager.subscribeRoom()`
- Set `socket.data.roomId` to track "currently viewing" room
- Emit `viewing_room_start` event (new)
- Presence: keep existing `presence.connect()` for backward compat; add viewing dimension later

**`leave_room` handler (L245-267):**
- Under global socket: don't leave the Socket.IO room — user stays subscribed
- Instead: emit `viewing_room_stop`, call viewing presence disconnect
- Clear `socket.data.roomId`

**`disconnect` handler (L751-764):**
- Replace iteration of `socket.data.joinedRooms` with `subscriptionManager.handleDisconnect(socket)`

**Heartbeat handler (L767-776):**
- New payload: `{ activeRoomId?: string | null }` (roomId becomes optional)
- Server logic:
  - `presence.globalHeartbeat(userId)` — always, keeps global online status
  - If `activeRoomId`: `presence.roomHeartbeat(activeRoomId, userId)` — room-level presence

**New `sync_metadata` event:**
```typescript
socket.on('sync_metadata', async (_, ack) => {
  const rooms = [...socket.data.subscribedRooms];
  const metadata = await getRoomsMetadata(rooms, socket.data.userId);
  ack({ ok: true, metadata });
});
```
Returns: `{ roomId, latestMessageId, latestMessageCreatedAt, roomName, memberCount, isDisabled }` for each room. No message bodies — just IDs for the client to compare against IndexedDB cache. The client computes unread counts locally after reconnect by comparing `latestMessageId` with the last known message ID from IndexedDB for each room. Live unread updates come from `user_unread_increment` events, not from `sync_metadata`.

**New `subscribe_room` event (client→server):**
- Checks `isActiveMember`, then `subscriptionManager.subscribeRoom()`. Used when user joins a new room mid-session.

**New `unsubscribe_room` event (client→server):**
- `subscriptionManager.unsubscribeRoom()`. Used when `/internal/membership-updated` signals kick/block.

**New lightweight event: `room_new_message_notify` (room broadcast):**
- In `send_message` handler, after broadcasting `room_message` to `io.to('room:X')`:
```typescript
// Room broadcast — for reordering room list, updating last-message timestamps
io.to('room:' + roomId).emit('room_new_message_notify', {
  roomId, senderId, senderName, senderUserIndex, senderPfp,
  messageType, createdAt, messageId,
  // NO ciphertext, NO iv, NO authTag — signal only
});
```

**New per-user unread event: `user_unread_increment` (user channel):**
- In `send_message` handler, after the room broadcast, iterate each subscribed socket and emit to non-viewing users individually:
```typescript
// For each socket subscribed to this room, determine if they are VIEWING
const roomSockets = await io.in('room:' + roomId).fetchSockets();
for (const s of roomSockets) {
  const sock = s as AuthedSocket;
  // Skip the sender — they don't need unread increment for their own message
  if (sock.data.userId === socket.data.userId) continue;
  // Skip users currently VIEWING this room (roomId matches their active viewing room)
  if (sock.data.roomId === roomId) continue;
  // Emit per-user unread increment to the user's personal channel
  io.to('user:' + sock.data.userId).emit('user_unread_increment', {
    roomId,
    senderId: socket.data.userId,
    senderName: senderInfo.name,
    messageType,
    createdAt: savedMessage.createdAt,
  });
}
```

**Key constraint:** The `roomId` check on `sock.data.roomId` is the "viewing" check. Under the global socket, `socket.data.roomId` is set to the user's currently active room when they open a room page. Users browsing the room list or other pages will have `socket.data.roomId` unset or set to a different room, and will correctly receive the unread increment.

**New events: `viewing_room_start` / `viewing_room_stop`:**
- Emitted in `join_room` / `leave_room` handlers respectively.
- Payload: `{ roomId, userId }`.

#### 2.1.3 Membership Lifecycle Events — Dual Channel Delivery

All membership lifecycle events fire on TWO channels simultaneously: the **room broadcast** (for members viewing the room) and the **user channel** (for the affected user, enabling immediate UI reactions).

**`room_member_joined` (dual channel):**

Room channel (io.to room broadcast) — updates member list for current viewers:
```typescript
io.to('room:' + roomId).emit('room_member_joined', {
  roomId, userId, role, userIndex, userName, userPfp
});
```

User channel — notifies the joined user with full room metadata for immediate app integration:
```typescript
io.to('user:' + userId).emit('room_member_joined', {
  roomId, roomName, memberCount, status: 'APPROVED'
});
```

**`room_member_left` (dual channel):**

Room channel:
```typescript
io.to('room:' + roomId).emit('room_member_left', {
  roomId, userId, userName
});
```

User channel — confirmation for the leaving user:
```typescript
io.to('user:' + userId).emit('room_member_left', {
  roomId, roomName, reason: 'left'
});
```

**`room_member_kicked` (dual channel):**

Room channel — update member list, remove kicked user:
```typescript
io.to('room:' + roomId).emit('room_member_kicked', {
  roomId, userId, kickedBy, reason
});
```

User channel — force immediate UI reaction (toast + redirect):
```typescript
io.to('user:' + userId).emit('room_member_kicked', {
  roomId, roomName, kickedBy, reason
});
// ALSO: immediately call subscriptionManager.unsubscribeRoom for this user's sockets
// This prevents them from receiving further room events
```

**`room_deleted` (dual channel):**

Room channel — notified to all subscribers:
```typescript
io.to('room:' + roomId).emit('room_deleted', { roomId, roomName });
```

User channel — notified to all subscribers individually (ensures room-card page catches it):
```typescript
const roomSockets = await io.in('room:' + roomId).fetchSockets();
for (const s of roomSockets) {
  io.to('user:' + (s as AuthedSocket).data.userId).emit('room_deleted', {
    roomId, roomName
  });
}
// Also: await subscriptionManager.unsubscribeAllFromRoom(roomId);
```

**`room_renamed` (room broadcast only):**
```typescript
io.to('room:' + roomId).emit('room_renamed', { roomId, newName });
```

**`room_disabled` (room broadcast only):**
```typescript
io.to('room:' + roomId).emit('room_disabled', { roomId, isDisabled: true });
```

**Where these events are triggered:**
- REST endpoints that modify membership (`/api/rooms/:roomId/join`, `/api/rooms/:roomId/leave`, `/api/rooms/:roomId/kickout/:userId`) call the internal websocket HTTP endpoint or emit directly via a shared pub/sub mechanism.
- The existing `/internal/membership-updated` endpoint in `index.ts` must be extended to emit the dual-channel events: `room_member_joined` (when status=APPROVED), `room_member_left`/`room_member_kicked` (when status=LEFT or isBlocked=true), plus `unsubscribeRoom` for kicked/blocked users.

#### 2.1.3 Membership Cache (Per-Socket, TTL=60s)

```typescript
socket.data.membershipCache = new Map<string, { valid: boolean, expiresAt: number }>();

async function checkMembership(socket: AuthedSocket, roomId: string): Promise<boolean> {
  const cached = socket.data.membershipCache.get(roomId);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;
  const valid = await isActiveMember(roomId, socket.data.userId);
  socket.data.membershipCache.set(roomId, { valid, expiresAt: Date.now() + 60_000 });
  return valid;
}
```

Replace `await isActiveMember(roomId, userId)` with `await checkMembership(socket, roomId)` in all event handlers.

**Cache invalidation:** When `/internal/membership-updated` fires with `isBlocked: true` or `status: LEFT`:
1. Find sockets in `user:{userId}` room
2. For each: delete cached entry → if in subscribedRooms, `subscriptionManager.unsubscribeRoom(socket, roomId)`

#### 2.1.4 DB Query: `getApprovedMemberships(userId)`

```typescript
async function getApprovedMemberships(userId: string): Promise<string[]> {
  const db = await getDb();
  const memberships = await db.collection("room_memberships").find({
    userId: new ObjectId(userId), status: "APPROVED", isBlocked: false,
  }, { projection: { roomId: 1 } }).toArray();
  return memberships.map(m => m.roomId.toHexString());
}
```
Requires compound index: `{ userId: 1, status: 1 }` on `room_memberships`.

#### 2.1.5 Presence System Redesign (Phase 4)

Two dimensions:
1. **Global presence**: userId → { connectionCount, lastHeartbeat } — is user connected at all?
2. **Viewing presence**: roomId → userId → { lastHeartbeat } — is user actively viewing?

New `PresenceStore` interface methods:
```typescript
globalConnect(userId: string): number;
globalDisconnect(userId: string): number;
globalHeartbeat(userId: string): void;
isGloballyOnline(userId: string): boolean;
viewingConnect(roomId: string, userId: string): void;
viewingDisconnect(roomId: string, userId: string): void;
viewingHeartbeat(roomId: string, userId: string): void;
viewingUsers(roomId: string): Set<string>;
```

`PRESENCE_UPDATED` broadcast: initially keep scoped to `io.to('room:X')` (all subscribers). Clients without room page mounted won't have handlers registered, so the event is harmless. Optimize later by scoping to viewing users only.

---

### 2.2 Client Changes (frontend)

#### 2.2.1 New Files

**`packages/frontend/src/lib/global-socket-context.tsx`:**
```typescript
interface GlobalSocketContext {
  socket: Socket | null;
  connected: boolean;
  subscribedRooms: Set<string>;
  subscribeRoom: (roomId: string) => Promise<void>;
  unsubscribeRoom: (roomId: string) => Promise<void>;
}

function GlobalSocketProvider({ children }) {
  // On mount (when session.user exists): connectAsUser() → global socket
  // On disconnect: Socket.IO auto-reconnect → server rebuilds subscriptions
  // Expose socket, connection state, subscribe/unsubscribe via context

  // PERMANENT listeners registered here (never unregistered):

  // 1. user_unread_increment → update unreadStore.increment(payload.roomId)
  // 2. room_member_kicked (user channel) → toast + redirect if currently in that room
  // 3. room_member_left (user channel) → SWR revalidation for room list
  // 4. room_member_joined (user channel) → SWR revalidation + subscribe to new room
  // 5. room_deleted (user channel) → SWR revalidation, redirect if viewing that room
  // 6. membership_updated → SWR revalidation for room list + pending requests
  // 7. REQUEST_APPROVED → SWR revalidation for pending requests + subscribe to the room
  // 8. REQUEST_REJECTED → SWR revalidation for pending requests
}

function useGlobalSocket(): GlobalSocketContext {}
```

**`packages/frontend/src/lib/global-reconnection-manager.ts`:**
- Adapted from current `ReconnectionManager` but **completely room-agnostic** (no `roomId` parameter).
- Uses user-scoped tickets via `POST /api/ws/user-ticket`.
- **Two-Tier Fibonacci Reconnection**:
  - *Tier 1 (Socket.IO built-in loop)*: 10 attempts with Fibonacci delays (1s → 21s max cap, 0.2 randomization jitter factor).
  - *Tier 2 (Fallback loop)*: Takes over on `reconnect_failed`. Continues Fibonacci sequence from `fib(8)=34s` up to `fib(14)=610s` (~10 mins). Every 3rd attempt fetches a fresh user ticket from `/api/ws/user-ticket`.
- On successful reconnect:
  1. Server automatically rebuilds subscriptions from MongoDB for all approved rooms.
  2. Client emits `sync_metadata` to update local unread counts and online presence states from TTL cache.
  3. If a chat room is currently open/mounted, triggers background `runSync(activeRoomId)` (DELTA/REPLACE).
  4. Triggers `globalOutboxWorker.flushImmediate()` to drain all pending IndexedDB outbox messages across all rooms.

#### 2.2.1.1 Global App Lifecycle (`packages/frontend/src/lib/global-lifecycle.ts`)

- **Singleton Scope**: Unlike the previous per-room `AppLifecycle` class, `GlobalAppLifecycle` is instantiated once inside `GlobalSocketProvider` when the user authenticates and runs continuously across all page navigations.
- **Event Listeners**:
  1. `document.addEventListener("visibilitychange", ...)` — detects when the browser tab returns to the foreground (`document.visibilityState === "visible"`).
  2. `window.addEventListener("online", ...)` — detects when network connectivity is restored.
- **Debounced Trigger Logic**:
  - When the app returns to foreground or network comes online:
  - Checks if `globalSocket` is disconnected (`!socket?.connected`).
  - If disconnected, triggers `globalReconnectionManager.forceReconnect()` immediately (skipping any remaining fallback timer delays).
  - Debounced by `DEBOUNCE_MS = 500` to prevent rapid duplicate reconnects.
- **Proactive Ticket Renewal**:
  - While connected, refreshes the user ticket every 45 seconds in the background so that any sudden network drop can reconnect instantly with a warm ticket.

**`packages/frontend/src/lib/global-outbox-worker.ts`:**
- Singleton, not per-room. Constructor takes NO roomId.
- Tick: calls NEW `getAllEligibleRetryEntries(now)` (no roomId filter, new function in `outbox-db.ts`)
- Groups eligible entries by `roomId`, flushes each group sequentially. Different rooms flush in parallel.
- Socket connectivity guard: checks `globalSocket.connected` before transmit.
- `flushRoomImmediate(roomId)` method for on-demand flush when a room page opens.
- `flushImmediate()` method for post-reconnect flush of ALL rooms.

**`packages/frontend/src/lib/unread-store.ts`:**
```typescript
import { create } from "zustand";

interface UnreadState {
  counts: Record<string, number>; // roomId → count
  increment: (roomId: string) => Promise<void>;
  clear: (roomId: string) => Promise<void>;
  set: (roomId: string, count: number) => Promise<void>;
  loadFromDB: () => Promise<void>; // hydrate on boot
}
```

The Zustand store is backed by IndexedDB in a dedicated `unread-counts` object store (keyed by `roomId`, added to the existing `dechat-crypto-store` database). Every mutation (`increment`, `clear`, `set`) writes through to IndexedDB first, then updates the in-memory state. On app boot, `GlobalSocketProvider` calls `loadFromDB()` to hydrate the store.

**Unread count lifecycle:**

1. **Boot/reconnect**: `loadFromDB()` hydrates from IndexedDB. Then `sync_metadata` from the server provides `latestMessageId` per room — the client compares with the last seen message ID in IndexedDB to compute the correct count. This handles the case where messages arrived while the app was closed.

2. **Live incrementing**: `user_unread_increment` arrives on the user channel → `increment(roomId)` → writes to IndexedDB (count += 1) → updates Zustand in-memory store → triggers re-render of room list badges.

3. **Room opened (viewing)**: The room page's bootstrap Phase 1 updates `lastVisitedAt` on the server via the existing room metadata REST call. Additionally, the room page calls `clearUnread(roomId)` immediately on mount → sets IndexedDB count to 0 → updates Zustand → badge disappears.

4. **User kicked / leaves room**: The `room_member_kicked` or `room_member_left` handler in `GlobalSocketProvider` calls `clearUnread(roomId)` → count set to 0 in IndexedDB + removed from Zustand.

5. **Room deleted**: Same — `clearUnread(roomId)` + the room is removed from the room list via SWR revalidation.

**IndexedDB schema addition:**
```typescript
// In the existing DB upgrade (dechat-crypto-store, DB_VERSION bump to 5):
db.createObjectStore('unread-counts', { keyPath: 'roomId' });
```

**Key constraint**: The server's `lastVisitedAt` on `room_memberships` is the **authoritative** source. If the client's IndexedDB unread count diverges (e.g., after clearing browser data), the next `sync_metadata` or room open recalculates the correct count from `lastVisitedAt`. The IndexedDB count is a **cached replica** for fast rendering, not the source of truth.

#### 2.2.2 Changes to `socket-client.ts`

Preserve backward compatibility. New exports:
```typescript
export const USE_GLOBAL_SOCKET = process.env.NEXT_PUBLIC_USE_GLOBAL_SOCKET === "true";

let globalSocket: Socket | null = null;
export function getGlobalSocket(): Socket | null { return globalSocket; }
export function setGlobalSocket(s: Socket): void { globalSocket?.disconnect(); globalSocket = s; }
export function startGlobalHeartbeat(activeRoomId?: string | null): void { /* sends { activeRoomId } */ }
```

#### 2.2.3 Changes to `outbox-db.ts`

New function:
```typescript
export async function getAllEligibleRetryEntries(now: number): Promise<OutboxEntry[]> {
  // Same as getEligibleRetryEntries but WITHOUT roomId filter
  // Uses by-next-retry index, filters status !== "FAILED"
}
```

#### 2.2.4 Changes to `hooks/use-swr-hooks.ts`

**`usePendingRequests()` (L159-182):** Currently creates a separate user socket via `connectAsUser()`. Switch to consuming global socket from context:
- Remove `connectAsUser()` call
- Import `useGlobalSocket()`
- Register REQUEST_APPROVED/REJECTED/membership_updated listeners on global socket
- This eliminates the duplicate socket connection

#### 2.2.5 Rate Limiting Strategy (REST Routes & WebSocket Events)

To prevent abuse, resource exhaustion, and spam across all API routes and WebSocket events, a structured rate-limiting layer is integrated:

**1. HTTP REST API Route Limits (via Middleware / Route Wrappers):**
- **Auth Endpoints (`/api/auth/*`)**: 10 requests per 1 minute per IP (prevents brute-force on sign-in/sign-up).
- **WS Ticket Requests (`/api/ws/ticket`, `/api/ws/user-ticket`)**: 15 requests per 1 minute per User ID (prevents ticket harvest/spam).
- **Room Creation (`POST /api/rooms`)**: 20 rooms created per 1 hour per User ID.
- **Room Join Requests (`POST /api/rooms/join`, `/api/rooms/:roomId/join`)**: 40 requests per 10 minutes per User ID.
- **Key Rotation Endpoints (`POST /api/rooms/:roomId/key-rotation/*`)**: 20 claims/releases per 1 minute per Room ID.
- **General REST APIs (`GET /api/rooms/*`, `/api/me`)**: 200 requests per 1 minute per User ID.

**2. WebSocket Event Rate Limits (Server-Side Socket Middleware):**
- **Message Sending (`send_message`, `edit_message`)**: 20 messages per 5 seconds per socket connection (burst limit 15).
- **Typing Events (`typing_start`, `typing_stop`)**: 50 events per 5 seconds per socket connection (throttled).
- **Heartbeat (`heartbeat`)**: Max 5 request per 15 seconds per socket.
- **Sync/Metadata Queries (`sync_since`, `sync_metadata`)**: 30 requests per 1 minute per socket.

**3. Execution Architecture:**
- In-memory token bucket sliding window (`Map<key, { count, resetAt }>`) per server instance.
- Standardized HTTP `429 Too Many Requests` response headers (`Retry-After`).
- For WebSocket events, violating rate limits returns socket ACK `{ ok: false, error: "RATE_LIMIT_EXCEEDED" }` without dropping the WebSocket connection.

#### 2.2.6 Changes to `app/layout.tsx` + `app-shell.tsx`

Mount `GlobalSocketProvider` inside `ShellContent` in `app-shell.tsx`, wrapping `{children}`. Only active when `session?.user` is truthy. The provider handles its own mount/unmount lifecycle.

#### 2.2.7 Changes to `app/rooms/[roomId]/page.tsx` (THE CRITICAL FILE)

**Optimistic Room Name State & Ground Truth Hydration:**
- **Problem**: When a user clicks on a room card (from Discover, Joined Rooms, or via navigation link), the loading header previously displayed a generic placeholder like `"Room"` while establishing connection or fetching room details.
- **Solution**:
  1. When navigating to `/rooms/[roomId]`, pass the cached/card room state (e.g. `roomName`, `joinPolicy`, `memberCount`) via router navigation state, query params, or SWR pre-warmed cache.
  2. While connecting or executing Phase 1 REST calls, the header immediately renders the **optimistic room name** passed from the card context.
  3. Once Phase 1 completes (`/api/rooms/${roomId}` returns), the component seamlessly hydrates the state with the **official ground-truth room metadata** from MongoDB.

**Phase 4 conditional (socket connection):**

When `USE_GLOBAL_SOCKET=true`:
1. REMOVE: `connectToRoom(roomId)` call
2. REMOVE: `new ReconnectionManager(roomId, ...)` — global reconnection manager handles this
3. REMOVE: `new AppLifecycle(...)` — global lifecycle handles this (but still need per-room foreground detection)
4. CHANGE: `startHeartbeat()` → `startGlobalHeartbeat(roomId)` (passes `activeRoomId`)
5. CHANGE: `new OutboxRetryWorker(roomId, transmit)` → `globalOutboxWorker.flushRoomImmediate(roomId)`
6. ADD: On mount, emit `viewing_room_start` (or reuse `join_room`) to track viewing
7. ADD: On mount, call `clearUnread(roomId)` to reset the unread counter for this room in IndexedDB + Zustand
8. ADD: On unmount, emit `viewing_room_stop`
9. CRITICAL: On unmount, DO NOT disconnect socket — only remove event handlers with `socket.off()`
10. ADD: `socket.off()` cleanup for ALL 9 event handlers in the useEffect return

**Event handler registration pattern (for both paths):**
```typescript
const socket = USE_GLOBAL_SOCKET ? getGlobalSocket() : await connectToRoom(roomId);

const onRoomMessage = (incoming: RealtimeRoomMessage) => {
  if (incoming.roomId !== roomId) return;
  // ... existing handler logic (unchanged)
};

socket.on('room_message', onRoomMessage);
// ... 8 more handlers

// Cleanup:
return () => {
  socket.off('room_message', onRoomMessage);
  socket.off('message_edited', onMessageEdited);
  socket.off('message_deleted', onMessageDeleted);
  socket.off('typing_started', onTypingStarted);
  socket.off('typing_stopped', onTypingStopped);
  socket.off('PRESENCE_UPDATED', onPresenceUpdated);
  socket.off('PENDING_KEY_ROTATION', onPendingRotation);
  socket.off('KEY_ROTATION_COMPLETE', onRotationComplete);
  socket.off('KEY_ROTATION_FAILED', onRotationFailed);
};
```

**Complete list of events with roomId filter:**

| Handler | Event | RoomId filter required? |
|---|---|---|
| `onRoomMessage` | `room_message` | Yes — `incoming.roomId !== roomId` |
| `onMessageEdited` | `message_edited` | Yes |
| `onMessageDeleted` | `message_deleted` | Yes — `payload.roomId !== roomId` |
| `onTypingStarted` | `typing_started` | Yes — `payload.roomId !== roomId` |
| `onTypingStopped` | `typing_stopped` | Yes — `payload.roomId !== roomId` |
| `onPresenceUpdated` | `PRESENCE_UPDATED` | Yes — `payload.roomId !== roomId` |
| `onPendingRotation` | `PENDING_KEY_ROTATION` | Yes — `payload.roomId !== roomId` |
| `onRotationComplete` | `KEY_ROTATION_COMPLETE` | Yes — `payload.roomId !== roomId` |
| `onRotationFailed` | `KEY_ROTATION_FAILED` | Yes — `payload.roomId !== roomId` |

**Bootstrap changes (L986-1206, Phase 4 block):**
```typescript
if (USE_GLOBAL_SOCKET) {
  const socket = getGlobalSocket();
  if (!socket) return;

  // Register all 9 event handlers with named references for cleanup
  // ...

  // Track viewing
  socket.emit('viewing_room_start', { roomId });

  // Clear unread counts for this room
  clearUnread(roomId);  // from unread-store — writes to IndexedDB + updates Zustand

  // Heartbeat with activeRoomId
  startHeartbeat(); // or startGlobalHeartbeat(roomId)

  // Flush this room's outbox
  globalOutboxWorker.flushRoomImmediate(roomId);

  // Foreground detection for THIS room
  const lifecycle = new AppLifecycle(() => globalReconnectionManager.forceReconnect());
  lifecycle.start();
  lifecycleRef.current = lifecycle;
} else {
  // EXISTING per-room path (unchanged)
}
```

**Cleanup changes (L1248-1263):**
```typescript
return () => {
  mounted = false;
  reconnectionRef.current?.stop();
  lifecycleRef.current?.stop();

  // Remove handlers
  if (USE_GLOBAL_SOCKET) {
    const socket = getGlobalSocket();
    socket?.off('room_message', onRoomMessageRef.current);
    // ... off all 9 handlers
    socket?.emit('viewing_room_stop', { roomId });
    stopHeartbeat();
    // DO NOT disconnect socket
  } else {
    stopHeartbeat();
    disconnectSocket();
  }
  // ...
};
```

#### 2.2.7 Changes to `app/rooms/joined/page.tsx`

Consume global socket context and register user-channel event listeners. The unread count is driven by `user_unread_increment` (user channel) rather than `room_new_message_notify` (room broadcast), since the user channel always delivers to the right user directly:

```typescript
const { socket } = useGlobalSocket();
const { counts, increment, clear: clearUnread } = useUnreadStore(); // from unread-store.ts

useEffect(() => {
  if (!socket) return;

  const onUnreadIncrement = (payload: { roomId: string; senderId: string; senderName?: string; messageType: string; createdAt: string }) => {
    increment(payload.roomId);
    // Revalidate room list to get updated latestMessage timestamps
    mutateMyRooms();
  };

  const onRoomDeleted = (payload: { roomId: string }) => {
    clearUnread(payload.roomId);
    mutateMyRooms();
  };

  const onMemberKicked = (payload: { roomId: string; roomName: string }) => {
    clearUnread(payload.roomId);
    mutateMyRooms();
  };

  const onMemberLeft = (payload: { roomId: string }) => {
    clearUnread(payload.roomId);
    mutateMyRooms();
  };

  const onMemberJoined = (payload: { roomId: string }) => {
    mutateMyRooms();
  };

  socket.on('user_unread_increment', onUnreadIncrement);
  socket.on('room_deleted', onRoomDeleted);        // user channel delivery
  socket.on('room_member_kicked', onMemberKicked);   // user channel delivery
  socket.on('room_member_left', onMemberLeft);       // user channel delivery
  socket.on('room_member_joined', onMemberJoined);   // user channel delivery

  return () => {
    socket.off('user_unread_increment', onUnreadIncrement);
    socket.off('room_deleted', onRoomDeleted);
    socket.off('room_member_kicked', onMemberKicked);
    socket.off('room_member_left', onMemberLeft);
    socket.off('room_member_joined', onMemberJoined);
  };
}, [socket, mutateMyRooms]);
```

---

## 3. Server-Side Event Routing After Migration

```
Server wants to broadcast a new message to room X:

1. io.to('room:X').emit('room_message', { ...full message... })
2. Socket.IO internal: looks up 'room:X' in adapter.rooms
3. Sends event to all sockets that called socket.join('room:X')
4. Client receives on its SINGLE global socket
5. Room page handler filters: if (incoming.roomId !== roomId) return;
6. For rooms NOT currently open: the handler is NOT registered
   → event received but ignored (no memory leak)

For unread counts (user_unread_increment):
  Server iterates subscribed sockets for room X, skips the sender and
  any socket whose socket.data.roomId === roomId (currently viewing).
  Emits io.to('user:Y').emit('user_unread_increment', ...) per user.
  GlobalSocketProvider has a PERMANENT listener → updates unreadStore.

For membership events (kicked, left, joined, room_deleted):
  DUAL channel: io.to('room:X').emit(...) + io.to('user:Y').emit(...)
  Room broadcast → viewers see updated member list / redirects.
  User channel → affected user gets toast + state change immediately,
  even if they're on a different page or the room list.
```

### What stays the same:
- `io.to('room:X').emit(...)` for all room broadcasts
- `io.to('user:Y').emit(...)` for personal notifications (expanded: unread, membership changes)
- Socket.IO rooms as routing primitive
- Per-event auth checks (membership cache layer added)

### What changes:
- Client no longer creates new sockets per room
- Server manages subscriptions at connect time (bulk) + dynamically (mid-session joins/kicks)
- Heartbeat becomes room-optional
- Presence gains viewing dimension
- Outbox worker becomes room-agnostic
- **Unread counts are delivered per-user via user channel, not computed from room broadcasts**
- **Membership lifecycle events are dual-channel (room broadcast + user channel) for immediate UI reactions**
- **Kicked/blocked users are force-unsubscribed from the room's Socket.IO room**
- **Headless Global Key Rotation Worker handles key generation, distribution, lock acquisition, and fallback recovery seamlessly in the background**

---

## 3.1 Headless Global Key Rotation Architecture

Key rotation is an integral pillar of DeChat's End-to-End Encryption (E2EE) security model. Whenever an active member leaves or is kicked from a room, key rotation ensures post-quantum/forward security so former members cannot decrypt future room messages.

Under the single global WebSocket architecture, key rotation is completely decoupled from the chat room UI component and managed headlessly.

### 3.1.1 Key Rotation Triggers & Event Flow

```
Admin kicks user / Member leaves room
                 ↓
REST API (/api/rooms/:roomId/kickout or /leave):
  1. Sets membership status to 'LEFT' in MongoDB
  2. Updates rooms collection: pendingKeyRotation = true
  3. Inserts new version record into room_key_versions (status: 'GENERATING')
  4. Evicts target user socket: socket.leave('room:roomId')
  5. Emits PENDING_KEY_ROTATION to room:roomId via internal WS endpoint
                 ↓
All online members of room:roomId receive PENDING_KEY_ROTATION:
  Payload: { roomId, version, reason, triggerUserId }
```

### 3.1.2 Headless Execution Worker (`GlobalKeyRotationWorker`)

Mounted globally inside `GlobalSocketProvider`, the `GlobalKeyRotationWorker` listens for `PENDING_KEY_ROTATION` across all subscribed rooms:

1. **Atomic Lock Claiming (`claimRotationLock`)**:
   - Each online member's `GlobalKeyRotationWorker` immediately attempts to claim the rotation lock via `POST /api/rooms/:roomId/key-rotation/claim`.
   - The server uses atomic MongoDB operations (`findOneAndUpdate` with `lockOwner: null`) to grant the lock to **exactly one member** (`lockAcquired === true`).
   - The member that wins the lock becomes the **Rotation Host**.

2. **Key Generation & Wrap Distribution (Rotation Host)**:
   - The Rotation Host generates a fresh AES-256-GCM room key via Web Crypto API.
   - Fetches the active member list (`GET /api/rooms/:roomId/members`).
   - Encrypts/wraps the new room key individually using each remaining member's public RSA key (`wrapRoomKeyForPublicKey`).
   - Posts distributions via `POST /api/rooms/:roomId/key-rotation/complete` with payload `{ version, distributions }`.
   - Stores the new AES key locally in IndexedDB (`storeRoomKeyVersion`).
   - Calls `POST /api/rooms/:roomId/membership/sync-key-version` to update local version pointer.
   - Flushes rotation-queued outbox entries (`flushRotationQueue`) re-encrypted with the new key version.

3. **Fallback Polling & Lock Expiry (Non-Host Members)**:
   - Members that receive `lockAcquired === false` enter a fallback monitoring loop (polling `GET /api/rooms/:roomId` every 2 seconds for up to 30 seconds).
   - **Mid-Rotation Disconnect / Exit Recovery**: If the Rotation Host disconnects, closes their browser, or crashes mid-rotation, the MongoDB rotation lock expires after a 30-second TTL (`lockExpiry`).
   - The next polling cycle detects `lockExpiry < now` and allows another online member to claim the lock and complete key rotation.

4. **Completion Broadcast & Key Store Hydration**:
   - Upon successful rotation, the server sets `pendingKeyRotation: false`, updates `lastKeyVersion`, and emits `KEY_ROTATION_COMPLETE` to `room:roomId`.
   - All online members (even those not viewing the room) receive `KEY_ROTATION_COMPLETE`:
     - Fetch their wrapped key distribution (`fetchMyKeyDistributions`).
     - Decrypt/unwrap the AES key with their private RSA key.
     - Store the new key version in IndexedDB (`storeRoomKeyVersion`).
     - Auto-flush any pending rotation-queued outbox entries re-encrypted under the new version.

### 3.1.3 Edge Cases & Fail-Safe Matrix

| Edge Case Scenario | Recovery Mechanism | Result |
|---|---|---|
| Single online member left in room after kick | Single remaining member claims lock, generates key, wraps for self, completes. | Room security updated seamlessly. |
| All remaining members offline when kick happens | Rotation remains `pendingKeyRotation: true`. First member to connect/reconnect receives pending status on boot/sync and completes rotation. | Zero key leak; key rotated upon next member login. |
| Rotation Host crashes mid-RSA wrap loop | MongoDB lock TTL (30s) expires. Fallback polling by second member claims lock and completes. | Rotation completes via secondary member. |
| Message sent during active rotation window | Client tags message with `isRotationQueued: true` and retains plaintext in IndexedDB outbox. Once `KEY_ROTATION_COMPLETE` fires, `flushRotationQueue` encrypts with new key version and transmits. | No message loss; zero encryption under revoked key. |
| Kicked user tries to fetch new key distribution | API `/api/rooms/:roomId/my-key-distribution` checks membership `status === 'APPROVED'`. Kicked user receives `403 Forbidden`. | Kicked user cannot access new key version. |

---

## 4. Migration Phases

### Phase 0: Pre-Work (No behavioral change) ✅ COMPLETED 2026-07-25

**Server:** ✅
- [x] Add `subscription-manager.ts`
- [x] Add `getApprovedMemberships(userId)` to `db.ts`
- [x] Add `membershipCache` to socket data + `checkMembership()` helper
- [x] Add `sync_metadata` server-side handler
- [x] Add `subscribe_room` and `unsubscribe_room` server-side handlers
- [x] Add `room_new_message_notify` emission in `send_message` handler (room broadcast)
- [x] Add `user_unread_increment` emission in `send_message` handler (per-user, skipping sender + viewers)
- [x] Add dual-channel membership events: `room_member_joined`, `room_member_left`, `room_member_kicked`, `room_deleted` (room broadcast + user channel)
- [x] Add `viewing_room_start` / `viewing_room_stop` emission in `join_room` / `leave_room`
- [x] Modify `heartbeat` handler to accept `{ activeRoomId?: string | null }` (backward compat: fall back to `payload.roomId || socket.data.roomId`)
- [x] Modify `/internal/membership-updated` to emit dual-channel membership events + call `unsubscribeRoom` for kicked/blocked users
- [x] Add `globalHeartbeat()` + `isGloballyOnline()` to `presence-store.ts`
- [ ] Add compound index `{ userId: 1, status: 1 }` on `room_memberships` — **TODO**

**Client:** ✅
- [x] Add `USE_GLOBAL_SOCKET` feature flag constant (default: `false`)
- [x] Add `getAllEligibleRetryEntries()` to `outbox-db.ts`
- [x] Create `unread-store.ts` (Zustand + IndexedDB)
- [x] Bump `DB_VERSION` to 6, add `unread-counts` store in `crypto.ts`

### Phase 1: Global Context (Parallel path) ✅ COMPLETED 2026-07-25

**Client:**
- [x] Create `global-socket-context.tsx`
- [x] Create `global-reconnection-manager.ts`
- [x] Create `global-outbox-worker.ts`
- [x] Create `global-lifecycle.ts`
- [x] Mount `GlobalSocketProvider` in `app-shell.tsx` (wraps children)
- [x] Wire `usePendingRequests()` to use global socket instead of `connectAsUser()`
- [x] Add PERMANENT `user_unread_increment` listener in `GlobalSocketProvider` → updates unread store
- [x] Add PERMANENT `room_member_kicked` listener in `GlobalSocketProvider` → clear unread + SWR revalidation (toast/redirect deferred to room page)
- [x] Add PERMANENT `room_member_left` listener in `GlobalSocketProvider` → clear unread + SWR revalidation for room list
- [x] Add PERMANENT `room_member_joined` listener in `GlobalSocketProvider` → SWR revalidation + subscribe to new room
- [x] Add PERMANENT `room_deleted` listener in `GlobalSocketProvider` → clear unread + SWR revalidation
- [x] Add PERMANENT `membership_updated` listener in `GlobalSocketProvider` → SWR revalidation
- [x] Add PERMANENT `REQUEST_APPROVED`/`REQUEST_REJECTED` listeners in `GlobalSocketProvider` → SWR revalidation

### Phase 2: Room Page Migration (Behind flag) ✅ COMPLETED 2026-07-25

- [x] Dual-path `if (USE_GLOBAL_SOCKET)` conditional in Phase 4 block — both paths coexist
- [x] Phase 4 refactor: use `getGlobalSocket()` instead of `connectToRoom()`
- [x] Removed `ReconnectionManager` instantiation, `OutboxRetryWorker` instantiation (global path only)
- [x] Changed heartbeat to `startGlobalHeartbeat(roomId)` (global path)
- [x] Register ALL 9 event handlers with named refs stored in `handlerRef` Map + `socket.off()` cleanup on unmount
- [x] On mount: `viewing_room_start`, on unmount: `viewing_room_stop`, NO `disconnectSocket()` (global path)
- [x] Reconnect handler: `runSync()` + `refreshMembers()` on `io("reconnect")`
- [x] Socket wait polling (200ms) if global socket not yet connected
- [x] `emitWithAck()` auto-detects `USE_GLOBAL_SOCKET` to route through global socket — zero call-site changes
- [ ] `NEXT_PUBLIC_USE_GLOBAL_SOCKET=true` not yet set in `.env.local` — **keep `false` for now**

### Phase 3: Lightweight Events & Room List

**Server:**
- [ ] Add `room_renamed`, `room_disabled` emissions in REST endpoints (via internal WS endpoint)
- [ ] Ensure `room_member_joined`, `room_member_left`, `room_member_kicked`, `room_deleted` emit correctly from membership REST routes

**Client:**
- [ ] Joined rooms page: register handlers for `user_unread_increment`, `room_deleted`, `room_member_kicked`, `room_member_left`, `room_member_joined` (all user channel)
- [ ] Implement unread badges on room cards via `unread-store`
- [ ] Room list: sort by `latestMessageCreatedAt` (realtime via SWR revalidation)
- [ ] Clear unread for a room when the user opens it (room page calls `clearUnread(roomId)`)
- [ ] Room member left/kicked → remove from room list, clear unread

### Phase 4: Presence Redesign

**Server:**
- [ ] Add global presence + viewing presence dimensions to `InMemoryPresenceStore`
- [ ] Modify heartbeat handler for dual dimensions
- [ ] Modify `join_room`/`leave_room` for viewing tracking
- [ ] Optimize `PRESENCE_UPDATED` scope (viewing users only, or keep subscribed + client filter)

**Client:**
- [ ] Room page: track viewing presence
- [ ] Global provider: track global online status

### Phase 5: Notification Integration

- [ ] Web Push subscription endpoint `/api/push/subscribe`
- [ ] Backend: detect disconnected user → send Web Push
- [ ] Service Worker for push event handling
- [ ] Capacitor push notifications plugin (if targeting native)

### Phase 6: Production Rollout & Cleanup

- [ ] Remove feature flag — global socket becomes the ONLY path
- [ ] Remove `connectToRoom()` function
- [ ] Remove per-room `ReconnectionManager`
- [ ] Remove per-room `OutboxRetryWorker` class (keep file for `flushRotationQueue` helper)
- [ ] Remove per-room `AppLifecycle`
- [ ] Remove `disconnectSocket()` (except for sign-out)
- [ ] Clean up dual-path conditionals in room page
- [ ] Performance testing: 200-room subscription, 5K concurrent connections

---

## 5. Verification Plan

### 5.1 Functional Tests

| # | Test | Verification |
|---|---|---|
| 1 | Room isolation | Send msg in Room B while viewing Room A. No cross-room leak. |
| 2 | Kick unsubscribes | Kick user → next event returns "Not a member" → unread stops. |
| 3 | New room mid-session | Join via invite → server `subscribe_room` → new message arrives. |
| 4 | Outbox flushes without room open | Add outbox entry, kill network, restore. Global worker sends msg. |
| 5 | Reconnect rebuilds subscriptions | Disconnect/reconnect → all rooms re-joined → sync_metadata correct. |
| 6 | Multi-tab outbox no duplicates | Two tabs, one offline, send msg. Restore. Only 1 msg reaches server. |
| 7 | Room switch speed | Click room card → messages visible, 200-500ms faster than current. |
| 8 | Unread counts — increment + persist + clear | Send msg in Room B while on room list → `user_unread_increment` fires → IndexedDB entry + Zustand in-memory count updates → badge appears. Open Room B → `clearUnread(roomId)` called on mount → IndexedDB count = 0 + badge gone. Close tab, reopen → `loadFromDB()` hydrates correct count from IndexedDB. Sender and current viewers of Room B do NOT receive increment. |
| 9 | Unread counts — persist across refresh | Build up 5 unread rooms. Refresh the page. On boot, `loadFromDB()` restores counts from IndexedDB. Badges match before-refresh state. |
| 10 | Typing indicators survive navigation | Type A → nav to B → back to A. No stale typing. |
| 11 | Key rotation mid-session | Trigger rotation → pending/completed events → queue flushed. |
| 12 | Reply (quoted msg) | Reply → replyTo subdocument → preview encrypts/decrypts → navigate. |
| 13 | Edit message | Edit within 15-min window → editCount updated → cache updated. |
| 14 | Delete message | Delete → UI removes → IDB cache purged → doesn't reappear. |
| 15 | GIF send | GIF metadata encrypted → renders correctly. |
| 16 | Image upload | Compress → encrypt → upload → send → progress → display. |
| 17 | Video upload | Transcode → thumbnail → per-chunk encrypt → upload → display. |
| 18 | Offline→online | Kill net, send msg (queued), restore. Outbox flushes, msg appears. |
| 19 | App background→foreground | Background 60s → foreground. Reconnect, sync delta. |
| 20 | Sign out | Socket disconnects. Outbox cleared. No leaks. |
| 21 | Token expiry | Fresh ticket fetched on reconnect. Socket stays alive. |
| 22 | Member kicked — immediate UI reaction | Admin kicks user. User receives `room_member_kicked` on user channel → toast appears → if viewing that room, redirected to room list. Room broadcast updates member list for other viewers. |
| 23 | Member left — confirmation | User leaves room. Receives `room_member_left` on user channel → room removed from list. Room viewers see `room_member_left` → member list updates. |
| 24 | Member joined — dual notification | New member approved. Room viewers see `room_member_joined` → member list updates. New member receives `room_member_joined` or `REQUEST_APPROVED` on user channel → room appears in list, socket subscribes to room. |
| 25 | Room deleted — dual notification | Admin deletes room. `room_deleted` fires on room channel + user channels → all viewers get redirected. Room cards remove the room. |

### 5.2 Performance Tests

| Metric | Target |
|---|---|
| 200-room subscription at connect | < 500ms |
| `sync_metadata` (50 rooms) | < 200ms P99 |
| Room page open (no socket reconnect) | ≥ 300ms faster than current |
| Outbox flush latency | < 2s from connectivity restored |
| Additional heap for global context | < 5MB |

### 5.3 Edge Cases

| Case | Expected behavior |
|---|---|
| Token expires mid-session (60s TTL) | Fresh user ticket on reconnect. No interruption if connected. |
| Kicked while connected | `/internal/membership-updated` → `unsubscribeRoom` → cache invalidated. |
| Room deleted while viewing | `room_deleted` event → redirect to list → unsubscribe. |
| Room disabled mid-session | `room_disabled` → input disabled. `send_message` returns ROOM_DISABLED. |
| Browser tab crash | Socket DC → server handles. Reopen → new socket → outbox flushed. |
| Browser data cleared (IndexedDB wiped) | Unread counts lost from IndexedDB. On next `sync_metadata`, client compares `latestMessageId` with empty cache → computes 0 unread (because `lastVisitedAt` on server tracks authoritative state). Counts rebuild from scratch via `user_unread_increment`. |
| Unread count divergence after reconnect | Client's cached unread count may be stale after long disconnection. `sync_metadata` on reconnect returns authoritative `latestMessageId` per room. Client recalculates: count = messages since `lastVisitedAt`. Overwrites IndexedDB cache with authoritative count. |
| Network flapping | Fibonacci backoff + jitter. Reconnect idempotent. |
| 500+ rooms | Bulk join with concurrency limit (50). Index ensures fast query. Cap at 500. |
| No private key (encryption disabled) | Global socket connects. Room ops fail gracefully → recovery prompt. |
| Stale closure over roomId | Handlers use `roomId` from props, not refs. Filter: `incoming.roomId === roomId`. |
| Reply to deleted message | Server check L346: quoted must exist. If deleted → "REPLY_TARGET_NOT_FOUND". |
| Message edit window expired | >15 min → "EDIT_WINDOW_EXPIRED" in ACK. Client shows toast. |
| Max edits reached (2) | → "MAX_EDITS_REACHED" in ACK. Client shows toast. |

---

## 6. File Change Summary

> **Progress as of 2026-07-25:** Phases 0–2 complete. Phases 3–6 pending.
> All changes are behind `NEXT_PUBLIC_USE_GLOBAL_SOCKET` feature flag (default `false`).
> Zero behavioral change when flag is off — full backward compatibility maintained.

### New Files (9/12 created)

| File | Purpose | Status |
|---|---|---|
| `packages/websocket-server/src/subscription-manager.ts` | Server-side subscription management | ✅ Created |
| `packages/websocket-server/src/types.ts` | Shared `AuthedSocket` type (added during implementation) | ✅ Created |
| `packages/frontend/src/lib/global-socket-context.tsx` | React context for global socket | ✅ Created |
| `packages/frontend/src/lib/global-reconnection-manager.ts` | Room-agnostic reconnection | ✅ Created |
| `packages/frontend/src/lib/global-outbox-worker.ts` | Room-agnostic outbox worker | ✅ Created |
| `packages/frontend/src/lib/global-lifecycle.ts` | Singleton AppLifecycle for global socket | ✅ Created |
| `packages/frontend/src/lib/global-key-rotation-worker.ts` | Headless key rotation worker | ⏳ Phase 3+ |
| `packages/frontend/src/lib/unread-store.ts` | Zustand store backed by IndexedDB | ✅ Created |
| `packages/frontend/src/lib/membership-cache.ts` | Client-side membership state helpers | ⏳ Phase 3+ |
| `packages/frontend/src/components/ui/toast.tsx` | Toast notification provider | ⏳ Phase 3+ |
| `packages/frontend/src/components/rooms/room-card.tsx` | Shared Room Card component | ⏳ Phase 3+ |
| `packages/frontend/public/sw.js` | Service worker for push notifications (Phase 5) | ⏳ Phase 5 |
| `packages/frontend/.env.local.example` | Updated with `NEXT_PUBLIC_USE_GLOBAL_SOCKET` | ⏳ Later |

### Modified Files (7/14 complete)

| File | Changes | Status |
|---|---|---|
| `packages/websocket-server/src/index.ts` | Full rewrite: bulk subscribe, dual-channel events, heartbeat, membership cache, sync_metadata, lightweight events | ✅ Done |
| `packages/websocket-server/src/db.ts` | Add `getApprovedMemberships()`, `getRoomsMetadata()` | ✅ Done |
| `packages/websocket-server/src/presence-store.ts` | Add `globalHeartbeat()`, `isGloballyOnline()` to interface + impl | ✅ Done |
| `packages/frontend/src/lib/socket-client.ts` | Feature flag, global socket vars, `emitWithAck` auto-routing, `startGlobalHeartbeat()` | ✅ Done |
| `packages/frontend/src/lib/outbox-db.ts` | Add `getAllEligibleRetryEntries()` | ✅ Done |
| `packages/frontend/src/lib/crypto.ts` | DB_VERSION 5→6, add `unread-counts` store | ✅ Done |
| `packages/frontend/src/lib/outbox-worker.ts` | Add `flushRoomImmediate()` method | ⏳ Phase 3+ |
| `packages/frontend/src/hooks/use-swr-hooks.ts` | `usePendingRequests()`: dual-path (global vs per-room) | ✅ Done |
| `packages/frontend/src/app/layout.tsx` | Import and mount `GlobalSocketProvider` | ⏳ Phase 3+ |
| `packages/frontend/src/components/layout/app-shell.tsx` | Mount `GlobalSocketProvider` inside `ShellContent` | ✅ Done |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Phase 4 dual-path: global socket + 9 handler cleanups | ✅ Done |
| `packages/frontend/src/app/rooms/joined/page.tsx` | User-channel event listeners, unread badges | ⏳ Phase 3 |
| `packages/frontend/src/components/chat/room-header.tsx` | Pass unread count reset callback | ⏳ Phase 3+ |
| `packages/frontend/src/lib/messages-client.ts` | Add `syncMetadata()` client function | ⏳ Phase 3+ |
| `packages/frontend/.env.example` | Add `NEXT_PUBLIC_USE_GLOBAL_SOCKET=false` | ⏳ Later |

### Removed/Deprecated (After Phase 6)
| File | Reason |
|---|---|
| `packages/frontend/src/lib/reconnection-manager.ts` | Replaced by global reconnection manager |
| `packages/frontend/src/lib/lifecycle.ts` | Replaced by global lifecycle |
| `packages/frontend/src/lib/outbox-worker.ts` (class) | Replaced by global outbox worker; keep `flushRotationQueue` helper |

---

## 7. Key Design Decisions

1. **Socket.IO rooms remain the routing primitive** — no custom fan-out logic. Client sees one connection; server routes via Socket.IO adapter.

2. **Dual-path migration with feature flag** — both paths coexist during Phase 1-2. `NEXT_PUBLIC_USE_GLOBAL_SOCKET` controls which path is used. Removed in Phase 6.

3. **Bulk subscription on connect** — queries `room_memberships` once, joins all Socket.IO rooms. Fast (50 rooms = 50 `Set.add()`) and bounded (max 500 room members).

4. **Lightweight events carry metadata only** — `room_new_message_notify` has NO ciphertext, preserving E2EE. Room page fetches content when opened.

5. **Unread counts delivered per-user via user channel** — `user_unread_increment` is emitted to `io.to('user:Y')` for each non-viewing subscriber per message. The server skips the sender and users currently viewing the room (`socket.data.roomId === roomId`). This is more precise than computing unread from room broadcasts, avoids double-counting, and works correctly when the user is on the room list or another page.

6. **Membership lifecycle events use dual-channel delivery** — `room_member_joined`, `room_member_left`, `room_member_kicked`, `room_deleted` fire on BOTH the room broadcast (for members viewing the room) AND the user channel (for the affected user). This ensures the member list updates for viewers while the affected user gets immediate UI reactions (toast, redirect, list removal) regardless of which page they're on.

7. **Kicked/blocked users are force-unsubscribed** — When `/internal/membership-updated` fires with `isBlocked: true` or `status: LEFT`, the server calls `subscriptionManager.unsubscribeRoom()` for all sockets belonging to that user, preventing further event delivery to unauthorized sockets.

8. **Multi-tab: defer leader election** — IN_FLIGHT status guard in IndexedDB is first line of defense. Leader election via BroadcastChannel added later if contention proves real.

9. **Presence becomes two-dimensional** — global online (socket connected) vs. viewing (room page mounted). Heartbeat reflects both.

10. **Membership cache with 60s TTL** — avoids MongoDB hit per event. Invalidated on `/internal/membership-updated`.

11. **Reconnect is lightweight** — queries subscriptions from DB (authoritative), no message downloads. `sync_metadata` returns only IDs/timestamps.
