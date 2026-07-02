# Reply, Edit, Delete — Architecture & Implementation

> **Status**: ✅ Implemented (2026-06-29)
> **Project**: DeChat — Privacy-First E2EE Messaging
> **Date**: 2026-06-17
> **Scope**: WhatsApp-style reply, edit, and hard-delete on text, image, video, and GIF messages inside an E2EE room.

---

## Table of Contents

1. [Core Design Decisions](#1-core-design-decisions)
2. [Schema Changes — `room_messages`](#2-schema-changes--room_messages)
3. [WebSocket Event Contract](#3-websocket-event-contract)
4. [Server-Side Workflows](#4-server-side-workflows)
5. [REST API (Patches & Backfill)](#5-rest-api-patches--backfill)
6. [Frontend Workflows](#6-frontend-workflows)
7. [E2EE & Reply Resolution](#7-e2ee--reply-resolution)
8. [UI Specification (WhatsApp-Equivalent)](#8-ui-specification-whatsapp-equivalent)
9. [Swipe-to-Reply Gesture](#9-swipe-to-reply-gesture)
10. [Long-Press Context Menu](#10-long-press-context-menu)
11. [Delete Confirmation Dialog](#11-delete-confirmation-dialog)
12. [Data Flow Round Trips (End-to-End)](#12-data-flow-round-trips-end-to-end)
13. [Edge Cases & Error Handling](#13-edge-cases--error-handling)
14. [Performance Considerations](#14-performance-considerations)
15. [File Change Summary](#15-file-change-summary)
16. [Migration & Backfill Plan](#16-migration--backfill-plan)
17. [Open Questions](#17-open-questions)
18. [Scroll-to-Quoted-Message & WhatsApp-Style Navigation](#18-scroll-to-quoted-message--whatsapp-style-navigation)

---

## 1. Core Design Decisions

### Decision 1: `replyTo` subdocument for reply metadata

A reply message stores a `replyTo` subdocument with denormalized preview data — the quoted message's `id`, `senderId`, `senderName`, `messageType`, and an **encrypted preview snippet** (up to 80 characters of plaintext, encrypted with the room key). The receiver renders the reply strip **directly from the subdocument** — no need to resolve the quoted message from the local list. The subdocument is embedded in the reply's MongoDB document, so the receiver always has the preview regardless of pagination window.

**Why this avoids the pagination tombstone problem:** With a single `quotedMessageId` reference, a receiver whose local message list doesn't contain the quoted message (because they scrolled past it or it predates loaded history) would see a tombstone — even though the quoted message still exists. The subdocument eliminates this entirely: the preview is always embedded in the reply message itself, so the receiver **always** renders the correct preview regardless of pagination window or whether the original was deleted.

Trade-off: edits to the quoted message after the reply is sent do **not** propagate to the reply strip preview (it's a snapshot from compose time). This is consistent with WhatsApp's behavior — the preview reflects what the replier saw when they replied, not the latest edit. The reply body itself remains fully live.

### Decision 2: Edit and delete operate on the same MongoDB document

Rather than versioning (insert new doc, mark old deleted) — which would break cursor pagination and confuse the message stream — edits **overwrite** `ciphertext`, `iv`, `authTag`, and append `editedAt`. Deletes remove the document entirely. Both operations ride the existing `room_message` event channel so all connected clients stay in sync.

### Decision 3: 15-minute hard edit window (server-enforced)

Mirror WhatsApp/Telegram. After 15 minutes, the server rejects `edit_message` with `EDIT_WINDOW_EXPIRED`. The frontend hides the Edit option in the context menu using the same threshold.

### Decision 4: Delete is a hard delete (no tombstone)

The user explicitly requested no "This message was deleted" placeholder. The row is removed from `room_messages` and a `message_deleted` event is broadcast so every client removes the bubble.

### Decision 5: Reply preview always renders from the subdocument (no tombstone)

The reply strip renders its preview **exclusively from the subdocument** — the previewIv, previewCiphertext, and previewAuthTag for text, or the deterministic media icon for image/video/gif. The receiver never needs to look up the original message. When the original is hard-deleted, the subdocument is untouched (it's part of the reply document), so the reply strip continues to display the preview correctly. No tombstone is ever shown — the preview is a frozen snapshot of what the replier saw at compose time.

### Decision 6: All three operations blocked when the room is disabled

Consistent with the existing `send_message` `ROOM_DISABLED` guard. The server returns the same error code; the frontend hides the context menu options.

### Decision 7: Reply/edit/delete work for **all** message types (text, image, video, gif)

The context menu works uniformly across message types. For media, the reply strip renders a one-line icon label (e.g. "📷 Image", "🎬 Video", "📹 GIF") based on the resolved `messageType` of the quoted message.

### Decision 8: Swipe + long-press + info button (all three)

Long press opens the context menu on touch. Mouse `mousedown` + small movement threshold mimics it for desktop. A small info icon is **also** always visible on hover (desktop) / long-press affordance (mobile) so the action is discoverable. The swipe gesture (right on received, left on own) is layered on top of pointer events.

### Decision 9: Replies work for both received and own messages

There is no restriction. The same gesture and menu applies to both sides of the conversation.

### Decision 10: All three operations respect key versioning and key rotation

- **Deletes**: Do not require encryption.
- **Replies**: Carry an **encrypted preview snippet** inside the `replyTo` subdocument (up to 80 characters of quoted plaintext).
  - *Sourcing key for decryption*: The client composing the reply determines the key version of the quoted message ($V_{quoted}$) from the quoted message's `roomKeyVersion` field, retrieves that key from IndexedDB, and decrypts the original message text.
  - *Encryption key version for the preview*: The preview snippet is encrypted with the **current active key version of the room** ($V_{reply}$), which is the key version used for the reply message itself. This ensures that any recipient authorized to decrypt the reply message can also decrypt its preview strip, including late-joining members who may not possess $V_{quoted}$. No plaintext preview ever touches the wire or the database.
- **Edits**: Edits are re-encrypted client-side using the **original key version** ($V_{orig}$) of the message being edited, NOT the new/latest active room key version ($V_{new}$).
  - *Reasoning*: This ensures that historical members who were in the room when the message was sent (and possess $V_{orig}$) but have since left or been kicked (and do not possess $V_{new}$) can still decrypt the edited version of that historical message. The message's `roomKeyVersion` field in the database remains unchanged at $V_{orig}$.

---

## 2. Schema Changes — `room_messages`

### New fields added to the `room_messages` collection

| Field | Type | Notes |
|-------|------|-------|
| `replyTo` | Object? | `null` for non-reply messages. Subdocument with denormalized reply metadata (see shape below). |
| `replyTo.messageId` | ObjectId | The `_id` of the quoted message. Used for cross-reference lookups and the `message_deleted` cascade. |
| `replyTo.senderId` | ObjectId | Denormalized sender `_id` of the quoted message. Used to identify the original sender. |
| `replyTo.senderName` | String | Denormalized display name of the quoted message's sender. Avoids a members lookup at render time. |
| `replyTo.senderUserIndex` | Number? | Denormalized user index (e.g. 12) of the quoted message's sender. Used to render the '#index' next to their name in the reply strip (e.g., Alice #12) without resolving from the message list. |
| `replyTo.messageType` | String | `"text" \| "image" \| "video" \| "gif"` — denormalized so the reply strip renders the correct icon/label. |
| `replyTo.previewIv` | String? | IV for the encrypted preview. Present when `messageType === "text"`; `null` for media types (icon is deterministic). |
| `replyTo.previewCiphertext` | String? | Encrypted preview snippet (≤ 80 chars of plaintext). Present for text; `null` for media. |
| `replyTo.previewAuthTag` | String? | Auth tag for the encrypted preview. Present for text; `null` for media. The preview is encrypted with the reply message's own key version ($V_{reply}$) — not the key version of the original quoted message. |
| *(no `deletedAt` on the subdocument)* | | The reply strip always renders the preview from the subdocument. No tombstone is needed — the original's deletion doesn't affect the embedded preview. |
| `editedAt` | Date? | `null` unless the message has been edited. Used to compute remaining edit window. |
| `deletedAt` | Date? | **Optional soft-delete flag — currently unused.** Reserved if we ever change to soft-delete. Default: `null`. |
| `roomKeyVersion` | Number | The key version used to encrypt this message's body (and, for replies, the preview snippet). References `room_key_versions.version`. Default: `0`. **Immutable after insert** — the server never updates it on edit. |

### Final BSON shape (example, edited text message that is itself a reply to an image)

```json
{
  "_id": ObjectId("..."),
  "roomId": ObjectId("..."),
  "senderId": ObjectId("..."),
  "ciphertext": "uPgX3Z...",
  "iv": "kFm9a2B...",
  "authTag": "T1VxLk...",
  "messageType": "text",
  "roomKeyVersion": 3,
  "replyTo": {
    "messageId": ObjectId("..."),
    "senderId": ObjectId("..."),
    "senderName": "Alice",
    "senderUserIndex": 5,
    "messageType": "image",
    "previewIv": null,
    "previewCiphertext": null,
    "previewAuthTag": null
  },
  "editedAt": ISODate("2026-06-17T14:23:01.000Z"),
  "createdAt": ISODate("2026-06-17T14:20:55.000Z")
}
```

And for a text → text reply (preview encrypted):

```json
{
  "_id": ObjectId("..."),
  "roomId": ObjectId("..."),
  "senderId": ObjectId("..."),
  "ciphertext": "uPgX3Z...",
  "iv": "kFm9a2B...",
  "authTag": "T1VxLk...",
  "messageType": "text",
  "roomKeyVersion": 3,
  "replyTo": {
    "messageId": ObjectId("..."),
    "senderId": ObjectId("..."),
    "senderName": "Bob",
    "senderUserIndex": 12,
    "messageType": "text",
    "previewIv": "kFm9a2B...",
    "previewCiphertext": "eB4rP7...",
    "previewAuthTag": "X2pQvL..."
  },
  "editedAt": null,
  "createdAt": ISODate("2026-06-17T14:30:00.000Z")
}
```

> **Key version note**: `roomKeyVersion: 3` on the reply message means both the message body *and* the embedded `replyTo` preview snippet were encrypted with room key version 3 ($V_{reply}$). The quoted message (referenced by `replyTo.messageId`) may have been encrypted with a completely different key version — the receiver does not need that older key to render the preview strip.

### Why a subdocument instead of a single field

A single `quotedMessageId: ObjectId` is the smallest possible schema, but it creates a critical false-positive tombstone problem: if the quoted message is outside the receiver's paginated window (scrolled past, or predates loaded history), the receiver can't find it in the local list and incorrectly shows "Original message was deleted" — even though the message still exists. A subdocument with denormalized preview data eliminates this.

- **No pagination false-positives.** The subdocument carries everything needed to render the reply strip. Receivers who join late, scroll past the quoted message, or reconnect after the original was deleted — all correctly render the preview from the embedded subdocument. No tombstone logic needed.
- **No live-edit propagation, but that's fine.** Edits to the original don't re-encrypt the reply's frozen preview. This matches WhatsApp's behavior — the preview is a snapshot of what the replier saw. The reply body itself is fully independent.
- **Space vs. correctness trade-off.** The subdocument adds ~300+ bytes per reply (denormalized fields + 3 base64 envelopes for the encrypted preview). For a chat with 10% reply rate and 100,000 messages, that's ~3 MB extra — negligible for MongoDB. The correctness win far outweighs the storage cost.
- **Single covering index.** One index on `replyTo.messageId` is sufficient to find replies pointing at a given message (if ever needed for an admin feature). The reply-to lookup is not needed for the render path at all.

### New MongoDB indexes

| Index | Purpose |
|-------|---------|
| `{ roomId: 1, createdAt: 1, _id: 1 }` | **Already exists** — used for cursor pagination. |
| `{ "replyTo.messageId": 1 }` | Fast lookup of replies referencing a given message (for admin tools or debugging). Sparse — most rows have `replyTo=null`. Not needed for the render path — the subdocument is always embedded in the reply doc. |
| `{ roomId: 1, senderId: 1, createdAt: 1 }` | Pre-existing pattern, reused. |

### Migration strategy

All new fields are optional. Existing rows continue to function with `replyTo=null, editedAt=null`. The migration script (in `packages/frontend/src/app/api/setup-indexes/route.ts` family) creates the new index idempotently as a **sparse** index so the millions of `null` reply rows don't bloat it.

---

## 3. WebSocket Event Contract

All three operations ride the existing `socket.io` channel alongside `send_message`. Each event is **ack-acknowledged** so the originating client knows the server accepted/rejected the action.

### Client → Server

| Event | Payload | Ack |
|-------|---------|-----|
| `edit_message` | `{ roomId, messageId, ciphertext, iv, authTag }` | `{ ok, message }` or `{ ok: false, error }` |
| `delete_message` | `{ roomId, messageId }` | `{ ok }` or `{ ok: false, error }` |
| `send_message` *(extended)* | adds optional `replyTo: ReplyToPayload` | existing |

> The `send_message` payload gets a new **optional** `replyTo` object. Existing senders (no reply) keep working — the server treats `replyTo` as undefined and persists `null`.

Where `ReplyToPayload` is:

```ts
{
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif";
  previewIv: string | null;        // base64, null for media types
  previewCiphertext: string | null; // base64 encrypted preview, null for media types
  previewAuthTag: string | null;   // base64, null for media types
}
```

### Server → Client (broadcast to `room:{roomId}`)

| Event | Payload |
|-------|---------|
| `message_edited` | full updated message (id, roomId, senderId, ciphertext, iv, authTag, messageType, createdAt, editedAt, replyTo, senderName, senderUserIndex) |
| `message_deleted` | `{ roomId, messageId, senderId }` |

> The `message_edited` and `room_message` events include `replyTo` (the full subdocument or `null`). Clients render the reply strip directly from the subdocument fields — no local message-list lookup needed.
>
> When the original is hard-deleted, the reply subdocuments are **not** modified. The `message_deleted` event removes the original bubble, but reply strips continue to render their embedded previews unchanged.

---

## 4. Server-Side Workflows

All server logic lives in `packages/websocket-server/src/index.ts` (event handlers) and `packages/websocket-server/src/db.ts` (DB helpers). The REST `/api/rooms/[roomId]/messages` route needs no changes — it already serializes messages; we just enrich the serialization with `replyTo` and `editedAt`.

### 4.1 `send_message` (extended)

**Input validation (unchanged plus):**
- If `payload.replyTo` is present, it must be a valid object with the `ReplyToPayload` shape (see Section 3). `messageId` must be a valid ObjectId-shaped string (24 hex chars). `previewIv`, `previewCiphertext`, and `previewAuthTag` must all be present for text replies (or all `null` for media replies).

**Server-side verification (new):**
1. If `replyTo` is present, look up the quoted message in `room_messages` by `{ _id: replyTo.messageId, roomId }`.
2. If not found → reject with `error: "REPLY_TARGET_NOT_FOUND"`. (Client should not be quoting deleted messages, but the server is the source of truth.)
3. The server **does not** validate the denormalized fields (`senderId`, `senderName`, `messageType`) against the actual quoted message — the client computed these at compose time from the decrypted message. The server trusts them as metadata (the encrypted preview ensures integrity on the receiver side).
4. The server also enforces that the quoted message's `roomId` matches the target room (already implicit in the query filter).

**Persistence:** Insert into `room_messages` with the new `replyTo` subdocument (or `null`). The server stores the subdocument as-is (no re-encryption, no recomputation).

**Broadcast:** Existing `room_message` event now includes `replyTo` (the full subdocument or `null`) and `editedAt` (always `null` for new messages) on the outbound payload.

### 4.2 `edit_message`

**Authorization & Key Version Validation:**
1. Sender is an active member of the room (reuse `isActiveMember`).
2. Room is not disabled (reuse `isRoomDisabled`).
3. **The socket userId must equal the original `senderId` of the message being edited.** Reject with `error: "NOT_MESSAGE_OWNER"` otherwise.
4. The message must still exist. Reject with `error: "MESSAGE_NOT_FOUND"` otherwise.
5. **No active key version check**: The server does NOT enforce `data.roomKeyVersion === room.lastKeyVersion` for edits. The edit payload is expected to be encrypted with the message's original key version ($V_{orig}$), which remains unchanged.

**Edit window enforcement:**
- Compute `now - message.createdAt`. If > 15 minutes → reject with `error: "EDIT_WINDOW_EXPIRED"`.
- The window is hard. The frontend mirrors it client-side to hide the Edit option, but the server is authoritative.

**Persistence:**
- `db.collection("room_messages").updateOne({ _id, roomId, senderId: socket.data.userId }, { $set: { ciphertext, iv, authTag, editedAt: new Date() } })`
- Note: `replyTo` subdocument is **not** modified (it stays attached to the message — the reply context is preserved).
- Note: **`roomKeyVersion` is explicitly NOT modified** and remains at the original $V_{orig}$ value.
- The matched filter includes `senderId` as a defense-in-depth check (already validated above but extra safety).

**Broadcast:** Emit `message_edited` to `room:{roomId}` with the post-update document, enriched with sender info (reuse `getSenderInfo`). The broadcast payload retains the original `roomKeyVersion`.

### 4.3 `delete_message`

**Authorization:**
1. Sender is an active member of the room.
2. Room is not disabled.
3. `message.senderId === socket.data.userId`. Reject with `NOT_MESSAGE_OWNER` otherwise.

**Persistence:**
- `db.collection("room_messages").deleteOne({ _id, roomId, senderId: socket.data.userId })` — removes the original.
- No cascade on replies. The reply documents and their `replyTo` subdocuments are untouched.

> **Why no cascade:** Per Decision 5, the reply preview is a frozen snapshot embedded in the reply's subdocument. Deleting the original has no effect on the preview — the reply strip continues to render correctly from the subdocument. The `{ "replyTo.messageId": 1 }` index exists for potential admin tools, but is not needed on the render path.

**Broadcast:** Emit `message_deleted` with `{ roomId, messageId, senderId }`. Recipients:
- The sender themselves (confirmation).
- All other room members (live removal of the original bubble).
- Reply bubbles are unaffected — their strips render the subdocument preview as-is.

### 4.4 `message_edited` outbound shape

```ts
{
  id: string,
  roomId: string,
  messageId: string,    // duplicate of id for consistency with message_deleted
  senderId: string,
  ciphertext, iv, authTag,
  messageType,
  createdAt,
  editedAt: string,
  replyTo: {             // full subdocument or null
    messageId: string;
    senderId: string;
    senderName: string;
    senderUserIndex: number | null;
    messageType: "text" | "image" | "video" | "gif";
    previewIv: string | null;
    previewCiphertext: string | null;
    previewAuthTag: string | null;
  } | null,
  senderName, senderUserIndex
}
```

### 4.5 `message_deleted` outbound shape

```ts
{
  roomId: string,
  messageId: string,
  senderId: string
}
```

*(No tombstone event — the deletion of the original is silent. The bubble disappears with a fade animation. Reply bubbles and their subdocument previews are unaffected.)*

---

## 5. REST API (Patches & Backfill)

### 5.1 `GET /api/rooms/[roomId]/messages` — enrichment

The existing serializer (`serializeMessage`) in `app/api/rooms/[roomId]/messages/route.ts` must include the new fields:

```ts
function serializeMessage(doc) {
  return {
    id: doc._id.toString(),
    roomId: doc.roomId.toString(),
    senderId: doc.senderId.toString(),
    ciphertext: doc.ciphertext,
    iv: doc.iv,
    authTag: doc.authTag,
    messageType: doc.messageType,
    replyTo: doc.replyTo ? {                                                // NEW — full subdocument
      messageId: doc.replyTo.messageId.toString(),
      senderId: doc.replyTo.senderId.toString(),
      senderName: doc.replyTo.senderName,
      senderUserIndex: doc.replyTo.senderUserIndex ?? null,
      messageType: doc.replyTo.messageType,
      previewIv: doc.replyTo.previewIv ?? null,
      previewCiphertext: doc.replyTo.previewCiphertext ?? null,
      previewAuthTag: doc.replyTo.previewAuthTag ?? null,
    } : null,
    editedAt: doc.editedAt ? doc.editedAt.toISOString() : null,              // NEW
    createdAt: doc.createdAt.toISOString(),
    senderName: null,
    senderUserIndex: null,
  };
}
```

No new query logic — same cursor/since pagination.

### 5.2 `POST /api/rooms/[roomId]/messages/edit` — not needed

Edit rides the WebSocket. A REST fallback could be added later for offline-edit-while-reconnecting, but the initial release does not need it (clients receive `message_edited` events live; reconnecting clients re-fetch via `sync_since`).

### 5.3 `POST /api/rooms/[roomId]/messages/delete` — not needed

Same rationale.

### 5.4 Index setup route

Extend `app/api/setup-indexes/route.ts` (or create a new `/api/setup-reply-indexes` route) to add the sparse `{ "replyTo.messageId": 1 }` index idempotently.

### 5.5 `GET /api/rooms/[roomId]/messages/around` — new endpoint

New route at `app/api/rooms/[roomId]/messages/around/route.ts`. Fetches a window of messages centered on a target message. See Section 18.2 for full specification.

### 5.6 `GET /api/rooms/[roomId]/messages` — newer-direction pagination

Extend the existing messages endpoint to accept `direction=newer` query parameter. When present, fetch messages **newer** than the cursor (ascending sort, cursor points to the newest). See Section 18.5.1 for full specification.

---

## 6. Frontend Workflows

### 6.1 `lib/models.ts` — extended `RoomMessage` interface

```ts
export interface ReplyToInfo {
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif";
  previewIv: string | null;
  previewCiphertext: string | null;
  previewAuthTag: string | null;
}

export interface RoomMessage {
  // ... existing fields
  replyTo?: ReplyToInfo | null;
  editedAt?: string | null;
}
```

A new helper `decryptReplyPreview` (lives in a new `lib/quoted-message.ts`) decrypts the preview snippet from the subdocument using the key version of the reply message itself ($V_{reply}$):

```ts
export async function decryptReplyPreview(
  replyTo: ReplyToInfo,
  roomKey: CryptoKey | null
): Promise<string> {
  // For media types, the icon is deterministic — no decryption needed
  if (replyTo.messageType !== "text") {
    const label: Record<string, string> = {
      image: "📷 Image",
      video: "🎬 Video",
      gif: "📹 GIF",
    };
    return label[replyTo.messageType] ?? "📎 Media";
  }

  // If the key for the reply message is not available in IndexedDB
  if (!roomKey) {
    return "message unavailable";
  }

  // For text, decrypt the preview snippet embedded in the subdocument
  try {
    return await decryptMessage(
      replyTo.previewCiphertext!,
      replyTo.previewIv!,
      replyTo.previewAuthTag!,
      roomKey
    );
  } catch (err) {
    console.error("Failed to decrypt reply preview:", err);
    return "message unavailable";
  }
}
```

> **No local message-list lookup is needed.** The subdocument contains everything the receiver needs to render the reply strip. The preview is decrypted using the key version of the reply message ($V_{reply}$). If that key version is missing in the receiver's IndexedDB (or decryption fails), it safely falls back to displaying `"message unavailable"`.

### 6.2 `lib/socket-client.ts` — new client helpers

```ts
export interface OutboundEditMessage {
  roomId: string;
  messageId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface OutboundDeleteMessage {
  roomId: string;
  messageId: string;
}

export async function editEncryptedMessage(payload: OutboundEditMessage) {
  return emitWithAck<{ ok: boolean; error?: string; message?: RealtimeRoomMessage }>(
    "edit_message",
    payload
  );
}

export async function deleteEncryptedMessage(payload: OutboundDeleteMessage) {
  return emitWithAck<{ ok: boolean; error?: string }>("delete_message", payload);
}
```

Extend `OutboundEncryptedMessage` to include an optional `replyTo: ReplyToPayload` field.

### 6.3 `components/chat/message-list.tsx` — `UiMessage` shape

Add optional `replyTo?: ReplyToInfo | null` and `editedAt?: string | null`. The reply strip's content is rendered **directly from the subdocument** — no local message-list lookup at render time. The `UiMessage` simply carries the subdocument as-is from the API/socket response.

### 6.4 `components/chat/room-page` (`app/rooms/[roomId]/page.tsx`) — handlers

Three new async functions:

- `handleEdit(messageId, newBody)` — re-encrypts with the room key, calls `editEncryptedMessage`. On ack, replaces the local message. On error, surfaces via `setStatus`.
- `handleDelete(messageId)` — opens a confirm dialog; on confirm, calls `deleteEncryptedMessage`. On ack, removes the local message.
- `handleReply(message)` — sets the reply context (passed to `ChatInput`) with `messageId`, `senderId`, `senderName`, `messageType`, and the decrypted preview text. Shows a reply preview strip above the input.

Plus socket event listeners:

- `socket.on("message_edited", ...)` — find the message in state, replace.
- `socket.on("message_deleted", ...)` — filter the message out of state (use a CSS fade-out for UX polish).

### 6.5 Reply context state

Add to the room page:

```ts
const [replyContext, setReplyContext] = useState<{
  messageId: string;
  senderId: string;
  senderName: string;
  messageType: "text" | "image" | "video" | "gif";
  preview: string;     // decrypted plaintext preview
} | null>(null);
```

Pass `setReplyContext` to `MessageList` (or `MessageBubble`) and `replyContext` + `onClearReply` to `ChatInput`. Clearing the context after a successful send or when the user taps the X in the reply strip.

### 6.6 Edit state

```ts
const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
const [editingDraft, setEditingDraft] = useState("");
```

When the user picks "Edit" from the context menu, populate `editingMessageId` and `editingDraft`. The input swaps to edit mode (different placeholder, "Save" button, "Cancel" button). On save, call `handleEdit`. On cancel, clear state.

### 6.7 Cryptographic helpers for reply previews

The reply flow needs one new crypto helper — `encryptMessagePreview` — that encrypts the preview snippet (up to 80 characters of plaintext) for embedding in the `replyTo` subdocument. It reuses the existing `encryptMessage` under the hood. The `roomKey` passed to this function must be the **current active room key version** ($V_{reply}$) under which the reply itself will be encrypted.

```ts
export function encryptMessagePreview(
  text: string | null,
  messageType: "text" | "image" | "video" | "gif",
  roomKey: CryptoKey
): { previewIv: string | null; previewCiphertext: string | null; previewAuthTag: string | null } {
  // Media types don't need a preview — the icon is deterministic
  if (messageType !== "text") {
    return { previewIv: null, previewCiphertext: null, previewAuthTag: null };
  }

  // Truncate to 80 chars for the preview
  const truncated = (text ?? "").slice(0, 80);
  return encryptMessage(truncated, roomKey);
}
```

The receiver side also needs a new `decryptReplyPreview` helper (see Section 6.1). The sender's `preview` field in `replyContext` (Section 6.5) is the **plaintext** preview — only used for the local reply strip above the input, never sent over the wire. This plaintext preview is decrypted locally beforehand. If the key for the quoted message is missing, the reply UI disables quoting or displays "message unavailable".

---

## 7. E2EE & Reply Resolution

The subdocument approach keeps the reply flow fully E2EE — the preview is encrypted with the room key and embedded in the reply document. The receiver never needs to look up the original message.

### Sender side (composing a reply)

#### Key version selection

When composing a reply, two distinct key versions are involved:

| What | Key version used | Why |
|------|------------------|-----|
| Decrypting the quoted message body (to show the preview above the input) | $V_{quoted}$ — the `roomKeyVersion` field on the quoted message, looked up from IndexedDB | The original message was encrypted with this version |
| Encrypting the preview snippet embedded in `replyTo` | $V_{reply}$ — the current active room key version, the same key used for the reply body itself | Ensures any authorized recipient of the reply can also decrypt its preview strip |
| Encrypting the reply body | $V_{reply}$ — the current active room key version | Normal outgoing message encryption |

**Edge case — missing $V_{quoted}$ when composing**

If the client cannot retrieve $V_{quoted}$ from IndexedDB (key not yet fetched, or rotation happened before client synced), the reply UI should:
1. Attempt to re-fetch the key distribution from the server (`GET /api/rooms/:roomId/my-key-distribution`).
2. If still unavailable, **disable the Reply action** for that message and display an inline notice: `"message unavailable"`.
3. Never allow replying with an unresolvable quoted message — the encrypted preview would be corrupt.

#### Compose flow

1. User selects a message in the chat (via swipe or context menu "Reply").
2. Client retrieves $V_{quoted}$ from the quoted message's `roomKeyVersion` field.
3. Client retrieves the key for $V_{quoted}$ from IndexedDB: `getRoomKeyVersion(roomId, V_quoted)`.
4. Client decrypts the quoted message body with that key → `quotedPlaintext`.
5. `replyContext` is set with `{ messageId, senderId, senderName, messageType, preview: quotedPlaintext }`. The `preview` is used only for the local reply strip above the input — never sent or stored.
6. User types their reply body → presses send.
7. Client retrieves $V_{reply}$ (the current active room key version) and its key from IndexedDB.
8. Client encrypts **two things** with the $V_{reply}$ key:
   - **The reply body**: `encryptMessage(body, keyV_reply) → { ciphertext, iv, authTag }`
   - **The preview snippet**: `encryptMessagePreview(quotedPlaintext, messageType, keyV_reply) → { previewIv, previewCiphertext, previewAuthTag }` (returns `null` for all three if the quoted message is a media type, since the icon is deterministic).
9. Client sends `send_message` with `roomKeyVersion: V_reply` and:
   ```ts
   {
     roomId,
     ciphertext, iv, authTag,
     roomKeyVersion: V_reply,
     messageType: "text" | "image" | "video" | "gif",
     replyTo: {
        messageId: "65f1a...",
        senderId: "user_b_id...",
        senderName: "Bob",
        senderUserIndex: 12,
        messageType: "text",
        previewIv: "kFm9a2B...",
        previewCiphertext: "eB4rP7...",
        previewAuthTag: "X2pQvL...",
     }
   }
   ```
   The `replyTo` subdocument carries everything the receiver needs to render the strip — no resolution required.

### Receiver side (rendering a reply)

1. Client receives `room_message` with `replyTo` populated (or `null` for non-replies) and `roomKeyVersion: V_reply`.
2. Client decrypts the main body using `getRoomKeyVersion(roomId, V_reply)` from IndexedDB → `body`.
3. At render time, the bubble renders the reply strip **directly from the subdocument**:
   - Sender name from `replyTo.senderName`.
   - Preview from `decryptReplyPreview(replyTo, keyV_reply)` — the same key that decrypted the reply body, since both the body and the embedded preview were encrypted with $V_{reply}$.
   - Icon/label determined by `replyTo.messageType`.
   - If `keyV_reply` is not available in IndexedDB, `decryptReplyPreview` returns `"message unavailable"` as a safe fallback.
4. The bubble renders: a top strip with the quoted sender's name + the preview, the reply body below, the timestamp. No local message-list lookup.

### Why this is E2EE-safe

The preview snippet is encrypted with $V_{reply}$ (the same key version as the reply body itself) before being sent and stored. The quoted plaintext is **never** transmitted or stored unencrypted. The receiver decrypts the preview using $V_{reply}$ — the key they already hold to read the reply message. This is intentionally different from $V_{quoted}$ (the key version under which the original message was encrypted), so that late-joining members who only have recent key versions can still read reply previews without needing older key versions. The subdocument's `messageId` and `senderId` fields are not sensitive (they're ObjectIds, not plaintext) and are safe to store unencrypted.

### Edge case: replying to a message that gets deleted before the receiver connects

The receiver gets a `message_deleted` event for the original message — the original bubble is removed from the local list. The reply bubble stays. Its `replyTo` subdocument is untouched (it's part of the reply document), so `decryptReplyPreview` works as normal using $V_{reply}$. The strip continues to show the preview. **No tombstone.**

### Edge case: edit of a quoted message after a reply is sent

The reply's `replyTo` subdocument is a frozen snapshot — it contains the preview as it was at compose time, encrypted with $V_{reply}$. Edits to the original message (which re-encrypt with $V_{orig}$) do **not** update reply previews. This is consistent with WhatsApp's behavior: the preview reflects what the replier saw when they replied. The reply body itself is fully independent and unaffected.

### Edge case: key rotation happens between composing a reply and receiving it

If a key rotation occurs after the sender composed the reply (and chose $V_{reply}$) but before other clients receive the `room_message` event:
- The reply message itself arrives with `roomKeyVersion: V_reply`.
- Recipients who already have $V_{reply}$ in IndexedDB can decrypt both the body and the preview strip normally.
- Recipients who were offline during rotation and have not yet fetched $V_{reply}$ will trigger `fetchAndCacheRoomKeys` on reconnect (as defined in the key rotation architecture), then decrypt normally.
- The server does not block the `room_message` event based on key version — key version is metadata only.

---

## 8. UI Specification (WhatsApp-Equivalent)

### 8.1 Reply bubble (incoming + outgoing)

```
┌──────────────────────────────────────────┐
│ ┌─ Quoted message (top strip) ─────────┐ │
│ │ ┌─ neutral border ─────────────────┐ │ │
│ │ │ Original Sender Name #index      │ │ │
│ │ │ "First 80 chars of original…"    │ │ │
│ │ └──────────────────────────────────┘ │ │
│ └───────────────────────────────────────┘ │
│ This is the reply body text.             │
│ 14:23 ✓✓                                  │
└──────────────────────────────────────────┘
```

- The quoted strip is rendered with a thicker left border using a neutral color from the theme (e.g. `border-neutral-700` or `#262626`). There is NO sender color used, as the app does not support sender colors.
- The sender's user index is shown as an appended `#index` next to their name (e.g. `Alice #12`), resolved directly from `replyTo.senderUserIndex`.
- The sender name comes from `replyTo.senderName`. The preview text comes from decrypting `replyTo.previewCiphertext` (text) or from a deterministic media icon based on `replyTo.messageType` (image → 📷, video → 🎬, gif → 📹).
- The body, time, and double-check mark use the normal bubble styling.

### 8.2 Edited message indicator

Under the timestamp, add a small italic `edited` tag (e.g. in muted gray). The tag is hidden if `editedAt` is `null` or absent.

### 8.3 Context menu (long press / info button)

A small dialog/popover near the message bubble with three items:

- **Reply** (icon: Reply arrow, lucide `Reply`)
- **Edit** (icon: Pencil, lucide `Pencil`) — shown only if `isOwn && (now - createdAt) < 15 min`
- **Delete** (icon: Trash, lucide `Trash2`) — shown only if `isOwn`

The menu is anchored to the bubble and rendered as an absolutely positioned popover. It dismisses on outside click, Escape key, or after any action.

### 8.4 Info button (accessibility)

A small `MoreHorizontal` (`lucide-react`) icon button rendered in the top-right of the bubble, visible:
- On hover (desktop, CSS `:hover` only — never visible on mobile).
- On long-press hold (mobile, mirrors the gesture result).

If long-press doesn't fire within 600ms (e.g. user lifts finger too early), the info button stays visible as a fallback.

### 8.5 Reply strip above the input

When `replyContext` is set, the input area grows upward by ~36px to show a strip:

```
┌─ Replying to Alice ─────────────────  ✕ ┐
│ "Original message preview..."            │
└──────────────────────────────────────────┘
```

- `✕` clears the reply context.
- Strip background: `bg-neutral-900`; text: `text-neutral-400`.
- Border bottom: `border-neutral-700`.

### 8.6 Edit mode input

When `editingMessageId` is set, the input changes:

- Placeholder: "Edit message"
- Send button: "Save" (text instead of arrow icon, or a check icon)
- A `Cancel` button appears to the right of the text input.
- The bubble being edited gets a subtle highlight (`ring-1 ring-white/30`).

### 8.7 Delete confirmation dialog

Modal dialog (uses existing shadcn-style primitives in `components/ui`):

```
┌──────────────────────────────────────┐
│  Delete message?                     │
│                                      │
│  This message will be permanently     │
│  removed from the chat. This action   │
│  cannot be undone.                    │
│                                      │
│            [ Cancel ]  [ Delete ]    │
└──────────────────────────────────────┘
```

- **Delete** button: `bg-red-600 hover:bg-red-500 text-white`.
- **Cancel** button: `variant="ghost"`.
- Closes on Escape or backdrop click (with no action).
- After confirm, the delete request fires and the bubble is removed optimistically (or after the ack — see Section 12.3).

---

## 9. Swipe-to-Reply Gesture

### Implementation strategy

Layer on top of pointer events (`onPointerDown` / `onPointerMove` / `onPointerUp`). Use a single `PointerSensor` per message bubble. Track:
- `startX`, `startY`, `startTime` on pointer down.
- `deltaX = currentX - startX` on pointer move.
- Ignore if `|deltaY| > |deltaX|` (vertical scroll intent) — let the scroll happen.

### Direction logic

```ts
const SWIPE_THRESHOLD = 60; // px to trigger
const direction = message.isOwn ? "left" : "right";
// on move: if (direction === "right" && deltaX > SWIPE_THRESHOLD) triggerReply();
// on move: if (direction === "left"  && deltaX < -SWIPE_THRESHOLD) triggerReply();
```

This matches WhatsApp: received messages (left side of the screen) swipe **right**; own messages (right side) swipe **left**.

### Visual feedback during swipe

- Translate the bubble horizontally with the pointer (`transform: translateX(${deltaX * 0.4}px)`).
- A faded reply icon appears on the far side of the bubble, fading in proportional to `Math.min(1, |deltaX| / SWIPE_THRESHOLD)`.
- On release below threshold → spring back to origin.
- On release above threshold → fire the reply, snap the bubble back, animate the reply strip in above the input.

### Edge cases

- **Vertical scroll priority**: if the user is scrolling the message list, the horizontal gesture must not fire. We check `|deltaY| > |deltaX|` early.
- **Multi-touch**: ignore any pointer event that isn't the first active pointer.
- **Reduced motion**: skip the spring/scale animation, fire the reply immediately on threshold.

### Library choice

Two options:
1. **Hand-rolled pointer events** (recommended) — keeps the bundle small, full control over feel. ~80 lines of code.
2. **`@use-gesture/react`** — proven library, ~15 KB gzipped. Faster to write but a new dependency.

Decision: hand-rolled to avoid adding a new dependency. The behavior is small enough.

---

## 10. Long-Press Context Menu

### Touch / mouse

```ts
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10; // px

let timer: number | null = null;
let startX = 0, startY = 0;
let fired = false;

onPointerDown(e => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  startX = e.clientX; startY = e.clientY;
  fired = false;
  timer = window.setTimeout(() => { fired = true; openContextMenu(); }, LONG_PRESS_MS);
});

onPointerMove(e => {
  if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE) {
    if (timer) { clearTimeout(timer); timer = null; }
  }
});

onPointerUp(() => {
  if (timer) { clearTimeout(timer); timer = null; }
  // Note: we do NOT open the menu on plain tap; that's reserved for selection / scroll.
});

onContextMenu(e => {
  e.preventDefault();        // suppress the browser's default right-click menu
  openContextMenu();
});
```

`openContextMenu` records which message the menu is for, then renders a popover. The popover:
- Is positioned at the pointer location with viewport-edge clamping.
- Has three buttons (Reply / Edit [conditional] / Delete [conditional]).
- Auto-dismisses on any click outside, on any further pointer activity, or on Escape.

### Accessibility

- Each bubble has `role="button"`, `tabIndex={0}`, `aria-haspopup="menu"`.
- The context menu uses `role="menu"`, items use `role="menuitem"`.
- Enter / Space on a focused bubble opens the menu.
- Arrow keys navigate the menu; Enter activates; Escape closes.

---

## 11. Delete Confirmation Dialog

Implemented in `components/chat/delete-confirm-dialog.tsx`. Uses the same dialog primitive as the rest of the UI. State lives in the room page:

```ts
const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
```

When the user picks "Delete" from the context menu, we set `pendingDeleteId`. The dialog renders when `pendingDeleteId !== null`. On confirm:

1. Call `deleteEncryptedMessage({ roomId, messageId: pendingDeleteId })`.
2. On ack, optimistically remove from local state.
3. Close the dialog.

The dialog is non-blocking in the sense that the user can still scroll the chat underneath; it's a centered modal with a backdrop. If the ack fails, re-add the message and show a status banner.

---

## 12. Data Flow Round Trips (End-to-End)

### 12.1 Reply (text → text)

1. **User A** long-presses a message from **User B** in the room.
2. Context menu opens → user taps "Reply".
3. `setReplyContext({ messageId: "m1", senderId: "user_b", senderName: "Bob", messageType: "text", preview: "Hey, are you free?" })` runs. (The `preview` is used only for the local reply strip above the input — it's **not** sent over the wire.)
4. Reply strip renders above the input.
5. User A types "Yes, what's up?" and presses Enter.
6. Client:
   - `const encrypted = await encryptMessage("Yes, what's up?", roomKey)` → reply body encryption
   - `const previewEncrypted = await encryptMessagePreview("Hey, are you free?", "text", roomKey)` → preview snippet encryption
   - `socket.emit("send_message", { roomId, ciphertext, iv, authTag, messageType: "text", replyTo: { messageId: "m1", senderId: "user_b", senderName: "Bob", messageType: "text", ...previewEncrypted } })`
7. **WebSocket server** (`packages/websocket-server/src/index.ts`):
   - Verifies sender is an active member.
   - Verifies room is not disabled.
   - If `replyTo` is present, looks up `{ _id: replyTo.messageId, roomId }` in `room_messages`. If not found → reject with `error: "REPLY_TARGET_NOT_FOUND"`.
   - `db.collection("room_messages").insertOne({ roomId, senderId, ciphertext, iv, authTag, messageType: "text", replyTo: { messageId: ObjectId("m1"), senderId: ObjectId("user_b"), senderName: "Bob", messageType: "text", previewIv: "...", previewCiphertext: "...", previewAuthTag: "..." }, createdAt: new Date() })`
   - `io.to(\`room:\${roomId}\`).emit("room_message", { id, roomId, senderId, ciphertext, iv, authTag, messageType: "text", replyTo: { ... subdocument ... }, createdAt, senderName, senderUserIndex })`
   - `ack({ ok: true, message: outbound })`
8. **User A's client** receives the `room_message` → decrypts body normally. At render time, the reply strip renders directly from `replyTo` (decrypts the preview snippet). No local list lookup. Clears the input `replyContext`.
9. **User B's client** receives the `room_message` → decrypts body, pushes message. At render time, the reply strip renders directly from `replyTo` — decrypts the preview snippet and renders it alongside the sender name. **No lookup of message `m1` needed** — the strip renders from the subdocument even if `m1` is outside the loaded window.

### 12.2 Edit (text)

1. **User A** long-presses their own message `m2` ("Let's meet at 5", originally encrypted at $V_{orig}$). Context menu shows Edit (created 2 min ago, within the 15 min window).
2. User picks Edit → `setEditingMessageId("m2")`, `setEditingDraft("Let's meet at 6")`.
3. Input swaps to edit mode. User presses Save (Enter).
4. **Client (key selection)**:
   - Reads `m2.roomKeyVersion` → $V_{orig}$.
   - Retrieves `keyV_orig = await getRoomKeyVersion(roomId, V_orig)` from IndexedDB.
   - **If `keyV_orig` is null** (key not in IndexedDB): surfaces an error and aborts the edit — the client must not encrypt with an incorrect key version.
   - Encrypts the new body with $V_{orig}$: `const encrypted = await encryptMessage("Let's meet at 6", keyV_orig)`
   - Emits: `socket.emit("edit_message", { roomId, messageId: "m2", ciphertext, iv, authTag })`
   - *(The key version is not re-sent in the payload — the server does not update it)*
5. **WebSocket server**:
   - Validates membership, room enabled, ownership, 15-min window.
   - Does **not** enforce `roomKeyVersion === room.lastKeyVersion` (edits preserve the original key version).
   - `db.collection("room_messages").updateOne({ _id: ObjectId("m2"), roomId, senderId }, { $set: { ciphertext, iv, authTag, editedAt: new Date() } })`
   - `roomKeyVersion` on the document remains $V_{orig}$ — it is **not** updated.
   - `io.to(\`room:${roomId}\`).emit("message_edited", { id, roomId, messageId, senderId, ciphertext, iv, authTag, messageType, createdAt, editedAt, replyTo, roomKeyVersion: V_orig, senderName, senderUserIndex })`
   - `ack({ ok: true, message })`
6. **User A's client** receives the `message_edited` event → updates the message in state (decrypts the new body, sets `editedAt`).
7. **User B's client** receives the same event → updates its local copy. The bubble re-renders with the new text and the "edited" tag. Reply bubbles referencing `m2` are **unaffected** — their `replyTo` subdocument is a frozen snapshot and is not re-decrypted.

### 12.3 Delete (text)

1. **User A** long-presses their own message `m2`. Picks Delete.
2. Confirmation dialog opens.
3. User confirms.
4. Client:
   - Optimistically remove `m2` from local state (with a brief 200ms fade-out animation).
   - `socket.emit("delete_message", { roomId, messageId: "m2" })`
5. **WebSocket server**:
   - Validates membership, room enabled, ownership.
   - `db.collection("room_messages").deleteOne({ _id: ObjectId("m2"), roomId, senderId })`
   - `io.to(\`room:\${roomId}\`).emit("message_deleted", { roomId, messageId: "m2", senderId })`
   - `ack({ ok: true })`
6. **All clients** (User A included, for live consistency across tabs) receive the event. The original message is removed from local state.
7. If User B had replies pointing to `m2`, those replies remain. Their `replyTo` subdocuments are untouched (part of the reply document). The reply strip continues to render the preview from the subdocument — **no tombstone**. No extra signal needed.

### 12.4 Reply → edit → delete (compound scenario)

1. User A sends a text message `m1`.
2. User B replies to `m1` → `m2` (a reply message with `replyTo: { messageId: "m1", ... }`) is created. The preview is encrypted at compose time and embedded in `m2`.
3. User A edits `m1`. The `message_edited` event updates both clients' local copies of `m1`. **User B's `m2` preview is unaffected** — it was a frozen snapshot from compose time.
4. User A deletes `m1`. The `message_deleted` event removes `m1` from both clients. The `m2` bubble stays. Its reply strip continues to render the preview from the embedded `replyTo` subdocument. **No tombstone.**

### 12.5 Reply to a media message

The sender encrypts the reply body normally. For the preview, since the quoted message is a media type, `encryptMessagePreview` returns `{ previewIv: null, previewCiphertext: null, previewAuthTag: null }` — no text to encrypt, the icon is deterministic:

```ts
socket.emit("send_message", {
  roomId, ciphertext, iv, authTag, messageType: "text",
  replyTo: {
    messageId: "m_image_id",
    senderId: "user_b",
    senderName: "Bob",
    messageType: "image",            // ← media type
    previewIv: null,
    previewCiphertext: null,
    previewAuthTag: null,
  }
});
```

At render time, `decryptReplyPreview` checks `replyTo.messageType` — since it's `"image"`, it returns `"📷 Image"` without attempting decryption.

### 12.6 Edit on a media message (e.g. swapping a caption)

Currently the reply-to-a-media flow stores the media metadata JSON as the encrypted body. An "edit" on a media message would re-encrypt a new metadata JSON. This works as-is. We do not support swapping the actual file (that would require a new object key, presigned URL, etc.) — out of scope for this feature.

---

## 13. Edge Cases & Error Handling

| Edge case | Handling |
|-----------|----------|
| Quoted message deleted before reply arrives | Server rejects with `REPLY_TARGET_NOT_FOUND`. Client surfaces a status banner: "This message is no longer available." |
| Quoted message edited after reply is sent | Reply strip shows the frozen preview from the subdocument encrypted with $V_{reply}$ — edits to the original (re-encrypted at $V_{orig}$) do not propagate (Decision 1). The reply body is unaffected. |
| Edit attempted >15 min after send | Server rejects with `EDIT_WINDOW_EXPIRED`. Client hides Edit option from the context menu after the same threshold. |
| Edit attempted by non-owner | Server rejects with `NOT_MESSAGE_OWNER`. Client also hides Edit option for non-owned messages. |
| Delete attempted by non-owner | Server rejects with `NOT_MESSAGE_OWNER`. Client also hides Delete option for non-owned messages. |
| Delete on a message that has replies | Replies remain with their embedded preview — the subdocument is part of the reply doc and is untouched. No tombstone (Decision 5). |
| Network drop mid-edit | The ack is lost; the server may or may not have applied the change. On reconnect, `sync_since` re-fetches. If the server has the edit, the client picks it up. If not, the client retries the edit on reconnect (queued in a small in-memory `pendingActions` list, flushed after `join_room` ack). |
| Network drop mid-delete | Same pattern as edit. On reconnect, `sync_since` returns the new state; the client reconciles. |
| Room disabled mid-session | Server rejects all three operations with `ROOM_DISABLED`. Client hides the context menu items. |
| Sender sends a reply, then loses connection before ack | The client does **not** optimistically render the message (it waits for the broadcast). If the server rejected, the client surfaces the error. The `send_message` event is fire-and-forget for now; a retry queue can be added later. |
| Encrypted preview length exceeds limit | Client truncates to 80 chars before encryption; the resulting AES-GCM envelope is ~100 bytes, well within any payload cap. |
| User edits the message while still in edit mode (race) | Server's updateOne is atomic. The latest write wins. Client overwrites local state on `message_edited`. |
| Multiple tabs open | Each tab receives the same `room_message` / `message_edited` / `message_deleted` events. State stays consistent because all tabs are subscribed to the same socket room. |
| Message bubble re-renders while context menu is open | The context menu is positioned via a portal. The portal unmounts when the menu is closed. Re-renders don't affect it. |
| `cursor` pagination on `/messages` skips a deleted message | No problem: the cursor points at `_id` + `createdAt`, both stable. A deleted message just doesn't appear. |
| Edit of a message the receiver never had | The receiver gets `message_edited` for an unknown id. Client ignores (filter by known ids). |
| Delete of a message the receiver never had | Same — client filters. |
| **$V_{orig}$ missing from IndexedDB when user tries to edit** | Client calls `fetchAndCacheRoomKeys(roomId)` to re-fetch the key distribution for that version. If still unavailable (e.g. the user was removed from the room before that key was distributed to them), the Edit option is disabled for that specific message with no user-visible error beyond the button being greyed out. |
| **$V_{reply}$ missing from IndexedDB when a received reply is rendered** | `decryptReplyPreview` returns `"message unavailable"` as a safe fallback. The reply body itself may also fail to decrypt, which is handled by the normal `handleIncomingMessage` missing-key flow (`"[Unable to decrypt - missing key version]"`). |
| **$V_{quoted}$ missing when composing a reply** | Client attempts to re-fetch via `fetchAndCacheRoomKeys`. If still unavailable, the Reply action is disabled for that message. The sender sees an inline notice: `"message unavailable"`. |
| **Key rotation occurs mid-edit (sender is in edit mode)** | The rotation changes the room's active key to $V_{new}$, but the edit should still target $V_{orig}$ (the original key of the message). The client reads `roomKeyVersion` from the in-state message object, which is immutable during edit mode. The edit proceeds with $V_{orig}$ as designed. |
| **Key rotation occurs mid-reply (sender is typing a reply)** | If the active key rotates to $V_{new}$ while the sender is composing, `getLatestRoomKeyVersion(roomId)` will return $V_{new}$ when the user presses Send. The preview and body are both encrypted with $V_{new}$. The older $V_{quoted}$ was already used to decrypt the local preview above the input — that is unaffected. Recipients who have not yet fetched $V_{new}$ will receive the `KEY_ROTATION_COMPLETE` event and then fetch it (per the key rotation architecture), after which the reply renders normally. |
| **Editing a message whose key version ($V_{orig}$) has been superseded by many rotations** | IndexedDB stores all key versions fetched at room entry. The client can retrieve any historical $V_{orig}$ via `getRoomKeyVersion(roomId, V_orig)`. No performance issue — the lookup is a single IndexedDB get by composite key. |

---

## 14. Performance Considerations

- **No new DB writes per send for non-reply messages**: `replyTo` is `null` for ordinary messages; the BSON footprint is ~12 bytes overhead (one empty document subfield, sparse-indexed).
- **Edit overwrites the encrypted body**: no version table, no row duplication. The `replyTo` subdocument is **not** modified during edits.
- **Delete is a single `deleteOne`**: cheap. No cascade on replies.
- **`message_edited` and `message_deleted` are tiny events**: < 200 bytes each (they reference existing ciphertext/iv/authTag for edit; the delete is just an id).
- **Reply subdocument is ~300 bytes per reply**: denormalized fields + 3 base64 envelopes for the encrypted preview. For a chat with 10% reply rate and 100,000 messages, that's ~3 MB extra — negligible for MongoDB.
- **Preview decryption is done once per reply on insert**: the plaintext is cached in the `UiMessage` so re-renders don't re-decrypt.
- **Swipe gesture handler is per-bubble**: cleanup on unmount. No global listener leak.
- **Long-press timer cleared on pointer up / move**: no orphan timers.
- **`/messages/around` is a fixed-cost query**: always fetches 25+25 messages regardless of distance. The composite index `{ roomId: 1, createdAt: 1, _id: 1 }` covers both the older and newer sub-queries. No full collection scan.
- **Memory cap on loaded messages**: if total loaded messages exceed 500 during extended browsing, trim from the opposite scroll direction and update cursors. Prevents unbounded DOM and state growth.
- **Down-arrow badge is a counter, not a list**: new messages received while jumped away are counted but not fetched until the user scrolls to bottom. Minimal overhead.
- **Bidirectional cursor pagination uses the same index**: `direction=newer` queries use the same `{ roomId: 1, createdAt: 1, _id: 1 }` index with a reverse scan. No new indexes needed.

---

## 15. File Change Summary

### Backend

| File | Change |
|------|--------|
| `packages/websocket-server/src/index.ts` | Add `edit_message` and `delete_message` socket handlers. Add `replyTo` validation in `send_message`. Add `message_edited` and `message_deleted` broadcasts. |
| `packages/websocket-server/src/db.ts` | Add `updateMessageContent(roomId, messageId, senderId, ciphertext, iv, authTag)`, `deleteMessage(roomId, messageId, senderId)`. Extend `fetchMessagesSince` and `persistEncryptedMessage` to handle `replyTo` subdocument and `editedAt`. |
| `packages/frontend/src/app/api/rooms/[roomId]/messages/route.ts` | Extend `serializeMessage` with `replyTo` subdocument and `editedAt`. Add `direction=newer` support for bidirectional cursor pagination. |
| `packages/frontend/src/app/api/rooms/[roomId]/messages/around/route.ts` *(new)* | New endpoint: fetches 25+25 message window centered on a target message. Returns messages + cursors + hasOlder/hasNewer. |
| `packages/frontend/src/app/api/setup-indexes/route.ts` | Add sparse `{ "replyTo.messageId": 1 }` index. |

### Frontend

| File | Change |
|------|--------|
| `packages/frontend/src/lib/models.ts` | Add `ReplyToInfo` interface. Extend `RoomMessage` with `replyTo` and `editedAt`. |
| `packages/frontend/src/lib/socket-client.ts` | Add `editEncryptedMessage` and `deleteEncryptedMessage` helpers. Extend `OutboundEncryptedMessage` with `replyTo: ReplyToPayload`. |
| `packages/frontend/src/lib/messages-client.ts` | Add `fetchMessagesAround(roomId, messageId, limit?)` helper. Add `direction` param to `fetchMessageHistory` for newer-direction pagination. |
| `packages/frontend/src/lib/quoted-message.ts` *(new)* | `encryptMessagePreview(plaintext, messageType, roomKey)` and `decryptReplyPreview(replyTo, roomKey)` helpers. |
| `packages/frontend/src/components/chat/message-list.tsx` | Add `onReply`, `onEdit`, `onDelete`, `onShowMenu`, `onQuoteClick` props. Render reply strip inside each bubble by decrypting the `replyTo` subdocument preview. Render edited indicator. Render info button on hover. Wire swipe + long-press handlers. Add `jumpTargetId` prop for highlight animation. |
| `packages/frontend/src/components/chat/message-context-menu.tsx` *(new)* | Popover with Reply / Edit / Delete buttons. |
| `packages/frontend/src/components/chat/delete-confirm-dialog.tsx` *(new)* | Confirm dialog. |
| `packages/frontend/src/components/chat/down-arrow-button.tsx` *(new)* | Floating down-arrow button centered above input. Shows new-message badge. Appears when `isAtBottom === false`. Handles smooth scroll-to-bottom on click. |
| `packages/frontend/src/components/chat/chat-input.tsx` | Accept `replyContext` / `onClearReply` / `editingDraft` / `editingMessageId` / `onSaveEdit` / `onCancelEdit` props. Render reply strip. Render edit-mode placeholder + buttons. |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Add reply/edit/delete state. Add jump navigation state (`jumpTargetId`, `isAtBottom`, `newerCursor`, `newMessagesCount`). Add `handleQuoteClick` (calls `/messages/around`, replaces list, scrolls to target). Add `loadNewer` for bidirectional pagination. Add `scrollToBottom` handler. Wire `down-arrow-button`. Modify `room_message` handler to conditionally append based on `isAtBottom`. Wire `message_edited` / `message_deleted` socket events. Add handlers. Pass new props to children. |
| `packages/frontend/src/lib/crypto.ts` | Add `encryptMessagePreview(text, messageType, roomKey)` — truncates to 80 chars and encrypts with room key. Returns `null` fields for media types. |

### Docs

| File | Change |
|------|--------|
| `docs/reply-edit-delete-architecture.md` | This file. |
| `context.md` | Append a section summarizing the new events, schema fields, and behaviors. |

---

## 16. Migration & Backfill Plan

1. **Schema migration**: No backfill needed. All new fields are optional. Existing rows have `replyTo=null, editedAt=null`.
2. **Index creation**: Add the sparse `{ "replyTo.messageId": 1 }` index via the existing `setup-indexes` route (idempotent).
3. **Client compatibility**: Older clients (no edit/delete UI) ignore the new fields. New clients ignore the lack of fields in older messages. No coordination needed during the rollout.
4. **Deploy order**:
   - Deploy the WS server with the new event handlers (the new fields on outbound `room_message` are safe — old clients ignore `replyTo` and `editedAt`).
   - Deploy the frontend.
   - Run the index creation script.

---

## 17. Open Questions

> Resolved by the user during planning:
> - Reply metadata strategy → **Subdocument with encrypted preview** (Decision 1).
> - Reply to deleted message → **No tombstone — preview always renders from subdocument** (Decision 5).
> - Edit window → **15 min hard cap, server-enforced** (Decisions 3 + 4).
> - Room disabled behavior → **Block all three** (Decision 6).
> - Schema layout → **`replyTo` subdocument** (Section 2).
> - Long-press UX → **Long press + info button** (Section 10).
> - Swipe direction → **Right on received, left on own** (Section 9).
> - Edit enforcement → **Hard 15 min cap** (Section 4.2).
> - Scroll-to-quoted → **25+25 window + cursor pagination** (Section 18).
> - Down arrow appearance → **Both scroll-up and quoted-message click** (Section 18.4).
> - New message badge → **Show count on down arrow** (Section 18.4).
> - Down arrow click behavior → **Hybrid: ≤10 new messages → fetch all; >10 → fetch most recent page only** (Section 18.4).
> - Highlight color → **Match application theme: `bg-white/5 border-l-2 border-white/30`** (Section 18.7).
> - Memory cap → **500 loaded messages, trim from opposite end** (Section 18.8).

> Still open for future work (not blocking this feature):
> - **Edit history**: Should the user be able to see the previous version of an edited message? (WhatsApp does not.) For now: no.
> - **Admin delete**: Should OWNER/ADMIN be able to delete any member's message? Out of scope. Future iteration.
> - **Read receipts on edit/delete**: Not in the current feature surface.
> - **Swipe-to-reply keyboard accessibility**: A11y users would use the context menu (long-press) or the info button. Full keyboard support is a follow-up.
> - **GIF preview**: For `gif` replies, the preview is a static string. We could embed a tiny blurred thumbnail (encrypted) instead, but that's a UX refinement.

---

## 18. Scroll-to-Quoted-Message & WhatsApp-Style Navigation

### 18.1 Overview

When a user taps a quoted message preview (the reply strip above a message bubble), the app navigates to that quoted message in the chat history — identical to WhatsApp's behavior. Instead of loading every message between the current viewport and the target (which could be thousands of messages and seconds of network time), we fetch a **window of 25 messages above and 25 messages below** the target, then rely on **cursor-based pagination** as the user scrolls up or down from that position.

A **down-arrow button** appears (horizontally centered, just above the input area) whenever the user is not at the live bottom of the chat — either because they scrolled up or because they jumped to a quoted message. Tapping it scrolls smoothly to the live bottom and resumes normal real-time message flow.

### 18.2 New REST Endpoint — `GET /api/rooms/[roomId]/messages/around`

```
GET /api/rooms/[roomId]/messages/around?messageId=<targetId>&limit=25
```

**Query parameters:**

| Param | Required | Default | Notes |
|-------|----------|---------|-------|
| `messageId` | Yes | — | The `_id` of the target message to center the window on |
| `limit` | No | `25` | Number of messages to fetch above and below the target |

**Response shape:**

```json
{
  "messages": [ /* sorted by createdAt ASC, includes the target message */ ],
  "targetMessageId": "65f1a...",
  "hasOlder": true,
  "hasNewer": true,
  "olderCursor": { "createdAt": "2026-06-17T14:10:00.000Z", "id": "65f0b..." },
  "newerCursor": { "createdAt": "2026-06-17T14:30:00.000Z", "id": "65f2c..." }
}
```

**Server logic (in `app/api/rooms/[roomId]/messages/around/route.ts`):**

1. Validate `messageId` is a valid 24-hex-char ObjectId string. Return 400 if invalid.
2. Look up the target message: `db.collection("room_messages").findOne({ _id: ObjectId(messageId), roomId: ObjectId(roomId) })`. Return 404 if not found.
3. Fetch `limit` **older** messages:
   ```ts
   db.collection("room_messages").find({
     roomId: ObjectId(roomId),
     $or: [
       { createdAt: { $lt: target.createdAt } },
       { createdAt: target.createdAt, _id: { $lt: target._id } }
     ]
   }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray()
   ```
   Reverse the result to ascending order.
4. Fetch `limit` **newer** messages:
   ```ts
   db.collection("room_messages").find({
     roomId: ObjectId(roomId),
     $or: [
       { createdAt: { $gt: target.createdAt } },
       { createdAt: target.createdAt, _id: { $gt: target._id } }
     ]
   }).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray()
   ```
5. Merge: `[...older, target, ...newer]`. Sort ascending by `createdAt, _id`.
6. Compute `hasOlder = (older.length === limit)` and `hasNewer = (newer.length === limit)`.
7. Compute `olderCursor` from the **first** message in the merged array (oldest), `newerCursor` from the **last** (newest).
8. Enrich all messages with sender info via `enrichMessagesWithSenders`.
9. Return the response.

**Why 25+25 instead of fetching "all pages to the target":** Loading every message between current viewport and target is O(n) in the distance — potentially thousands of messages. The 25+25 window is O(1) regardless of distance. Cursor pagination handles further scrolling naturally.

### 18.3 Frontend Flow — Clicking a Quoted Message

1. User taps the reply strip (quoted message preview) on any bubble.
2. The `onQuoteClick(messageId)` callback fires, where `messageId` comes from `replyTo.messageId`.
3. Client calls `GET /api/rooms/[roomId]/messages/around?messageId={messageId}&limit=25`.
4. On response:
   - **If the target message was deleted by the owner (server returns 404)**:
     - Client displays a prompt/alert dialog to the user stating: "The quoted message does not exist" (e.g. because it was deleted by the owner).
     - Keep the current message list and viewport scroll position unchanged.
     - Abort the jump flow.
   - **If the target message exists (server returns 200)**:
     - **Replace** the entire local message list with the returned `messages` array (decrypt via `decryptBatch`).
     - Set `jumpTargetId = messageId` (used for highlight animation, cleared after 2 seconds).
     - Set `hasOlder = response.hasOlder`, `hasNewer = response.hasNewer`.
     - Store `olderCursor` and `newerCursor` for subsequent pagination requests.
     - Set `isAtBottom = false` (the view is now somewhere in the middle of history).
     - Scroll to the target message element using `element.scrollIntoView({ block: 'center' })`.
5. After 2 seconds, clear `jumpTargetId` — the highlight fades out.

**State additions to the room page:**

```ts
const [jumpTargetId, setJumpTargetId] = useState<string | null>(null);
const [isAtBottom, setIsAtBottom] = useState(false);
const [newerCursor, setNewerCursor] = useState<{ createdAt: string; id: string } | null>(null);
const [newMessagesCount, setNewMessagesCount] = useState(0);
```

**Existing `historyCursor`** continues to serve as the `olderCursor` for scrolling up. The new `newerCursor` state handles scrolling down from a jumped position.

### 18.4 Down Arrow Button

**Appearance rules:**
- Visible when `isAtBottom === false` — this covers **both** scenarios: (a) user scrolled up from the live bottom, and (b) user clicked a quoted message and the view jumped away from the bottom.
- Hidden when `isAtBottom === true` (user is at the live bottom).

**Disappearance rules:**
- User scrolls to within 100px of the bottom → `isAtBottom = true`, button hides.
- User clicks the down arrow → smooth scroll to bottom, `isAtBottom = true`, button hides.

**Positioning:**
- Horizontally centered in the chat message area.
- Vertically: positioned just above the input area, with 16px margin above the input.
- Uses `position: fixed` or `sticky` with `bottom` calculated relative to the input height.
- Z-index: above message bubbles (`z-20`), below modals.

**Styling:**
- background using `bg-[var(--surface-raised)]` (`#111111`), border using `border-[var(--border)]` (`#262626`). Matches the application's existing dark theme exactly — no new accent colors.
- Downward chevron icon from `lucide-react` (`ChevronDown`), size 20px, color `text-[var(--foreground)]` (`#e5e5e5`).
- Badge circle in the top-right corner showing `newMessagesCount` (number of new messages received since jumping away from bottom). Badge uses `bg-[var(--surface-raised)]` with `text-[var(--foreground)]` text. Badge is hidden when `newMessagesCount === 0`.
- Dimensions: approximately 40x40px.

**Behavior on click:**
1. **Small count (≤ 10 new messages):** Fetch all newer messages in one or multiple pages until `hasNewer === false`. Append them to the local list. Smooth-scroll to the bottom.
2. **Large count (> 10 new messages):** Fetch the most recent page (30 messages) via cursor pagination. Append to the local list. Smooth-scroll to the bottom. The remaining messages in between are skipped — the user sees a gap, same as WhatsApp when there are many new messages.
3. Set `isAtBottom = true`. Clear `newMessagesCount`.
4. Resume normal real-time message appending via WebSocket.

### 18.5 Bidirectional Cursor-Based Pagination After Jump

After the initial 25+25 window loads, scrolling triggers standard cursor pagination in **both directions**.

**Scrolling up (loading older messages):**
- Trigger: scroll position within 200px of the top of the loaded messages.
- Call: `GET /api/rooms/[roomId]/messages?cursor={historyCursor}&limit=30` (existing endpoint, existing `direction` not yet supported — see Section 18.5.1).
- Prepend results to the local message list (using `mergeMessages`).
- Preserve scroll position (same technique as existing `loadOlder`).
- Update `historyCursor` to the new `nextCursor`.

**Scrolling down (loading newer messages):**
- Trigger: scroll position within 200px of the bottom of the loaded messages.
- Call: `GET /api/rooms/[roomId]/messages?cursor={newerCursor}&limit=30&direction=newer` (new direction param — see Section 18.5.1).
- Append results to the local message list.
- Update `newerCursor` to the new cursor from the response.
- Update `hasNewer`.

**Reaching the live bottom:**
- When `hasNewer === false` and user scrolls to within 100px of the bottom → set `isAtBottom = true`.
- Hide the down arrow button.
- Resume normal real-time message appending via WebSocket.

#### 18.5.1 Extending the Existing Messages Endpoint for Newer-Direction Pagination

The existing `GET /api/rooms/[roomId]/messages` only supports fetching **older** messages (descending sort, cursor points to the oldest). To support scrolling **down** from a jumped position, add a `direction` query parameter:

```
GET /api/rooms/[roomId]/messages?cursor={id}&limit=30&direction=newer
```

When `direction=newer`:
- Fetch messages with `{ createdAt: { $gt: cursor.createdAt } }` OR `{ createdAt: cursor.createdAt, _id: { $gt: cursor.id } }`.
- Sort ascending (`createdAt ASC, _id ASC`).
- Return `{ messages, nextCursor }` where `nextCursor` points to the **newest** message in the batch (for fetching even newer messages).

When `direction` is omitted or `older` (default): existing behavior — fetch messages older than cursor, sort descending, reverse to ascending.

### 18.6 Real-Time Updates During Jumped State

When the user is viewing a window around an old message (not at the live bottom):

**New incoming messages (`room_message` WebSocket event):**
- If `isAtBottom === false` (user is not at the live bottom): **do not append** the new message to the local list. Instead, increment `newMessagesCount`. The down-arrow badge shows this count.
- If `isAtBottom === true`: append normally (existing behavior).

**When the user scrolls to the bottom or clicks the down arrow:**
- If there are messages in the newer portion not yet loaded, fetch them via cursor pagination.
- Append all fetched messages to the local list.
- Set `isAtBottom = true`. Clear `newMessagesCount`.

**Edits and deletes (`message_edited`, `message_deleted`):**
- Apply normally if the affected message is in the current local list (find by `id`).
- Ignore if the affected message is not in the local list (it's outside the loaded window — no need to update).

### 18.7 Highlight Animation

When the target message is scrolled into view after clicking a quoted message:

- Apply a temporary highlight style to the target bubble: `bg-white/5 border-l-2 border-white/30`.
  - Uses the application's existing theme palette (`white` with low opacity for backgrounds, `white/30` for the accent border) — no introducing new accent colors. This keeps the highlight consistent with the dark-theme design language.
- The highlight fades out over 2 seconds using CSS transition: `transition: background-color 2s ease-out, border-color 2s ease-out`.
- After the transition completes, remove the highlight classes entirely.
- Implementation: add a `highlighted` prop to `MessageBubble`. When `jumpTargetId === message.id`, set `highlighted = true`. Use a `useEffect` with a 2-second timeout to clear it.

### 18.8 Edge Cases

| Edge case | Handling |
|-----------|----------|
| Target message was deleted (quoted message does not exist) | Server returns 404. When clicked, client displays a prompt/alert dialog to the user stating: "The quoted message does not exist" (e.g., because it was deleted by the owner). The chat view remains unchanged. |
| Target message is the only message in the room | `hasOlder` and `hasNewer` are both `false`. The single message renders centered. |
| User clicks another quoted message while already jumped | Repeat the full flow: fetch 25+25 around the new target, replace the list, scroll to new target. Reset `newMessagesCount`. |
| Network error during `/messages/around` fetch | Show error toast. Keep the current message list unchanged. |
| User scrolls rapidly after jump (many pages loaded) | **Memory management**: if loaded messages exceed 500, trim from the opposite end of the scroll direction and update the corresponding cursor. This prevents unbounded memory growth. |
| Target message is the very first or last message in the room | One side of the window may have fewer than 25 messages. `hasOlder` or `hasNewer` is `false`. The window is asymmetric but functional. |
| User is offline when clicking a quoted message | Show "No connection" toast. No fetch attempted. |
| `messageId` in `replyTo` references a message in a different room | Server validates `roomId` in the lookup query — returns 404. Client shows toast. |
| Scroll position after fetching newer messages during jump | Preserve scroll position (same technique as `loadOlder` — save `scrollHeight` before merge, restore after). |

---

### 18.9 Updated Data Flow — End-to-End (Quote Click)

1. **User A** sees a reply bubble from **User B** that quotes an old message from **User A** (message `m_old`).
2. User A taps the reply strip (the quoted preview showing "Hey, are you free?").
3. `onQuoteClick("m_old")` fires.
4. Client: `GET /api/rooms/{roomId}/messages/around?messageId=m_old&limit=25`.
5. **Server** looks up `m_old` by `_id + roomId`. Fetches 25 older + 25 newer. Returns 51 messages sorted ascending + cursors.
6. **Client** checks response:
   - If server returns 404 (message deleted), displays a user-facing prompt: "The quoted message does not exist" and aborts the flow.
   - If successful, client decrypts all 51 messages, replaces the local message list, sets `jumpTargetId = "m_old"`, sets `hasOlder/hasNewer` and cursors, and scrolls to `m_old` element with `scrollIntoView({ block: 'center' })`.
7. **User A** sees the target message centered with a `bg-white/5 border-l-2 border-white/30` highlight that fades over 2 seconds (matches the application's dark theme).
8. User A scrolls up → `loadOlder()` fires, prepends older messages. Scrolls down → `loadNewer()` fires, appends newer messages.
9. User A taps the down arrow → small count (≤ 10): fetches all newer pages and scrolls to bottom. Large count (> 10): fetches only the most recent page and scrolls to bottom. Resumes live message flow.
10. Meanwhile, **User C** sends a new message via WebSocket. Since `isAtBottom === false`, it's not appended — `newMessagesCount` increments. The badge on the down arrow shows "1". When User A taps the down arrow (count = 1 ≤ 10, small count), the new message is fetched and displayed.

---

## Implementation Completion

All changes have been implemented and both frontend and websocket-server compile with zero TypeScript errors.

### Files Modified

| File | What changed |
|------|-------------|
| `packages/frontend/src/lib/models.ts` | Added `ReplyToInfo` interface, extended `RoomMessage` with `replyTo` and `editedAt` |
| `packages/frontend/src/lib/socket-client.ts` | Added `ReplyToPayload` interface, `OutboundEditMessage`/`OutboundDeleteMessage`, `editEncryptedMessage`/`deleteEncryptedMessage` helpers, extended `OutboundEncryptedMessage`/`RealtimeRoomMessage` with reply/edit fields |
| `packages/frontend/src/lib/crypto.ts` | *(no changes needed — existing `encryptMessage`/`decryptMessage` reused)* |
| `packages/frontend/src/lib/quoted-message.ts` | **New file** — `encryptMessagePreview` and `decryptReplyPreview` helpers |
| `packages/frontend/src/lib/messages-client.ts` | Added `fetchMessagesAround`, `direction` param to `fetchMessageHistory`, `MessagesAroundResponse` interface |
| `packages/frontend/src/components/chat/message-list.tsx` | Extended `UiMessage` with `replyTo`/`editedAt`, added reply strip rendering, edited indicator, swipe-to-reply gesture, long-press detection, info button, `onReply`/`onEdit`/`onDelete`/`onQuoteClick`/`highlighted` props |
| `packages/frontend/src/components/chat/chat-input.tsx` | Added reply strip above input, edit mode with Save/Cancel, `replyContext`/`onClearReply`/`editingMessageId`/`onSaveEdit`/`onCancelEdit` props |
| `packages/frontend/src/components/chat/message-context-menu.tsx` | **New file** — popover with Reply/Edit/Delete buttons |
| `packages/frontend/src/components/chat/delete-confirm-dialog.tsx` | **New file** — modal confirmation dialog |
| `packages/frontend/src/components/chat/down-arrow-button.tsx` | **New file** — floating down-arrow with new-message badge |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Added reply/edit/delete state management, context menu, delete dialog, jump-to-quote with `/messages/around`, bidirectional cursor pagination, down-arrow with hybrid fetch logic, `message_edited`/`message_deleted` socket listeners, reply-aware `onSend`, `handleSaveEdit`, `handleConfirmDelete` |
| `packages/frontend/src/app/api/rooms/[roomId]/messages/route.ts` | Extended `serializeMessage` with `replyTo`/`editedAt`, added `direction=newer` bidirectional pagination |
| `packages/frontend/src/app/api/rooms/[roomId]/messages/around/route.ts` | **New file** — 25+25 message window around target message |
| `packages/frontend/src/app/api/setup-indexes/route.ts` | Added sparse `replyTo.messageId` index |
| `packages/websocket-server/src/index.ts` | Added `edit_message` and `delete_message` socket handlers, extended `send_message` with `replyTo` validation, added `message_edited`/`message_deleted` broadcasts, included `replyTo`/`editedAt` in outbound payloads |
| `packages/websocket-server/src/db.ts` | Added `ReplyToSubdocument` type, extended `PersistEncryptedMessageInput` with `replyTo`, added `updateMessageContent` and `deleteMessage` functions, extended `fetchMessagesSince` return with `replyTo`/`editedAt` |
