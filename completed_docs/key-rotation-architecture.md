# Room Key Rotation — Architecture & Implementation Plan

> **Status**: Draft for review  
> **Project**: DeChat — Privacy-First E2EE Messaging  
> **Date**: 2026-06-18  
> **Context**: When a user leaves or is kicked from a room, the shared AES-256-GCM room key must be rotated so the depared user cannot decrypt future messages. Old messages remain decryptable by all historical members. This doc covers the full client-side rotation protocol, server-side lock coordination, schema design, and offline handling.

---

## Table of Contents

- [1. Current State Analysis](#1-current-state-analysis)
- [2. Architecture Decisions](#2-architecture-decisions)
- [3. Schema Design](#3-schema-design)
- [4. Key Rotation Protocol](#4-key-rotation-protocol)
- [5. Server-Side Lock Mechanism](#5-server-side-lock-mechanism)
- [6. Offline / Disconnection Handling](#6-offline--disconnection-handling)
- [7. Client-Side Storage (IndexedDB)](#7-client-side-storage-indexeddb)
- [8. Message Encryption with Versioning](#8-message-encryption-with-versioning)
- [9. New & Modified API Endpoints](#9-new--modified-api-endpoints)
- [10. WebSocket Events](#10-websocket-events)
- [11. User Flow Walkthroughs](#11-user-flow-walkthroughs)
- [12. Migration Strategy](#12-migration-strategy)
- [13. Edge Cases & Error Handling](#13-edge-cases--error-handling)
- [14. File Change Summary](#14-file-change-summary)

---

## 1. Current State Analysis

### What exists today

| Area | Implementation | Gaps |
|------|---------------|------|
| **Room key** | Single AES-256-GCM key per room, generated on room creation | Never rotated; one key for the entire room lifetime |
| **Key distribution** | `room_memberships.encryptedRoomKey` — RSA-wrapped AES key per member | Only stores the current key; no version history |
| **Message schema** | `{ ciphertext, iv, authTag, messageType }` | No key version field; all messages assumed to use the same key |
| **IndexedDB** | `room-keys` store: `roomId → CryptoKey` | Only one key per room; no version tracking |
| **Kickout** | `kickoutCount` incremented, membership deleted | No key rotation triggered; depared user retains key |
| **Leave** | `status: "LEFT"` set on membership | No key rotation triggered; depared user retains key |
| **Admin approval** | `session.withTransaction()` for atomic approval + key wrapping | No rotation coordination |

### Security gap

A kicked or departed user retains their copy of the room AES key in their IndexedDB. They can continue decrypting all future messages indefinitely. The current architecture has no mechanism to invalidate this access.

---

## 2. Architecture Decisions

### Decision 1: Server-side lock for rotation coordination

**Chosen**: Server-side atomic CAS (Compare-And-Swap) lock on `room_key_versions`.

**Why**: Fully decentralized leader election via WebSocket is complex and fragile. A server-side lock with expiry provides a single coordination point that all clients agree on. The actual key generation remains client-side (server never sees plaintext keys), but the right to generate is arbitrated server-side.

**Mechanism**:
```
1. Client calls POST /rooms/:roomId/key-rotation/claim
2. Server runs: findOneAndUpdate(
     { roomId, $or: [{ lockOwner: null }, { lockExpiry: { $lt: now } }] },
     { lockOwner: userId, lockExpiry: now + 30s }
   )
3. If modifiedCount === 1 → client holds the lock
4. If modifiedCount === 0 → another client holds it; retry or wait
```

### Decision 2: Key version stored directly on messages

**Chosen**: Add `roomKeyVersion: number` field to `room_messages` schema.

**Why**: Simple, no joins needed for decryption. A separate mapping collection would add a lookup per decrypt batch. Embedded-in-ciphertext would require parsing before decrypt.

### Decision 3: Store all key versions in IndexedDB

**Chosen**: All historical room key versions fetched and cached in IndexedDB on room entry.

**Why**: With moderate rotation frequency (10-100 per room lifetime), storage is bounded and manageable. KDF chain derivation adds complexity and latency. Deterministic lookups are simpler.

### Decision 4: Queued rotation for offline scenarios

**Chosen**: Leave/kick is recorded server-side immediately. Key rotation is deferred and queued. The next online client to interact with the room triggers the rotation.

**Why**: The server cannot generate AES keys (no private key material). The first online client picks up the pending rotation and executes the protocol.

### Decision 5: Client-side message queuing during key rotation

**Chosen**: Outgoing messages are stored in an in-memory queue on the client during active key rotations and rendered optimistically, rather than blocking the user or rejecting sends.

**Why**: Routine key rotations (e.g. after a user leaves/is kicked) should be transparent to the user. Blocking message inputs or displaying technical cryptographic errors degrades user experience. Queuing messages in memory under a standard "Sending..." status masks rotation latency. Once rotation succeeds, messages are automatically encrypted and sent using the new key version.

---

## 3. Schema Design

### 3.1 New: `room_key_versions` collection

Tracks each version of the room key and the rotation lock state.

```typescript
// packages/frontend/src/lib/schemas/room-key-version.ts

interface RoomKeyVersion {
  _id: ObjectId;
  roomId: ObjectId;
  version: number;                        // 0-based, starts at 0 on room creation
  
  // Generation metadata
  createdBy: ObjectId;                    // userId who generated this key
  createdAt: Date;
  reason: "CREATED" | "MEMBER_LEFT" | "MEMBER_KICKED";
  triggerUserId?: ObjectId;               // user who left/was kicked (null for CREATED)
  
  // Rotation lock (for the NEXT version's generation)
  lockOwner?: ObjectId;                   // userId holding the generation lock
  lockExpiry?: Date;                      // TTL for the lock (30 seconds)
  
  // Status tracking
  status: "ACTIVE" | "GENERATING" | "DISTRIBUTING" | "COMPLETE" | "FAILED";
  // ACTIVE        = this is the current live key
  // GENERATING    = next version is being generated (lock held)
  // DISTRIBUTING  = key generated, being distributed to members
  // COMPLETE      = rotation fully complete, distribution done
  // FAILED        = rotation failed (lock expired, client disconnected)
}
```

**Indexes**:
- `{ roomId: 1, version: 1 }` — unique compound index
- `{ roomId: 1, status: 1 }` — find pending rotations
- `{ roomId: 1, lockOwner: 1, lockExpiry: 1 }` — lock contention checks

### 3.2 New: `room_key_distribution` collection

Maps which users have which key versions (the RSA-wrapped AES keys).

```typescript
// packages/frontend/src/lib/schemas/room-key-distribution.ts

interface RoomKeyDistribution {
  _id: ObjectId;
  roomId: ObjectId;
  keyVersion: number;                     // references room_key_versions.version
  userId: ObjectId;
  encryptedKey: string;                   // RSA-wrapped AES key for this user at this version
  distributedAt: Date;                    // when the wrapper was created
}
```

**Indexes**:
- `{ roomId: 1, keyVersion: 1, userId: 1 }` — unique compound index
- `{ roomId: 1, userId: 1 }` — fetch all versions for a user in a room

### 3.3 Modified: `room_messages` schema

Add a single field:

```typescript
// In the existing room_messages schema:
roomKeyVersion: number;                   // default: 0 for existing messages
```

### 3.4 Modified: `rooms` schema

Add a field for rotation state:

```typescript
// In the existing rooms schema:
pendingKeyRotation: boolean;              // default: false
lastKeyVersion: number;                   // tracks current active version
```

### 3.5 Modified: `room_memberships` schema

Add a field to track which key version the member last fetched:

```typescript
// In the existing room_memberships schema:
currentKeyVersion: number;               // latest key version this member has
// encryptedRoomKey remains as-is — always holds the latest wrapped key
```

### Entity Relationship

```
rooms
  ├── room_key_versions (1:N) — one doc per key version
  │     └── room_key_distribution (1:N) — wrapped keys per member per version
  ├── room_messages (1:N) — each message references roomKeyVersion
  └── room_memberships (1:N) — currentKeyVersion tracks sync state
```

---

## 4. Key Rotation Protocol

### 4.1 Room Creation (Version 0)

```
1. Creator's client:
   a. Generate AES-256-GCM key (existing flow)
   b. Wrap with creator's RSA public key
   c. POST /rooms/:roomId/key-versions/init
      → Server creates room_key_versions: { version: 0, status: "ACTIVE", reason: "CREATED" }
      → Server creates room_key_distribution: { keyVersion: 0, userId: creatorId, encryptedKey }
      → Server sets rooms.lastKeyVersion = 0, rooms.pendingKeyRotation = false
      → Server sets room_memberships.currentKeyVersion = 0, encryptedRoomKey = wrappedKey
   d. Client saves key to IndexedDB: storeRoomKey(roomId, version=0, key)
```

### 4.2 User Joins (Fetch All Versions)

1. After membership is APPROVED:
   a. GET /rooms/:roomId/key-versions
      → Returns all room_key_versions docs for the room
   b. For each version:
      GET /rooms/:roomId/key-versions/:version/my-key
      → Returns the RSA-wrapped AES key for this user at this version
   c. For each wrapped key:
      - Load private key from IndexedDB
      - RSA-OAEP unwrap → AES-256-GCM CryptoKey
      - Store in IndexedDB: storeRoomKey(roomId, version, key)
   d. POST /rooms/:roomId/membership/sync-key-version
      → Server updates currentKeyVersion on membership

**Performance note**: For rooms with many versions, batch the key fetches. The distribution docs can be fetched in a single query:
```
GET /rooms/:roomId/my-key-distribution
→ Returns all RoomKeyDistribution docs where userId = currentUser
→ Client unwraps all in sequence and caches
```

#### Joining / Page Entry During Active Key Rotation

If a client enters a room or is approved to join while `pendingKeyRotation` is `true`:
1. **Defer Initialization**:
   - The client joins the WebSocket channel for the room to receive event broadcasts, but suspends/queues the rest of the joining sequence (key distribution fetch, decrypt, room state sync, and message history loading).
   - The room UI is rendered in a loading or optimistic waiting state (no security/crypto terms).
2. **Listen for Rotation Complete**:
   - The client waits until they receive the `KEY_ROTATION_COMPLETE` WebSocket event.
3. **Execute Deferred Join Sequence**:
   - Once the event is received, the client resumes the normal join flow: fetches the new key distributions (which will now include the wrapped key for version `N` for this user), unwraps and stores it in IndexedDB, and loads the message history.

### 4.3 Trigger: User Leaves or Is Kicked

#### Server-side (immediate):

```
1. Process leave/kick (existing logic):
   a. Update membership status to "LEFT" or remove
   b. Decrement memberCount
   
2. Trigger rotation queue:
   a. Update room: { pendingKeyRotation: true }
   b. Create room_key_versions: {
        roomId,
        version: lastKeyVersion + 1,
        createdBy: null,          // not yet generated
        reason: "MEMBER_LEFT" | "MEMBER_KICKED",
        triggerUserId: deparedUserId,
        status: "GENERATING",
        lockOwner: null,
        lockExpiry: null
      }
   c. Emit WS event to room: PENDING_KEY_ROTATION { roomId, version, reason }
```

#### Client-side (Coordination & Message Queuing):

When a client receives a `PENDING_KEY_ROTATION` event via WebSocket, or detects a pending rotation on reconnect/room entry:

1. **Set Rotating State**:
   - The room's local state is transitioned to `pendingKeyRotation = true`.
   - The message input UI remains fully active, allowing the user to type and send messages.
   - Any messages sent by the user during this period must NOT be encrypted with the stale key or sent over the WebSocket. Instead, they are added to a client-side in-memory queue (`messageQueueMap.get(roomId): PendingMessage[]`) and rendered optimistically.
   - The queued messages display a standard `Sending...` status. They must not expose any cryptographic, security update, or key rotation terminology to end users. No message failures are shown for normal rotation scenarios.

2. **Claim Lock (Leader Election)**:
   - Client calls: `POST /api/rooms/:roomId/key-rotation/claim` with body `{ version: N }`.
   - The server performs an atomic CAS check.

3. **Branch Flow based on Lock Claim**:

   - **If the client successfully claims the lock (Generator / Leader)**:
     a. **Generate new key**: Generate a cryptographically secure AES-256-GCM room key in the browser.
     b. **Wrap key**: Fetch the RSA public key of each remaining `APPROVED` room member (excluding the departed/kicked user), and wrap (encrypt) the new AES key.
     c. **Publish rotation**: POST `/api/rooms/:roomId/key-rotation/complete` with body `{ version: N, distributions: [...] }`.
     d. **Update local cache**: Save the new key in IndexedDB at version `N`.
     e. **Flush local queue**: Encrypt and send all locally queued messages using the new key version `N`, transitioning their state to sent.
     f. Server updates room status to `pendingKeyRotation = false` and broadcasts `KEY_ROTATION_COMPLETE` to all other room members.

   - **If the client fails to claim the lock (Waiting Client / Follower)**:
     a. **Do NOT generate keys**: Do not generate a new key or fetch other members' public keys.
     b. **Wait**: Enter a waiting state, continuing to buffer any new outgoing messages in the local queue (showing `Sending...`).
     c. **Listen for Complete**: Listen for the `KEY_ROTATION_COMPLETE` WebSocket event.
     d. **Fetch and unwrap**: Upon receiving `KEY_ROTATION_COMPLETE` (or after a 30s timeout/reconnect check), fetch the user's specific wrapped key:
        `GET /api/rooms/:roomId/my-key-distribution` (filtering or fetching version `N`).
     e. **Decrypt & Cache**: Decrypt the key version `N` using the client's RSA private key, and cache it in IndexedDB.
     f. **Flush local queue**: Automatically encrypt all queued messages using the newly retrieved key version `N` and send them to the server.

### 4.4 Key Version Fetch on Room Entry

```
1. Client joins room page:
   a. GET /rooms/:roomId/key-versions → list of all versions
   b. GET /rooms/:roomId/my-key-distribution → all wrapped keys for this user
   c. For each distribution entry:
      - Unwrap with RSA private key
      - Store in IndexedDB: storeRoomKey(roomId, version, aesKey)
   d. Save latest version number for use when sending messages
```

---

## 5. Server-Side Lock Mechanism

### Lock Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    ROTATION LOCK STATE MACHINE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [No Lock] ──claim()──→ [Lock Held] ──complete()──→ [No Lock]  │
│      ↑                      │                                    │
│      │                 lockExpiry                               │
│      │                      │                                    │
│      └───── timeout ────────┘                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Lock Claim (Atomic CAS)

```typescript
// packages/frontend/src/app/api/rooms/[roomId]/key-rotation/claim/route.ts

async function claimRotationLock(roomId: string, userId: string, version: number) {
  const now = new Date();
  const LOCK_TTL_MS = 30_000; // 30 seconds
  
  const result = await db.collection("room_key_versions").findOneAndUpdate(
    {
      roomId: new ObjectId(roomId),
      version,
      status: "GENERATING",
      $or: [
        { lockOwner: null },
        { lockExpiry: { $lt: now } }  // lock expired
      ]
    },
    {
      $set: {
        lockOwner: new ObjectId(userId),
        lockExpiry: new Date(now.getTime() + LOCK_TTL_MS)
      }
    }
  );
  
  return result.modifiedCount === 1; // true = lock acquired
}
```

### Lock Release

```typescript
async function releaseRotationLock(roomId: string, userId: string, version: number) {
  await db.collection("room_key_versions").findOneAndUpdate(
    {
      roomId: new ObjectId(roomId),
      version,
      lockOwner: new ObjectId(userId)  // only release own lock
    },
    {
      $set: { lockOwner: null, lockExpiry: null }
    }
  );
}
```

### Lock Expiry

- Lock TTL: 30 seconds
- If the generator disconnects mid-rotation, the lock expires
- Next client to attempt claim will find `lockExpiry < now` and acquire it
- The `status` remains "GENERATING" — the new claimant continues the work

---

## 6. Offline / Disconnection Handling

### Scenario A: Generator disconnects mid-rotation

```
1. Generator claims lock, starts generating keys
2. Generator's browser crashes / network drops
3. After 30s, lock expires
4. Another online client (or the same client on reconnect) detects:
   - room_key_versions where status = "GENERATING" and (lockOwner = null or lockExpiry < now)
5. That client claims the lock and restarts generation from scratch
6. The partially-written room_key_distribution docs from the failed attempt
   are orphaned but harmless — the new generator overwrites with fresh docs
```

### Scenario B: All clients offline when rotation is triggered

```
1. User leaves → server sets pendingKeyRotation = true, creates version record
2. No clients are online to claim the lock
3. Room enters a "pending rotation" state
4. Outgoing messages sent by a client while offline/during pending rotation are placed into the client-side in-memory queue.
   - Client-side: before encrypting/sending, check if pendingKeyRotation is true.
   - If true, hold the message in the local queue and render optimistically as "Sending..."
5. First client to connect/reconnect:
   a. Detects pendingKeyRotation on the room
   b. Claims lock
   c. Generates and distributes new key
   d. Broadcasts KEY_ROTATION_COMPLETE
6. All clients that reconnect afterward fetch the new key via normal flow, decrypt/cache it, and automatically encrypt and send their queued messages.
```

### Scenario C: Client goes offline after rotation but before receiving new key

```
1. Rotation completes, KEY_ROTATION_COMPLETE broadcast sent
2. Client was briefly offline during broadcast
3. On reconnect: client triggers runSync()
4. Sync detects room_key_versions has a higher version than client's currentKeyVersion
5. Client fetches the new key distribution and caches it
```

### Scenario D: Multiple simultaneous leaves/kicks

```
1. User A leaves, User B is kicked at nearly the same time
2. Server processes each sequentially:
   a. A leaves → pendingKeyRotation = true, version N created (GENERATING)
   b. B kicked → pendingKeyRotation already true, version N+1 queued
3. First rotation (version N) completes → version N+1 starts
4. Each rotation is serial — version N must complete before N+1 begins
5. Server enforces: only one "GENERATING" status record per room at a time

### Scenario E: Client loses connection or reloads page during active rotation

```
1. Client has messages buffered in the local in-memory queue with "Sending..." status.
2. Connection Drop / Reconnect:
   - If the WebSocket disconnects but the page is NOT reloaded:
     - The local queue is retained.
     - On reconnect, the client syncs the room status.
     - If the rotation completed while offline, the client fetches the new key and flushes the queue.
     - If the rotation is still pending and the lock has expired (duration > 30s), the client attempts to claim the lock to resume/complete rotation.
3. Page Reload / Tab Closed:
   - Since the queue is strictly in-memory, pending messages will be lost on page reload.
   - Prevention: A 'beforeunload' event listener is active when the in-memory queue is not empty. The browser displays a generic warning: "You have unsent messages. If you leave now, they will be lost."
```
```

---

## 7. Client-Side Storage (IndexedDB)

### New Object Store: `room-key-versions`

Added to the existing `dechat-crypto-store` database.

```
Database: dechat-crypto-store (version bump to 3)
Store: room-key-versions
Key path: composite key `${roomId}:${version}`
Value: { roomId: string, version: number, key: CryptoKey }
```

### Updated `onupgradeneeded`

```typescript
// packages/frontend/src/lib/crypto.ts — getDB()

case 3: // version upgrade
  if (!db.objectStoreNames.contains("room-key-versions")) {
    db.createObjectStore("room-key-versions");
  }
```

### API Functions

```typescript
// Store a specific key version
async function storeRoomKeyVersion(
  roomId: string, 
  version: number, 
  key: CryptoKey
): Promise<void>

// Get a specific key version
async function getRoomKeyVersion(
  roomId: string, 
  version: number
): Promise<CryptoKey | null>

// Get all cached key versions for a room (returns Map<version, CryptoKey>)
async function getAllRoomKeyVersions(
  roomId: string
): Promise<Map<number, CryptoKey>>

// Get the latest cached version number for a room
async function getLatestRoomKeyVersion(
  roomId: string
): Promise<number | null>

// Delete all key versions for a room (cleanup)
async function deleteAllRoomKeyVersions(
  roomId: string
): Promise<void>
```

### Fetch & Cache Flow (on room entry)

```typescript
async function fetchAndCacheRoomKeys(roomId: string): Promise<Map<number, CryptoKey>> {
  // 1. Fetch all distribution entries for this user in this room
  const distributions = await fetchMyKeyDistributions(roomId);
  
  // 2. Load RSA private key
  const privateKey = await getPrivateKey(currentUserId);
  
  // 3. For each distribution, unwrap and cache
  const keys = new Map<number, CryptoKey>();
  for (const dist of distributions) {
    const wrappedBytes = base64ToBuffer(dist.encryptedKey);
    const aesKey = await crypto.subtle.unwrapKey(
      "raw", wrappedBytes, privateKey, 
      { name: "RSA-OAEP" }, 
      { name: "AES-GCM", length: 256 }
    );
    await storeRoomKeyVersion(roomId, dist.keyVersion, aesKey);
    keys.set(dist.keyVersion, aesKey);
  }
  
  return keys;
}
```

---

## 8. Message Encryption with Versioning

### Sending (Client)

The client maintains an in-memory queue for messages generated during key rotations. Outgoing messages check the room status before encrypting:

```typescript
interface PendingMessage {
  roomId: string;
  plaintext: string;
  clientMessageId: string; // for optimistic updates and server matching
  createdAt: Date;
}

// In-memory queue map
const messageQueueMap = new Map<string, PendingMessage[]>();

// Entrypoint for sending a message
async function handleOutgoingMessage(
  roomId: string,
  plaintext: string,
  clientMessageId: string
) {
  const room = await getRoomDetails(roomId); // Get room state from application context
  
  if (room.pendingKeyRotation) {
    // 1. Render message optimistically in the UI with a "Sending..." status.
    //    Do NOT show any security or crypto-related terms.
    renderOptimisticMessage({
      id: clientMessageId,
      roomId,
      plaintext,
      status: "sending",
      createdAt: new Date()
    });

    // 2. Add message to the in-memory queue
    if (!messageQueueMap.has(roomId)) {
      messageQueueMap.set(roomId, []);
    }
    messageQueueMap.get(roomId)!.push({
      roomId,
      plaintext,
      clientMessageId,
      createdAt: new Date()
    });
    return;
  }

  // Normal flow if no rotation is pending
  await sendEncryptedMessage(roomId, plaintext, room.lastKeyVersion, clientMessageId);
}

// Encrypt and emit message via WebSocket
async function sendEncryptedMessage(
  roomId: string,
  plaintext: string,
  currentKeyVersion: number,
  clientMessageId: string
) {
  const roomKey = await getRoomKeyVersion(roomId, currentKeyVersion);
  const { ciphertext, iv, authTag } = await encryptMessage(plaintext, roomKey);
  
  socket.emit("send_message", {
    roomId,
    ciphertext,
    iv,
    authTag,
    roomKeyVersion: currentKeyVersion,
    clientMessageId,
    messageType: "text"
  });
}

// Automatically called when KEY_ROTATION_COMPLETE is received and the new key is cached
async function flushMessageQueue(roomId: string, newKeyVersion: number) {
  const queue = messageQueueMap.get(roomId) || [];
  if (queue.length === 0) return;

  const now = new Date();
  const MAX_QUEUE_AGE_MS = 5 * 60 * 1000; // 5 minutes

  // Iterate strictly in order using a standard for loop from start to end
  for (let i = 0; i < queue.length; i++) {
    const pending = queue[i];
    const ageMs = now.getTime() - pending.createdAt.getTime();

    if (ageMs > MAX_QUEUE_AGE_MS) {
      // Avoid zombie messages: stale message (> 5 mins) is not processed or sent
      console.warn(`Message ${pending.clientMessageId} is stale and will be discarded.`);
      // Update UI to show a red simple cross icon indicating failure
      updateMessageStatus(pending.clientMessageId, "failed_red_cross");
      continue;
    }

    try {
      await sendEncryptedMessage(roomId, pending.plaintext, newKeyVersion, pending.clientMessageId);
    } catch (err) {
      console.error("Failed to send queued message:", err);
      // Fallback: If it fails due to network issues, transition the individual message to
      // a failed state and display a red simple cross icon just beside it.
      updateMessageStatus(pending.clientMessageId, "failed_red_cross");
    }
  }

  // Clear queue
  messageQueueMap.set(roomId, []);
}
```

### Receiving (Client)

```typescript
// Modified decrypt flow in message handler
async function handleIncomingMessage(msg: EncryptedMessage) {
  const roomKey = await getRoomKeyVersion(msg.roomId, msg.roomKeyVersion);
  if (!roomKey) {
    console.warn(`Missing key version ${msg.roomKeyVersion} for room ${msg.roomId}`);
    // Show placeholder: "Key unavailable for this message"
    return null;
  }
  const plaintext = await decryptMessage(msg.ciphertext, msg.iv, msg.authTag, roomKey);
  return plaintext;
}
```

### History Fetch

```typescript
// When loading message history, batch decrypt with correct versions
async function decryptBatch(messages: EncryptedMessage[], roomId: string) {
  // Pre-fetch all needed key versions
  const keyCache = new Map<number, CryptoKey>();
  
  const results = await Promise.all(messages.map(async (msg) => {
    if (!keyCache.has(msg.roomKeyVersion)) {
      const key = await getRoomKeyVersion(roomId, msg.roomKeyVersion);
      if (key) keyCache.set(msg.roomKeyVersion, key);
    }
    const key = keyCache.get(msg.roomKeyVersion);
    if (!key) return { ...msg, plaintext: "[Unable to decrypt - missing key version]" };
    
    const plaintext = await decryptMessage(msg.ciphertext, msg.iv, msg.authTag, key);
    return { ...msg, plaintext };
  }));
  
  return results;
}
```

### Reply Previews and Key Versioning

> See `docs/reply-edit-delete-architecture.md` — Sections 7, 6.7, and 13 for full detail.

When a user sends a **reply**, two distinct key versions are involved:

| What | Key version | Stored where |
|------|-------------|--------------|
| Decrypting the quoted message body (local preview above input) | $V_{quoted}$ — the `roomKeyVersion` of the quoted message | Looked up from IndexedDB at compose time |
| Encrypting the reply preview snippet (`replyTo.previewCiphertext`) | $V_{reply}$ — the current active room key version, same as the reply body | Embedded in the `replyTo` subdocument on `room_messages` |
| Encrypting the reply body | $V_{reply}$ | `room_messages.ciphertext` |

**Key invariant**: The encrypted preview in `replyTo` is always encrypted with the same key version as the reply message body itself ($V_{reply}$). Receivers use a single key lookup — `getRoomKeyVersion(roomId, msg.roomKeyVersion)` — to decrypt both the body and the preview strip. No additional key fetch is needed for reply rendering.

**Fallback**: If `getRoomKeyVersion` returns `null` for $V_{reply}$ (e.g. client is in the middle of a rotation and hasn't cached the new key yet), `decryptReplyPreview` returns `"message unavailable"` rather than throwing.

**Late-joining members**: A member who joins after several key rotations will receive all key versions via `GET /api/rooms/:roomId/my-key-distribution` on room entry. Since the preview is encrypted with $V_{reply}$ (not the older $V_{quoted}$), they can decrypt the preview strip using the same key they use for the reply body — no dependency on older key versions they may not possess.

### Edits and Key Versioning

> See `docs/reply-edit-delete-architecture.md` — Sections 4.2, 6.6, 12.2, and 13 for full detail.

When a user **edits** a message, the key version is handled as follows:

| Rule | Detail |
|------|--------|
| **Encryption key** | The client encrypts the edited body using the **original key version** ($V_{orig}$) — the `roomKeyVersion` stored on the message being edited, looked up from IndexedDB. |
| **Server behavior** | The server updates only `ciphertext`, `iv`, `authTag`, and `editedAt`. The `roomKeyVersion` field is **never modified** on edit. |
| **`edit_message` socket event** | Does **not** enforce `roomKeyVersion === room.lastKeyVersion`. Edits intentionally use $V_{orig}$, not the current active version. |
| **Broadcast** | The `message_edited` event retains the original `roomKeyVersion: V_orig` so all receivers can look up the correct key for decryption. |

**Rationale**: Historical members who were in the room when the message was sent possess $V_{orig}$. If the edit were re-encrypted with the current active key $V_{new}$, those historical members could no longer decrypt the edited message. Using $V_{orig}$ ensures backward-compatible decryptability.

**Client-side guard**: Before emitting `edit_message`, the client verifies that `getRoomKeyVersion(roomId, V_orig)` returns a non-null key. If the key is missing, the edit is aborted rather than encrypting with the wrong key or the current active key.

---

## 9. New & Modified API Endpoints

### New Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `POST` | `/api/rooms/:roomId/key-versions/init` | Create version 0 on room creation | Room creator |
| `GET` | `/api/rooms/:roomId/key-versions` | List all key versions for a room | Approved member |
| `GET` | `/api/rooms/:roomId/my-key-distribution` | Get all wrapped keys for current user across versions | Approved member |
| `POST` | `/api/rooms/:roomId/key-rotation/claim` | Claim the generation lock for next version | Approved member |
| `POST` | `/api/rooms/:roomId/key-rotation/complete` | Publish generated key + distribution, release lock | Lock holder |
| `POST` | `/api/rooms/:roomId/key-rotation/release` | Release lock without completing (give up) | Lock holder |
| `POST` | `/api/rooms/:roomId/membership/sync-key-version` | Update currentKeyVersion on membership | Approved member |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /api/rooms/:roomId/join-requests/[userId]/route.ts` | After approval, also create room_key_distribution doc for the new member's latest version |
| `PATCH /api/rooms/:roomId/membership` | Store `currentKeyVersion` alongside `encryptedRoomKey` |
| `GET /api/rooms/:roomId/messages` | Return `roomKeyVersion` field on each message |
| `POST /api/rooms/:roomId/leave` | Set `pendingKeyRotation = true`, create pending version record |
| `POST /api/rooms/:roomId/kickout/[userId]` | Set `pendingKeyRotation = true`, create pending version record |
| `GET /api/rooms/:roomId` | Include `pendingKeyRotation` and `lastKeyVersion` in response |

### Key Init Endpoint (Room Creation)

```typescript
// POST /api/rooms/:roomId/key-versions/init
// Body: { encryptedKey: string }  // RSA-wrapped AES key for creator

async function initRoomKeyVersion(roomId: string, creatorId: string, encryptedKey: string) {
  return await session.withTransaction(async (session) => {
    // 1. Create version 0
    await db.collection("room_key_versions").insertOne({
      roomId: new ObjectId(roomId),
      version: 0,
      createdBy: new ObjectId(creatorId),
      createdAt: new Date(),
      reason: "CREATED",
      status: "ACTIVE"
    }, { session });
    
    // 2. Create distribution entry for creator
    await db.collection("room_key_distribution").insertOne({
      roomId: new ObjectId(roomId),
      keyVersion: 0,
      userId: new ObjectId(creatorId),
      encryptedKey,
      distributedAt: new Date()
    }, { session });
    
    // 3. Update room
    await db.collection("rooms").updateOne(
      { _id: new ObjectId(roomId) },
      { $set: { lastKeyVersion: 0, pendingKeyRotation: false } },
      { session }
    );
    
    // 4. Update creator's membership
    await db.collection("room_memberships").updateOne(
      { roomId: new ObjectId(roomId), userId: new ObjectId(creatorId) },
      { $set: { currentKeyVersion: 0, encryptedRoomKey: encryptedKey } },
      { session }
    );
  });
}
```

---

## 10. WebSocket Events

### New Events

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `PENDING_KEY_ROTATION` | Server → Client | `{ roomId, version, reason, triggerUserId }` | Notify room that rotation is needed |
| `KEY_ROTATION_COMPLETE` | Server → Client | `{ roomId, version }` | Notify room that new key is ready |
| `KEY_ROTATION_FAILED` | Server → Client | `{ roomId, version, error }` | Notify room that rotation failed |

### Modified Events

| Event | Change |
|-------|--------|
| `send_message` | Client includes `roomKeyVersion: number` in payload |
| `room_message` | Server stores and broadcasts `roomKeyVersion` field |

### Message Validation Update

```typescript
// WS server: send_message handler
// Add roomKeyVersion validation:
if (typeof data.roomKeyVersion !== "number" || data.roomKeyVersion < 0) {
  return ack({ ok: false, error: "INVALID_KEY_VERSION" });
}
// Verify the version matches the room's current version:
if (data.roomKeyVersion !== room.lastKeyVersion) {
  return ack({ ok: false, error: "STALE_KEY_VERSION", currentVersion: room.lastKeyVersion });
}
```

> **`edit_message` exemption**: The `lastKeyVersion` check above applies **only** to `send_message`. The `edit_message` handler does **not** enforce this check. Edits are intentionally encrypted with the original key version ($V_{orig}$) of the message being edited, not the current active room key. The server only validates ownership and the 15-minute edit window. See `docs/reply-edit-delete-architecture.md` Section 4.2 for full detail.

#### Client-Side STALE_KEY_VERSION Handling

If the client sends a message right as a rotation occurs but before receiving the WebSocket notification, the server rejects it. The client handles this gracefully:

```typescript
socket.emit("send_message", payload, (ack) => {
  if (ack && !ack.ok && ack.error === "STALE_KEY_VERSION") {
    // 1. Transition local room state to pendingKeyRotation = true
    room.pendingKeyRotation = true;
    
    // 2. Queue the message in memory to prevent failure state
    queueFailedMessageForRotation(payload.roomId, payload.clientMessageId, decryptedPlaintext);
    
    // 3. Trigger key versions sync to fetch the new key version (or claim lock)
    syncRoomKeys(payload.roomId);
  }
});
```
```

---

## 11. User Flow Walkthroughs

### Flow 1: User Creates Room

```
Client                          Server                          DB
  │                               │                              │
  ├─ createRoom() ────────────────→│                              │
  │                               ├─ insert rooms doc ───────────→│
  │                               ├─ insert room_memberships ────→│
  │                               ←── { roomId, roomLink } ──────┤
  │                                                              │
  ├─ generateAESKey()             │                              │
  ├─ wrapKeyWithRSA(creatorPub)   │                              │
  ├─ POST /key-versions/init ─────→│                              │
  │  { encryptedKey }             ├─ insert room_key_versions ───→│
  │                               ├─ insert room_key_distribution →│
  │                               ├─ update rooms ───────────────→│
  │                               ├─ update memberships ─────────→│
  │                               ←── { ok: true } ──────────────┤
  │                                                              │
  ├─ storeRoomKeyVersion(roomId, 0, key) → IndexedDB             │
  └─ ready to send messages                                     │
```

### Flow 2: User Joins Existing Room

```
Client A (existing)               Server                          Client B (new)
  │                               │                              │
  │                               ←── approve request ───────────┤
  │                               ├─ insert membership ──────────→│
  │                               │                              │
  │                               │         Client B joins page  │
  │                               │              │               │
  │                               │   GET /key-versions ─────────┤
  │                               │   ←── [v0, v1, v2] ─────────┤
  │                               │                              │
  │                               │   GET /my-key-distribution ──┤
  │                               │   ←── [wrapped_v0,          │
  │                               │         wrapped_v1,          │
  │                               │         wrapped_v2] ─────────┤
  │                               │                              │
  │                               │   unwrap all with privkey    │
  │                               │   cache in IndexedDB         │
  │                               │                              │
  │                               │   ready to decrypt all msgs  │
```

### Flow 3: User Is Kicked → Key Rotation (with Queuing)

```
Admin                             Server                         Member X (Leader/Gen)          Member Y (Follower/Waiting)
  │                                 │                                      │                                 │
  ├─ POST /kickout/[userId] ───────→│                                      │                                 │
  │                                 ├─ room.pendingKeyRotation = true      │                                 │
  │                                 ├─ insert room_key_versions (N)        │                                 │
  │                                 ├─ emit PENDING_KEY_ROTATION ──────────┼─────── (broadcast) ────────────→│
  │                                 │                                      │                                 │
  │                                 │                                      │                [Types message]  │
  │                                 │                                      │                - Queue locally  │
  │                                 │                                      │                - Show "Sending..."
  │                                 │                                      │                                 │
  │                                 │←── POST /key-rotation/claim ─────────┤                                 │
  │                                 │    (lockAcquired: true)              │                                 │
  │                                 │                                      │                                 │
  │                                 │←────────────────────── POST /key-rotation/claim ───────────────────────┤
  │                                 │                         (lockAcquired: false — lock already held)      │
  │                                 │                                      │                                 │
  │                                 │                                      │                - Continues queueing
  │                                 │                                      │                                 │
  │                                 │                                      ├─ generateAESKey()               │
  │                                 │                                      ├─ wrap keys with RSA             │
  │                                 │←── POST /key-rotation/complete ──────┤                                 │
  │                                 ├─ status = COMPLETE                   │                                 │
  │                                 ├─ update room & memberships           │                                 │
  │                                 ├─ emit KEY_ROTATION_COMPLETE ─────────┼─────── (broadcast) ────────────→│
  │                                 │                                      │                                 │
  │                                 │                                      │                - GET /my-key-distribution
  │                                 │←── GET /my-key-distribution ─────────┼─────────────────────────────────┤
  │                                 │    ←── [wrapped_vN] ─────────────────┼─────────────────────────────────┤
  │                                 │                                      │                                 │
  │                                 │                                      │                - Decrypt & Cache
  │                                 │                                      │                - Encrypt queue  │
  │                                 │←── send_message (version N) ─────────┼─────────────────────────────────┤
  │                                 ├─ broadcast room_message ─────────────┼────────────────────────────────→│
  │                                 │                                      │                - Msg state: Sent│
  │                                 │                                      │                                 │
  │                                 │                                      │         Departed User           │
  │                                 │                                      │   retains v0..v(N-1) keys       │
  │                                 │                                      │   CAN decrypt old messages      │
  │                                 │                                      │   CANNOT decrypt vN+ messages   │
  │                                 │                                      │   NOT in distribution for vN    │
```

### Flow 4: Offline User Returns → Catches Up on Rotation

```
Client (was offline)              Server
  │                                │
  ├─ connect + join_room ─────────→│
  │                                │
  ├─ GET /rooms/:roomId ──────────→│
  │  ←── { pendingKeyRotation:     │
  │         false,                 │
  │         lastKeyVersion: 3 }    │
  │                                │
  ├─ check IndexedDB:              │
  │  latest cached version = 1     │
  │  (missed rotation 2 and 3)     │
  │                                │
  ├─ GET /my-key-distribution ────→│
  │  ←── [wrapped_v2, wrapped_v3] │
  │                                │
  ├─ unwrap v2, v3 with privkey    │
  ├─ cache in IndexedDB            │
  ├─ can now decrypt all messages  │
```

---

## 12. Migration Strategy

### Phase 1: Schema Changes (Non-Breaking)

1. Add `roomKeyVersion` field to `room_messages` with default `0` — all existing messages get version 0
2. Add `pendingKeyRotation` (boolean, default `false`) and `lastKeyVersion` (number, default `0`) to `rooms`
3. Add `currentKeyVersion` (number, default `0`) to `room_memberships`
4. Create `room_key_versions` collection with unique compound index on `(roomId, version)`
5. Create `room_key_distribution` collection with unique compound index on `(roomId, keyVersion, userId)`

### Phase 2: Backfill Existing Rooms

For each existing room:
1. Create a `room_key_versions` doc: `{ roomId, version: 0, reason: "CREATED", status: "ACTIVE", createdBy: room.creatorId, createdAt: room.createdAt }`
2. For each APPROVED member: create a `room_key_distribution` doc using the existing `room_memberships.encryptedRoomKey` value
3. Set `rooms.lastKeyVersion = 0`

**Migration script**: `packages/frontend/src/scripts/backfill-key-versions.ts`

### Phase 3: Client-Side Upgrade

1. Bump IndexedDB version to 3
2. Add `room-key-versions` object store in `onupgradeneeded`
3. On first room load after upgrade, fetch and cache key versions from server
4. Backfill existing `room-keys` entries into `room-key-versions` store at version 0

---

## 13. Edge Cases & Error Handling

| Edge Case | Handling |
|-----------|----------|
| **Departed user tries to send message** | Server rejects: membership status is LEFT/removed. No key rotation needed for rejection. |
| **Departed user receives message via stale WS** | Server checks membership before broadcast. LEFT/removed users are not in the Socket.IO room. |
| **Two clients claim lock simultaneously** | Atomic CAS ensures only one wins. The loser gets `lockAcquired: false` and enters waiting state, buffering outgoing messages in-memory. |
| **Generator creates distribution but crashes before completing** | Lock expires (30s). Next waiting client detects expired lock, claims it, generates/publishes new key, and triggers queue flush for all users. |
| **Member not in distribution for a version** | They joined after that version. They only need versions from their join date onward. Server filters distribution queries by join date when possible. |
| **Room with zero members after all leave** | Room becomes inactive. No rotation needed. `pendingKeyRotation` can be ignored. |
| **Rapid successive kicks** | Each kick queues a rotation. Serial processing: version N must complete before N+1 starts. Server checks for in-progress rotation before creating a new one. |
| **Client sends message with wrong version (stale key)** | Server rejects with `STALE_KEY_VERSION` and includes `currentVersion`. Client transitions to rotating state, buffers the message in-memory, syncs room keys, and flushes once key is cached. |
| **IndexedDB full or unavailable** | Key fetch falls back to server on every encrypt/decrypt. Degraded performance but functional. |
| **Clock skew on lock expiry** | Lock TTL is generous (30s). Clock skew of a few seconds is within tolerance. |
| **User closes tab/reloads page with queued messages** | Since queue is in-memory, messages are lost. `beforeunload` event handler prompts generic warning to the user: "You have unsent messages. If you leave now, they will be lost." |
| **Queue flushing fails (network error after rotation)** | Messages transition to standard failed state and display a red simple cross icon beside them. No crypto jargon is shown. |
| **Member joins or loads room page during active key rotation** | The client queues/defers room setup, key fetch, and history loading until `KEY_ROTATION_COMPLETE` is received, preventing decryption errors and missing key states. |
| **Zombie messages in local queue (> 5 mins)** | Messages queued for more than 5 minutes are considered stale. During flush, the client skips sending them and renders a simple red cross icon next to the message indicating it failed to send. |

---

## 14. File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/frontend/src/lib/schemas/room-key-version.ts` | TypeScript types for `room_key_versions` |
| `packages/frontend/src/lib/schemas/room-key-distribution.ts` | TypeScript types for `room_key_distribution` |
| `packages/frontend/src/app/api/rooms/[roomId]/key-versions/route.ts` | GET: list all key versions |
| `packages/frontend/src/app/api/rooms/[roomId]/key-versions/init/route.ts` | POST: create version 0 |
| `packages/frontend/src/app/api/rooms/[roomId]/my-key-distribution/route.ts` | GET: user's wrapped keys |
| `packages/frontend/src/app/api/rooms/[roomId]/key-rotation/claim/route.ts` | POST: claim rotation lock |
| `packages/frontend/src/app/api/rooms/[roomId]/key-rotation/complete/route.ts` | POST: complete rotation |
| `packages/frontend/src/app/api/rooms/[roomId]/key-rotation/release/route.ts` | POST: release lock |
| `packages/frontend/src/app/api/rooms/[roomId]/membership/sync-key-version/route.ts` | POST: sync key version |
| `packages/frontend/src/lib/key-rotation.ts` | Client-side rotation logic (generate, distribute, claim) |
| `packages/frontend/src/scripts/backfill-key-versions.ts` | Migration script for existing rooms |
| `docs/key-rotation-architecture.md` | This document |

### Modified Files

| File | Change |
|------|--------|
| `packages/frontend/src/lib/crypto.ts` | Add `room-key-versions` IndexedDB store, add version-aware encrypt/decrypt functions, bump DB version to 3 |
| `packages/frontend/src/lib/membership-db.ts` | Add `currentKeyVersion` to membership handling, add fetch-and-cache key flow |
| `packages/frontend/src/lib/schemas/room.ts` | Add `pendingKeyRotation`, `lastKeyVersion` fields |
| `packages/frontend/src/lib/schemas/room-membership.ts` | Add `currentKeyVersion` field |
| `packages/frontend/src/lib/schemas/message.ts` | Add `roomKeyVersion` field |
| `packages/frontend/src/app/api/rooms/route.ts` | On room creation: call key init endpoint |
| `packages/frontend/src/app/api/rooms/[roomId]/join-requests/[userId]/route.ts` | After approval: create distribution entry for new member |
| `packages/frontend/src/app/api/rooms/[roomId]/leave/route.ts` | Set `pendingKeyRotation`, create pending version record |
| `packages/frontend/src/app/api/rooms/[roomId]/kickout/[userId]/route.ts` | Set `pendingKeyRotation`, create pending version record |
| `packages/frontend/src/app/api/rooms/[roomId]/messages/route.ts` | Return `roomKeyVersion` in message responses |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Fetch key versions on room entry, detect pending rotation, coordinate claim lock vs waiting queue, manage in-memory message queue, listen for `beforeunload` warning when queue is non-empty, use versioned decrypt |
| `packages/frontend/src/lib/socket-client.ts` | Handle `PENDING_KEY_ROTATION` and `KEY_ROTATION_COMPLETE` events, trigger automatic queue flush |
| `packages/websocket-server/src/index.ts` | Handle `send_message` with `roomKeyVersion`, emit rotation events, validate version on send, return error code `STALE_KEY_VERSION` for out-of-sync sends |
| `packages/frontend/src/components/room-chat.tsx` | Display key version indicator, handle missing key version gracefully, support optimistic rendering for queued messages using standard user-facing status indicators (e.g. `Sending...`) |

### Not Modified

| File | Reason |
|------|--------|
| `packages/frontend/src/lib/crypto.ts` (core encrypt/decrypt) | The underlying AES-GCM encrypt/decrypt functions remain identical; versioning is handled at the call site |
| `packages/websocket-server/src/presence-store.ts` | Presence tracking is independent of key rotation |
| `packages/frontend/src/lib/ws-ticket.ts` | Auth ticket system is unaffected |
