# API Optimization, WebSocket Migration & RPC Layer — Design Plan

**Status legend:** ☐ Proposed · ◐ Partially in place · ☑ Already implemented

This document covers four related workstreams requested for the DeChat API surface:

1. **[Part 1 — Payload Reduction](#part-1--response-payload-reduction)** — stop sending whole DB documents; trim every response to what the caller renders.
2. **[Part 2 — REST → WebSocket Migration](#part-2--rest--websocket-migration)** — which REST endpoints should move onto the existing global socket, and which should stay REST.
3. **[Part 3 — The RPC Layer](#part-3--the-rpc-layer)** — a modular, typed, minimal RPC surface over the global socket so frontend files stop calling `socket.emit(...)`/`socket.on(...)` with stringly-typed event names.
4. **[Part 4 — Google-style Rounded Listing Container](#part-4--google-style-rounded-listing-container)** — the grouped rounded-container UI for room listings and pending-request listings.

The analysis was produced from a first-hand read of all 40 API routes plus the socket client, session cache, membership helpers, and the four listing pages/components. It builds on the existing global-socket backbone documented in [`completed_docs/global_ws_architecture.md`](../completed_docs/global_ws_architecture.md) and reuses the REST→WS precedent set by [`docs/cache-sync-redesign.md`](./cache-sync-redesign.md) (`sync_room_cache`).

---

## Executive summary

The single dominant payload problem is **`user.pfp` stored inline as a base64 data-URL up to 1 MB** ([`api/me/pfp/route.ts`](../packages/frontend/src/app/api/me/pfp/route.ts) does `$set: { pfp: image }`). Because `enrichMembershipUsers()` and the message-sender enrichment fan that field out, a single avatar can be duplicated dozens of times in one response:

- `GET /rooms/[roomId]/messages` stamps `senderPfp` onto **every message** — 100 messages from 3 senders can carry the same base64 blob ~33× each.
- `GET /rooms/[roomId]/members` embeds `user.pfp` for **every** member, with **no pagination** (up to 500 rows).
- `GET /rooms/mine` embeds `user.pfp` + `publicKey` + `email` on **every** row — and every row belongs to the *same* viewer, so it is the identical blob repeated per room.
- The Redis session cache stores the full user object including the base64 `pfp`, so every cached-session hit carries it too.

Fixing avatars at the source (Part 1 §1) plus applying projection discipline and pagination (Part 1 §2–§3) collapses the majority of wire bytes. Parts 2–3 then remove round-trips entirely for the realtime-shaped endpoints, and Part 4 restyles the listings that consume the trimmed payloads.

---

# Part 1 — Response Payload Reduction

## Design principles

1. **Never spread a Mongo document into a response.** Replace every `{ ...doc, id }` and `enrichMembershipUsers` spread with an explicit field allow-list (a `.project()` at query time *and* an explicit response mapping). [`api/rooms/requests/route.ts`](../packages/frontend/src/app/api/rooms/requests/route.ts) is the house model to copy.
2. **Avatars are never inline base64 in a list or a message.** Send a stable reference the client resolves once.
3. **Identity fields are sent once per response, not once per row.** A page of messages references `senderId`; the client joins against a small deduped sender map.
4. **Every list is bounded.** If a collection can grow with usage (members, key versions, distributions), it must paginate or cap.
5. **Only send a field to a caller that is allowed to use it.** `publicKey` goes to admins who wrap keys and to key-distribution paths — not to display-only rosters. `roomLink` (the invite secret) never goes to public discovery.

## §1 — The `pfp` fix (highest-impact, cross-cutting)

`pfp` should move from an inline base64 column to a **content-addressed reference**, consistent with how media already works ([`api/media/upload-url`](../packages/frontend/src/app/api/media/upload-url/route.ts) issues presigned R2 URLs).

**Target model:** replace `user.pfp: string /* data URL ≤1MB */` with:

```
user.pfpKey?:     string   // R2 object key, or null
user.pfpVersion?: number   // bumps on every upload; used for cache-busting
```

**Serving:** avatars resolve through one of:
- a stable public/CDN URL derived from `pfpKey` (preferred — cacheable by the browser and CDN), or
- `GET /api/users/:id/avatar` that 302-redirects to a presigned/CDN URL (fallback if avatars must stay access-controlled).

**Every list/message payload sends `pfpVersion` (a tiny int), never the image.** The client builds the URL (`/avatars/<userId>?v=<pfpVersion>`) and lets the browser cache it. This is the change that removes the ≤1 MB-per-row blowup from offenders #1–#4 below.

**Interim (if the storage migration is deferred):** at minimum, stop *duplicating* the blob — drop `senderPfp` from message payloads entirely (see §3) and drop `pfp` from `rooms/mine` (the viewer's own avatar is already known client-side). Those two changes alone remove the largest multipliers without a schema migration.

> ☐ Also stop `POST /api/me/pfp` from echoing the base64 back in its response (`{ ok, pfp: image }`) — return `{ ok, pfpVersion }`.

## §2 — Send the sender identity once, not per message

Today each serialized message carries `senderName`, `senderUserIndex`, and `senderPfp`. For a 100-message page these three fields repeat for every message even though there are only a handful of distinct senders.

**Proposed message-page shape:**

```jsonc
{
  "messages": [
    { "id, roomId, senderId, ciphertext, iv, authTag, messageType,
       roomKeyVersion, replyTo, editedAt, createdAt": "…" }
    // NO senderName / senderUserIndex / senderPfp on the row
  ],
  "senders": {
    "<senderId>": { "name": "…", "userIndex": 3, "pfpVersion": 7 }
  },
  "nextCursor": "…"
}
```

The client already holds a members map for the open room; `senders` is just the deduped delta for any sender not yet known. This applies identically to `/messages`, `/messages/around`, and `/messages/resume`, and to the `sync_room_cache` RPC response. `replyTo` keeps its own denormalized `senderName`/`senderUserIndex` (it is a single embedded reference, not a per-row multiplier) but should also drop any avatar.

## §3 — Per-route projection table

Legend: **REQ** = request body/query · **→** = proposed trimmed response · **Δ** = expected saving.

### Rooms — list / create / discovery

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET /api/rooms/mine` ☐ | `{...FULL membership, user:{name,email,publicKey,image,pfp}, room:{6 fields}}`, **no pagination** | `{roomId, role, status, userIndex, room:{id,name,description,joinPolicy,maxMembers,memberCount,isDisabled}}`. **Drop `user` entirely** (all rows are the viewer). Add `?limit&cursor`. | Removes a full membership doc + a repeated ≤1 MB self-avatar per row. Biggest single win on this endpoint. |
| `GET /api/rooms` (discovery) ☐ | `{...FULL room, id, memberCount, membershipStatus}` — leaks `creatorId, nextUserIndex, isActive, roomLink` | `.project({name,description,tags,joinPolicy,maxMembers,memberCount,isDisabled,createdAt})` → `{id, name, description, tags, joinPolicy, maxMembers, memberCount, isDisabled, membershipStatus}`. **Never emit `roomLink`** to discovery. | Drops 4 internal fields incl. the invite secret; already paginated. |
| `POST /api/rooms` (create) ☐ | `{room:{...FULL}, membership:{...FULL}}` | `{room:{id,name,description,tags,joinPolicy,maxMembers,memberCount,roomLink,createdAt,isDisabled,lastKeyVersion}, membership:{id,role,status,userIndex}}` (creator may see `roomLink`). | Drops `creatorId,nextUserIndex,isActive,pendingKeyRotation` + full membership internals. |

### Rooms/[roomId] — metadata / members / membership

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET /api/rooms/[roomId]` ☑ | hand-picked room + membership | **Already good** — keep as reference shape. | — |
| `GET /api/rooms/[roomId]/members` ☐ | `{userId,role,joinedAt,isOnline,userIndex,user:{name,email,image,publicKey,pfp}}`, **no pagination**, per-request `/internal/presence` fetch | `{userId, role, joinedAt, userIndex, name, pfpVersion}`. **Drop `publicKey`, `email`, inline `pfp`.** Add `?limit&cursor`. Move `isOnline` to the presence stream (Part 2). | Removes `publicKey` + `email` + ≤1 MB avatar × up to 500 rows, and removes a synchronous WS round-trip from the HTTP path. |
| `GET /api/rooms/[roomId]/membership` ☐ | `{...FULL membership}` | `{id, role, status, userIndex, isBlocked, currentKeyVersion}` | Drops `leftAt,lastVisitedAt,reviewedBy,reviewedAt,kickoutCount,createdAt,updatedAt`. |
| `PATCH /api/rooms/[roomId]/membership` ☐ | `{...FULL membership}` | `{ok, currentKeyVersion}` | Same trim; caller only needs confirmation + version. |
| `POST …/membership/sync-key-version` ☐ | `{...FULL membership}` | `{ok, currentKeyVersion}` | Same. |

### Join-requests (admin inbound list)

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET /api/rooms/[roomId]/join-requests` ◐ | `{userId,membershipId,createdAt,status,reviewedBy,reviewedAt, user:{name,email,publicKey,pfp}}`, **no pagination** | `{userId, membershipId, createdAt, name, pfpVersion, publicKey}`. **Keep `publicKey`** (admin wraps the room key on approval — justified). Drop `email`, inline `pfp`, `status/reviewedBy/reviewedAt` (all are PENDING by definition). Add `?limit&cursor`. | Removes `email` + ≤1 MB avatar per requester; keeps the one field that is actually used. |
| `POST …/join-requests/[userId]` (approve) ☐ | `{membership:{...FULL updated}}` | `{ok, memberCount}` | Full doc → confirmation; the approved user learns details via the existing `membership-updated` WS event. |

### Messages (read-only REST)

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET …/messages` ☐ | per-message `senderName/userIndex/senderPfp` | §2 shape: rows carry `senderId` only + one `senders` map + `pfpVersion`. | Removes the single largest multiplier in the whole API. |
| `GET …/messages/around` ☐ | same | §2 shape. | Same. |
| `GET …/messages/resume` ☐ | same, up to 200 msgs | §2 shape; and consider folding into the socket replay (Part 2). | Same, ×200. |

### Keys

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET /api/rooms/[roomId]/key-versions` ☐ | **unbounded** array, grows per rotation | `?limit` (default e.g. 50) + `?cursor`; project `{version, reason, createdAt, status}` (drop `createdBy, triggerUserId` unless the UI shows them). | Bounds an ever-growing array. |
| `GET …/my-key-distribution` ☐ | **unbounded** `{...,encryptedKey}` per version | Support `?sinceVersion=` so a client fetches only versions it lacks; the wrapped `encryptedKey` is required, but the *set* should be incremental, not "all versions ever". | Turns full-history refetch into a delta. |
| `GET /api/me/keys` ◐ | two ≤128 KB envelopes | Acceptable (needed for cross-device key retrieval) — no change, but note the size so it is never embedded in a list. | — |

### Tags

| Route | Today | Proposed | Δ |
|---|---|---|---|
| `GET /api/tags/popular` ☐ | **full `tag_stats` docs** incl. `dailyCounts[≤30]`, `currentDate`, timestamps, `_id` | `.project({tag:1, totalCount:1})` → `{tag, count}[]` | Drops a 30-element array + 4 metadata fields per tag. |
| `GET /api/tags/trending` ☐ | same full-doc dump | `{tag, trendingScore}[]` (or `{tag, count}`) | Same. |

### Already lean (no change)

`GET /api/me`, `PATCH /api/me`, `POST/PUT /api/me/keys`, `POST /api/me/public-key`, `GET /api/rooms/requests`, `GET /api/unread-counts` (projected — but see Part 2), all `gifs/*`, `fcm/register`, `media/upload-url`, `ws/ticket`, `ws/user-ticket`, `tags` / `tags/aggregate`, `setup-indexes`, and every already-WS-backed mutation.

---

# Part 2 — REST → WebSocket Migration

## What qualifies for the socket

An endpoint should move onto the global socket only if it is **realtime-shaped**: either its data changes continuously and is polled, or it is a mutation whose effect other connected clients must see immediately. Everything else — one-shot reads, config, auth handshakes, discovery, media presigning — **stays REST** (REST gives us HTTP caching, simple retries, and no socket-lifecycle coupling).

The socket already carries `send_message`, `edit_message`, `delete_message`, `mark_as_read`, `typing`, `sync_since`, and `sync_room_cache`, and the REST mutations already fan out through `/internal/*` (`room-metadata-updated`, `membership-updated`, `key-rotation-*`). The candidates below are the gaps.

## Migration matrix

| Endpoint | Verdict | Rationale |
|---|---|---|
| `GET /api/unread-counts` | **☐ Move to WS (push)** | Continuously polled; the counts already change via message events. Push deltas over the global user-socket; keep a single REST call only for the cold-start snapshot. |
| `GET …/members` presence (`isOnline`) | **☐ Split** | Serve the **roster** statically over REST (trimmed, paginated per Part 1) and **stream presence** (`isOnline` transitions) over the socket. Removes the per-request `/internal/presence` fetch. |
| `PATCH …/members/[userId]/role` | **☐ Add WS broadcast** | Mutation with **no** current WS push — other members don't see role changes until a manual refetch. Keep the REST mutation, add a `role_changed` event via `/internal/*`. |
| `POST /api/rooms/join` & `POST …/[roomId]/join` | **☐ Add WS notify** | Create PENDING requests but **do not** notify admins — the admin pending list is stale until refresh. Keep REST, emit a `join_requested` event to room admins. |
| `GET …/messages/resume` | **◐ Fold into socket replay** | Overlaps heavily with `sync_room_cache`; the reconnect catch-up path can live entirely on the socket (see [cache-sync-redesign](./cache-sync-redesign.md)). Retire the HTTP route once parity is confirmed. |
| room edit / disable / leave / approve / reject / batch-reject / kickout / key-rotation-complete | **☑ Already WS-backed** | Listed for completeness — these already fan out through `/internal/*`. |
| `POST send/edit/delete`, `mark_as_read`, `typing`, `sync_since`, `sync_room_cache` | **☑ Already on socket** | — |
| Everything else (auth, discovery, create, tags, gifs, media, tickets, keys CRUD, fcm) | **Keep REST** | Not realtime-shaped; HTTP semantics are the right fit. |

## Candidate specs

### 2a. Unread counts over the socket ☐

- **Cold start:** one REST `GET /api/unread-counts` (already projected) to seed the `unread-store` (Zustand+IndexedDB, per architecture doc).
- **Steady state:** the server already emits `unread_increment` / `unread_count_updated` (typed in [`socket-client.ts`](../packages/frontend/src/lib/socket-client.ts)). Stop the periodic REST poll and drive the store purely from these events plus `mark_as_read` acks.
- **Reconnect:** piggyback a `counts` delta on the existing reconnect/replay so a client that missed increments while offline catches up without a full re-fetch.

### 2b. Presence stream ☐

- New server→client event `presence_changed { roomId, userId, isOnline }`, scoped to the room channel the client is subscribed to.
- The members REST response drops `isOnline`; the client overlays presence from the stream. This deletes the synchronous `/internal/presence` HTTP hop currently inside the members route.

### 2c. Role-change broadcast ☐

- After `PATCH …/role` commits, POST `/internal/role-changed { roomId, userId, role }` (mirrors the existing `membership-updated` bridge).
- Server emits `role_changed` to `room:<roomId>`; clients patch their local roster/permissions live.

### 2d. Join-requested notification ☐

- After a join request is created, POST `/internal/join-requested { roomId, userId, name, pfpVersion }` targeted at the room's **admins** (reuse the deterministic member-id fan-out from the FCM/notification work).
- Admin clients increment a pending badge and prepend the row without a refetch — closing the gap where approve/reject/kick are realtime but the initial request is not.

> These four all follow the established pattern: **REST performs the write, `/internal/*` fans out the event, the RPC layer (Part 3) exposes a typed subscription.** No new transport is introduced.

---

# Part 3 — The RPC Layer

## The problem today

[`socket-client.ts`](../packages/frontend/src/lib/socket-client.ts) has grown two parallel ack helpers and ~20 near-duplicate wrappers:

- `emitWithAck` auto-routes via `const target = USE_GLOBAL_SOCKET ? globalSocket : socket`, while `emitWithGlobalAck` hard-codes the global socket.
- Every operation exists twice: `sendEncryptedMessage`/`sendGlobalEncryptedMessage`, `editEncryptedMessage`/`editGlobalEncryptedMessage`, `syncSince`/`syncGlobalSince`, `emitTyping`/`emitGlobalTyping`, `emitMarkAsRead`/`emitGlobalMarkAsRead`, plus four deprecated typing stubs.
- Frontend pages also call `socket.on("room_member_kicked", …)`, `socket.on("typing_stopped", …)` etc. directly (see [`rooms/joined/page.tsx`](../packages/frontend/src/app/rooms/joined/page.tsx)) with stringly-typed event names and untyped payloads — the "arbitrary event calls from frontend files" the task calls out.

The flag branch, the timeout, the `{ok:false}→throw` handling, and the event-name strings are all scattered.

## Design goals

- **One transport resolver.** A single place decides which socket a call uses. During the migration it honors `USE_GLOBAL_SOCKET`; post-migration it is simply "the global socket".
- **One request path, one subscription path.** `rpc.call(method, payload)` for request/response (ACK); `rpc.on(event, handler)` for server pushes. No page ever touches `socket.emit`/`socket.on`.
- **Fully typed method + event catalogs.** Method name → `{ request, response }`; event name → payload. The compiler rejects a wrong payload or a nonexistent event.
- **Minimal & modular.** One small core (`call`/`on`) + two declarative maps + thin typed facades. Deleting a wrapper is deleting a map entry.

## Module shape

```
src/lib/rpc/
  transport.ts   // resolveSocket(), the single flag-aware getter + ack/timeout core
  methods.ts     // RpcMethods: request/response types per ack method (the catalog)
  events.ts      // RpcEvents: payload type per server→client push
  index.ts       // rpc.call / rpc.on / typed facade (sendMessage, editMessage, …)
```

### transport.ts — the one resolver + core

```ts
import { getGlobalSocket, getSocket, USE_GLOBAL_SOCKET, ACK_TIMEOUT_MS } from "@/lib/socket-client";
import type { Socket } from "socket.io-client";

/** The single place that decides which socket every RPC uses. */
export function resolveSocket(): Socket {
  const s = USE_GLOBAL_SOCKET ? getGlobalSocket() : getSocket();
  if (!s) throw new RpcError("SOCKET_DISCONNECTED", "Socket is not connected");
  return s;
}

export class RpcError extends Error {
  constructor(public code: "SOCKET_DISCONNECTED" | "TIMEOUT" | "REJECTED", message: string) {
    super(message);
  }
}

/** ACK request/response with uniform timeout + {ok:false} handling. */
export function ackCall<Req, Res extends { ok: boolean; error?: string }>(
  event: string,
  payload: Req,
): Promise<Res> {
  const socket = resolveSocket();
  return new Promise((resolve, reject) => {
    socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err: unknown, res: Res) => {
      if (err) return reject(new RpcError("TIMEOUT", `RPC '${event}' timed out`));
      if (res && res.ok === false) return reject(new RpcError("REJECTED", res.error ?? `RPC '${event}' rejected`));
      resolve(res);
    });
  });
}
```

### methods.ts — the typed ACK catalog

```ts
import type {
  OutboundEncryptedMessage, OutboundEditMessage, OutboundDeleteMessage,
  RealtimeRoomMessage, SyncRoomCachePayload, SyncRoomCacheResponse,
} from "@/lib/socket-client";

type Ack<T = {}> = { ok: boolean; error?: string } & T;

export interface RpcMethods {
  send_message:      { req: OutboundEncryptedMessage; res: Ack<{ message?: RealtimeRoomMessage }> };
  edit_message:      { req: OutboundEditMessage;      res: Ack<{ message?: RealtimeRoomMessage }> };
  delete_message:    { req: OutboundDeleteMessage;    res: Ack };
  mark_as_read:      { req: { roomId: string; version: number }; res: Ack<{ conflict?: boolean; unreadCount?: number; version?: number }> };
  typing:            { req: { roomId: string; preview?: string }; res: Ack };
  sync_since:        { req: { roomId: string; since: string; sinceId?: string }; res: Ack<{ messages?: RealtimeRoomMessage[] }> };
  sync_room_cache:   { req: SyncRoomCachePayload; res: SyncRoomCacheResponse };
  watch_room_membership: { req: { roomId: string }; res: Ack };
  join_room:         { req: { roomId: string }; res: Ack };
}
```

### events.ts — the typed push catalog

```ts
import type {
  RealtimeRoomMessage, TypingEventPayload, TypingExpiredPayload,
  UnreadIncrementPayload, UnreadCountUpdatedPayload,
  KeyRotationPayload, KeyRotationCompletePayload,
} from "@/lib/socket-client";

export interface RpcEvents {
  room_message:        RealtimeRoomMessage;
  message_edited:      RealtimeRoomMessage;
  message_deleted:     { roomId: string; messageId: string };
  typing_started:      TypingEventPayload;
  typing_expired:      TypingExpiredPayload;
  unread_increment:    UnreadIncrementPayload;
  unread_count_updated: UnreadCountUpdatedPayload;
  key_rotation_pending: KeyRotationPayload;
  key_rotation_complete: KeyRotationCompletePayload;
  // Part 2 additions:
  presence_changed:    { roomId: string; userId: string; isOnline: boolean };
  role_changed:        { roomId: string; userId: string; role: "OWNER" | "ADMIN" | "MEMBER" };
  join_requested:      { roomId: string; userId: string; name: string; pfpVersion?: number };
  room_member_kicked:  { roomId: string; userId: string };
  room_member_left:    { roomId: string; userId: string };
  room_member_joined:  { roomId: string; userId: string };
  room_deleted:        { roomId: string };
}
```

### index.ts — the public surface

```ts
import { ackCall, resolveSocket } from "./transport";
import type { RpcMethods } from "./methods";
import type { RpcEvents } from "./events";

export const rpc = {
  /** Typed ACK request/response. */
  call<M extends keyof RpcMethods>(method: M, payload: RpcMethods[M]["req"]): Promise<RpcMethods[M]["res"]> {
    return ackCall(method as string, payload);
  },

  /** Typed server→client subscription. Returns an unsubscribe fn (drop-in for React effects). */
  on<E extends keyof RpcEvents>(event: E, handler: (payload: RpcEvents[E]) => void): () => void {
    const socket = resolveSocket();
    socket.on(event as string, handler as (p: unknown) => void);
    return () => socket.off(event as string, handler as (p: unknown) => void);
  },

  // Thin, discoverable facades (optional sugar over .call):
  sendMessage: (p: RpcMethods["send_message"]["req"]) => rpc.call("send_message", p),
  editMessage: (p: RpcMethods["edit_message"]["req"]) => rpc.call("edit_message", p),
  deleteMessage: (p: RpcMethods["delete_message"]["req"]) => rpc.call("delete_message", p),
  markAsRead: (roomId: string, version: number) => rpc.call("mark_as_read", { roomId, version }),
  typing: (roomId: string, preview?: string) => rpc.call("typing", { roomId, preview }),
  syncRoomCache: (p: RpcMethods["sync_room_cache"]["req"]) => rpc.call("sync_room_cache", p),
};
```

## What this replaces

| Before (scattered) | After (one surface) |
|---|---|
| `sendEncryptedMessage` **+** `sendGlobalEncryptedMessage` | `rpc.sendMessage(p)` |
| `editEncryptedMessage` **+** `editGlobalEncryptedMessage` | `rpc.editMessage(p)` |
| `deleteEncryptedMessage` **+** `deleteGlobalEncryptedMessage` | `rpc.deleteMessage(p)` |
| `emitTyping` **+** `emitGlobalTyping` **+** 4 deprecated typing stubs | `rpc.typing(roomId, preview)` |
| `emitMarkAsRead` **+** `emitGlobalMarkAsRead` | `rpc.markAsRead(roomId, v)` |
| `syncSince` **+** `syncGlobalSince` | `rpc.call("sync_since", …)` |
| `emitWithAck` **+** `emitWithGlobalAck` | `ackCall` (private) |
| `socket.on("room_member_kicked", …)` in pages | `rpc.on("room_member_kicked", …)` |

**Migration is mechanical and incremental:** keep `socket-client.ts` exports as thin re-exports that delegate to `rpc.*` (so nothing breaks), move call sites file-by-file to `rpc.*`, then delete the dead wrappers. The `USE_GLOBAL_SOCKET` branch survives in exactly one function (`resolveSocket`) and is deleted when Phase-2 migration completes — collapsing the last of the dual code paths noted in the architecture doc.

---

# Part 4 — Google-style Rounded Listing Container

## Target pattern

The reference is a Google account-picker: a **single rounded container** with a subtle border, where each entry is a **row** separated by hairline dividers (not an independent bordered card). Each row is `avatar circle · two-line (title / subtitle) · trailing action`.

Today, [`my-rooms`](../packages/frontend/src/app/my-rooms/page.tsx) and [`pending`](../packages/frontend/src/app/pending/page.tsx) render `space-y-4.5` **stacks of individually-bordered `rounded-xl` cards**, and the admin join-requests list ([`room-options-page.tsx:440`](../packages/frontend/src/components/chat/room-settings/room-options-page.tsx)) uses `space-y-2` bordered cards. We replace the per-item borders with **one grouped container + `divide-y` rows**. The existing dark tokens (`neutral-950` / `neutral-900` / `neutral-800`) already match the target palette — this is a **structural** change, not a recolor.

## Reusable primitives ☐

Add `src/components/ui/list-container.tsx`:

```tsx
export function ListContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 divide-y divide-neutral-800">
      {children}
    </div>
  );
}

export function ListRow({
  avatar, title, subtitle, badge, action, href, onClick,
}: {
  avatar: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-900/60">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          {badge}
        </div>
        {subtitle && <p className="mt-0.5 truncate text-xs text-neutral-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
  if (href) return <Link href={href} className="block">{body}</Link>;
  return <button type="button" onClick={onClick} className="block w-full text-left">{body}</button>;
}
```

And `src/components/ui/avatar.tsx` — a circular avatar that resolves the URL from `userId` + `pfpVersion` (Part 1 §1) and falls back to an initial:

```tsx
export function Avatar({ userId, name, pfpVersion, size = 40 }: {
  userId: string; name?: string | null; pfpVersion?: number; size?: number;
}) {
  const src = pfpVersion != null ? `/avatars/${userId}?v=${pfpVersion}` : null;
  return (
    <span
      className="inline-flex items-center justify-center overflow-hidden rounded-full bg-neutral-800 text-sm font-medium text-neutral-300"
      style={{ width: size, height: size }}
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        : (name?.[0]?.toUpperCase() ?? "?")}
    </span>
  );
}
```

## Before → after

**`my-rooms` (owned rooms)** — replace the `space-y-4.5` card stack:

```tsx
<ListContainer>
  {ownedRooms.map((r) => (
    <ListRow
      key={r.roomId}
      href={`/rooms/${r.roomId}`}
      avatar={<Avatar userId={r.roomId} name={r.room?.name} size={40} />}
      title={r.room?.name || "Unknown Room"}
      subtitle={`${r.room?.memberCount ?? 0}/${r.room?.maxMembers ?? 500} members`}
      badge={r.room?.isDisabled && (
        <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">Disabled</span>
      )}
      action={
        <button
          onClick={(e) => { e.preventDefault(); void handleToggleDisable(e, r.roomId); }}
          disabled={togglingId === r.roomId}
          className={`rounded-full px-3 py-1.5 text-[10px] font-medium transition disabled:opacity-50 ${
            r.room?.isDisabled ? "bg-white text-black hover:bg-neutral-200"
                               : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white"}`}
        >
          {togglingId === r.roomId ? "..." : r.room?.isDisabled ? "Restore" : "Disable"}
        </button>
      }
    />
  ))}
</ListContainer>
```

**`pending` (outbound requests)** — same container; row `avatar` = room initial, `title` = room name, `subtitle` = "Requested {date}", `badge` = the status pill (keep the existing APPROVED/REJECTED/PENDING color logic). APPROVED rows wrap in `href`; others render without a link (matching current behavior).

**`room-options-page.tsx` join-requests (admin inbound)** — same container; row `avatar` = `<Avatar userId={req.userId} name={req.name} pfpVersion={req.pfpVersion} />`, `title` = requester name, `subtitle` = "Requested {date}", `action` = the existing Approve/Reject button pair. This is where the Part 1 §1 avatar change pays off directly — the row shows a real avatar via `pfpVersion` instead of an inline base64 blob.

> The `rooms/joined` grid keeps its `RoomCard` grid layout (it is a deliberate card-grid, not a list). The Google container applies to the **stacked list** surfaces: `my-rooms`, `pending`, and the admin join-requests list.

## Notes

- **Empty / loading / error states** stay as they are (dashed-border empty panel, pulsing loader) — only the populated list becomes a grouped container.
- **Accessibility:** rows remain single focusable `Link`/`button` elements; the trailing action stops propagation so it doesn't trigger row navigation (as `my-rooms` already does).
- The primitives are shared, so any future listing (members, discovery-as-list) gets the identical treatment for free.

---

# Rollout sequencing

1. **Payload quick wins (no schema change):** drop `senderPfp` from message payloads (§2/§3), drop the `user` block from `rooms/mine`, trim discovery/`members`/tags projections. Immediate, low-risk byte reduction.
2. **Avatar storage migration (§1):** introduce `pfpKey`/`pfpVersion`, avatar URL/endpoint, dual-write, backfill, then remove inline `pfp`. Unblocks the biggest savings and Part 4 avatars.
3. **RPC layer (Part 3):** land `src/lib/rpc/*` with delegating re-exports; migrate call sites file-by-file; delete dead wrappers; collapse the `USE_GLOBAL_SOCKET` branch.
4. **WS migrations (Part 2):** unread push → presence stream → role/join-requested broadcasts → retire `/messages/resume`. Each reuses the `/internal/*` + `rpc.on` pattern.
5. **Listing restyle (Part 4):** ship `ListContainer`/`ListRow`/`Avatar`, convert `my-rooms`, `pending`, and the admin join-requests list.

Steps 1, 3, and 5 are independent and can proceed in parallel; step 2 precedes the full avatar savings; step 4 layers on the `/internal/*` fan-out already in place.

---

## Appendix — payload offenders, ranked

1. **`GET …/messages` (+`/around`,`/resume`)** — `senderPfp` base64 duplicated per message. *Fix: §2 + §1.*
2. **`GET …/members`** — full roster, no pagination, `pfp` + `publicKey` per row. *Fix: §3 + pagination + presence to WS.*
3. **`GET /rooms/mine`** — no pagination, full membership + repeated self-avatar per row. *Fix: §3, drop `user`.*
4. **`GET …/join-requests`** — no pagination, `pfp` + `email` per requester. *Fix: §3 (keep `publicKey`).*
5. **`GET /api/rooms` discovery** — full room docs incl. `roomLink` invite secret. *Fix: §3, never emit `roomLink`.*
6. **`GET /me/keys`** — two ≤128 KB envelopes (acceptable; never embed in a list).
7. **`GET /tags/popular` & `/trending`** — full `tag_stats` incl. 30-element `dailyCounts`. *Fix: project `{tag,count}`.*
8. **`GET …/my-key-distribution` & `/key-versions`** — unbounded arrays. *Fix: pagination + `?sinceVersion` delta.*

Root cause of #1–#4 is a single decision — storing `pfp` as an inline ≤1 MB base64 data-URL and fanning it out through `enrichMembershipUsers`/message enrichment. Part 1 §1 addresses it at the source.
