# DeChat — Project Context

## Stack
- **Frontend**: Next.js 15 (App Router), Tailwind, `better-auth` (auth), Socket.IO Client
- **WebSocket server**: Express + Socket.IO 4.8, standalone on `:3001`
- **DB**: MongoDB Atlas (official `mongodb` driver v6, no Mongoose)
- **Crypto**: Web Crypto API (RSA-OAEP 2048 key wrap, AES-256-GCM messages)
- **Monorepo**: npm workspaces (`packages/frontend`, `packages/websocket-server`)

## Directory Structure

```
.
├── packages/
│   ├── frontend/          ← Next.js app (port 3000)
│   │   └── src/
│   │       ├── app/api/   ← REST route handlers
│   │       │   ├── auth/[...all]/route.ts    — Better Auth endpoints
│   │       │   ├── me/route.ts                — current user profile
│   │       │   ├── rooms/
│   │       │   │   ├── route.ts               — GET (discover), POST (create)
│   │       │   │   ├── join/route.ts           — join by roomLink
│   │       │   │   ├── mine/route.ts           — user's memberships
│   │       │   │   ├── requests/route.ts       — user's pending requests
│   │       │   │   └── [roomId]/
│   │       │   │       ├── route.ts            — GET room metadata
│   │       │   │       ├── members/route.ts    — GET member list
│   │       │   │       ├── membership/route.ts — GET/PATCH membership
│   │       │   │       ├── join/route.ts       — join by roomId
│   │       │   │       ├── join-requests/route.ts           — admin: list pending
│   │       │   │       ├── join-requests/[userId]/route.ts  — POST approve, DELETE reject
│   │       │   │       ├── messages/route.ts   — GET paginated history
│   │       │   │       └── disable/route.ts    — PATCH toggle disabled
│   │       │   ├── ws/
│   │       │   │   ├── ticket/route.ts         — room-scoped WS ticket
│   │       │   │   └── user-ticket/route.ts    — user-scoped WS ticket
│   │       │   └── setup-indexes/route.ts      — create MongoDB indexes
│   │       ├── components/
│   │       │   ├── ui/      ← shadcn-style primitives
│   │       │   └── chat/
│   │       │       ├── room-header.tsx         ← RoomHeader + MembersPanel
│   │       │       ├── message-list.tsx        ← MessageList + MessageBubble
│   │       │       └── chat-input.tsx          ← message input
│   │       ├── rooms/[roomId]/page.tsx         ← main room chat page
│   │       └── lib/
│   │           ├── models.ts                   ← TS interfaces (Room, RoomMembership, etc.)
│   │           ├── auth.ts                     ← better-auth instance
│   │           ├── mongodb.ts                  ← MongoClient singleton
│   │           ├── api-auth.ts                 ← requireSession() wrapper
│   │           ├── cachedSession.ts            ← cached/hot-path session lookup
│   │           ├── membership-db.ts            ← DB helpers (getMembership, isRoomAdmin, etc.)
│   │           ├── socket-client.ts            ← Socket.IO client singleton
│   │           ├── crypto.ts                   ← RSA keygen, AES encrypt/decrypt, IndexedDB
│   │           ├── room-membership-client.ts   ← client-side membership helpers
│   │           ├── messages-client.ts          ← REST message history fetching
│   │           ├── ws-ticket.ts                ← HMAC ticket creation (duplicated in ws server)
│   │           └── kickout-cache.ts            ← LRU cache for kickout counts
│   └── websocket-server/   ← standalone WS server (port 3001)
│       └── src/
│           ├── index.ts               ← Express + Socket.IO server
│           ├── db.ts                  ← MongoDB helpers (isActiveMember, persistMessage, etc.)
│           ├── ws-ticket.ts           ← HMAC ticket verification
│           ├── presence-store.ts      ← PresenceStore interface + InMemoryPresenceStore
│           └── load-env.ts            ← dotenv loader
```

## MongoDB Collections & Schemas

### `user` (managed by Better Auth + custom fields)
- `_id`, `email`, `emailVerified`, `name`, `publicKey` (JWK string), `pfp`, etc.

### `rooms`
| Field | Type | Notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `name` | string | 3-50 chars |
| `description` | string? | max 200 |
| `creatorId` | ObjectId | |
| `tags` | string[] | max 5, lowercased |
| `joinPolicy` | `PUBLIC \| APPROVAL_REQUIRED \| PRIVATE` | |
| `maxMembers` | number | default 500, max 50k |
| `memberCount` | number | atomic counter |
| `roomLink` | string | 16 hex chars, unique |
| `createdAt` | Date | |
| `isActive` | boolean | |
| `isDisabled` | boolean? | owner toggle |
| `nextUserIndex` | number? | sequential per-room `#n` |

### `room_memberships`
| Field | Type | Notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `userId` | ObjectId | |
| `roomId` | ObjectId | unique compound with userId |
| `status` | `PENDING \| APPROVED \| REJECTED \| LEFT` | |
| `joinedAt` | Date? | |
| `leftAt` | Date? | |
| `lastVisitedAt` | Date | |
| `encryptedRoomKey` | string | RSA-wrapped AES key |
| `role` | `OWNER \| ADMIN \| MEMBER` | |
| `userIndex` | number? | sequential per-room |
| `reviewedBy` | ObjectId? | admin who reviewed request |
| `reviewedAt` | Date? | |
| `isBlocked` | boolean | |
| `kickoutCount` | number | default 0, max 3 |
| `createdAt` | Date | |
| `updatedAt` | Date | |

### `room_messages`
| Field | Type | Notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `roomId` | ObjectId | |
| `senderId` | ObjectId | |
| `ciphertext` | string | AES-256-GCM |
| `iv` | string | base64 |
| `authTag` | string | base64 |
| `messageType` | `text \| image \| file` | |
| `createdAt` | Date | |

## Presence System (current)

- **No `isOnline` field in MongoDB.** Removed from `room_memberships` schema.
- `PresenceStore` interface: `connect()`, `disconnect()`, `disconnectAll()`, `isOnline()`, `onlineUsers()`.
- `InMemoryPresenceStore`: `Map<roomId, Map<userId, connectionCount>>` — multi-tab safe.
- **Connection count semantics**: increment on `join_room`, decrement on `leave_room`/`disconnect`. Only removed when count reaches 0.
- **WS events**: `PRESENCE_UPDATED` emitted to `room:{roomId}` with `{ roomId, userId, isOnline }` before socket.leave (so leaving user gets the update).
- **Members list resolution**: REST `GET /api/rooms/:roomId/members` queries `room_memberships` for membership data, then fetches `GET /internal/presence?roomId=X` from WS server (via HTTP) to get `onlineUserIds[]`. Client seeds `onlineUserIds` Set from initial API response, then maintains it via `PRESENCE_UPDATED` socket events.

## WebSocket Events

### Client → Server
| Event | Payload | Acknowledges |
|-------|---------|-------------|
| `join_room` | `{ roomId }` | `{ ok, roomId }` |
| `leave_room` | `{ roomId }` | `{ ok }` |
| `send_message` | `{ roomId, ciphertext, iv, authTag, messageType }` | `{ ok, message }` |
| `typing_start` | `{ roomId, preview? }` | `{ ok }` |
| `typing_stop` | `{ roomId }` | `{ ok }` |
| `sync_since` | `{ roomId, since, sinceId?, limit? }` | `{ ok, messages[] }` |
| `watch_room_membership` | `{ roomId }` | `{ ok }` |

### Server → Client
| Event | Payload |
|-------|---------|
| `room_message` | full message object |
| `typing_started` | `{ roomId, userId, preview }` |
| `typing_stopped` | `{ roomId, userId }` |
| `PRESENCE_UPDATED` | `{ roomId, userId, isOnline }` |
| `REQUEST_APPROVED` | `{ userId, roomId, status }` |
| `REQUEST_REJECTED` | `{ userId, roomId, status }` |
| `membership_updated` | `{ userId, roomId, status }` (other statuses) |

## Ticket Auth

- HMAC-SHA256 signed ticket: `base64url(JSON payload) + "." + base64url(signature)`
- Payload: `{ userId, roomId?, exp, type }`
- Shared secret: `INTERNAL_WS_SECRET || BETTER_AUTH_SECRET || WS_TICKET_SECRET`
- Two ticket types: room-scoped (for `connectToRoom`) and user-scoped (for `connectAsUser`)
- WS server middleware verifies on every socket connection

## Key APIs

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/ws/ticket` | create room WS ticket |
| GET | `/api/rooms/:roomId/members` | member list (enriched: name, email, image) |
| GET/POST | `/api/rooms/:roomId/join` | join room |
| GET | `/api/rooms/:roomId/messages` | cursor-paginated history `?cursor=&limit=` or `?since=&sinceId=&limit=` |
| POST | `/api/rooms/:roomId/join-requests/:userId` | approve (with `encryptedRoomKey` in body) |
| DELETE | `/api/rooms/:roomId/join-requests/:userId` | reject |
| PATCH | `/api/rooms/:roomId/disable` | toggle room disabled |
| PATCH | `/api/rooms/:roomId/membership` | upload wrapped room key |
| GET | `/internal/presence?roomId=` | WS server: query in-memory online users |
| POST | `/internal/membership-updated` | WS server: notify user of status changes |

## Auth Flow

- Better Auth handles sessions (cookie-based, cached with `SESSION_CACHE_TTL_MS=30000`)
- `requireSession()` in every API route → returns `{ session }` or `{ error }`
- Users generate RSA-OAEP keypair on signup, store `publicKey` in DB, private key in IndexedDB (non-extractable)
- Room creator generates AES-256-GCM room key, wraps it for each approved member using their public key

## Room Join Lifecycle

1. `PUBLIC`: membership created `APPROVED` immediately
2. `APPROVAL_REQUIRED`: membership created `PENDING` → admin approves via POST join-request with wrapped room key
3. `PRIVATE`: only via invite link, creates `APPROVED`
4. Capacity check: atomic `$inc: { memberCount: 1 }` with `memberCount < maxMembers` guard
5. `userIndex` allocated atomically via `$inc: { nextUserIndex: 1 }`

## Setup

- `packages/frontend/.env.local` and `packages/websocket-server/.env` for config
- Dev: `npm run dev:frontend` (port 3000) + `npm run dev:server` (port 3001)
- Frontend sends WS URL via ticket response (`data.wsUrl`)
