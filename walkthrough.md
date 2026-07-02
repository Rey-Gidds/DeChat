# Dechat Revamp Progress Walkthrough

## Phase 1: Project Restructuring & Monorepo Configuration
- **Monorepo Setup**: Configured npm workspaces in the root `package.json` to link `@dechat/frontend` (Next.js App Router) and `@dechat/websocket-server` (dedicated Socket.IO server).
- **Aesthetic Foundations**: Initialized global styling containing a custom dark mode palette, neon glows, glassmorphic layout wrappers, and typography.
- **Initial Verification**: Run dependencies installs and verified workspaces mapping links.

## Phase 2: Authentication & User Accounts (Better Auth)
- **Database & Auth Integration**: Set up Better Auth core integration in `packages/frontend/src/lib/auth.ts` backed by `@better-auth/mongo-adapter` linked to MongoDB Atlas.
- **Identity Cryptography**: Programmed Web Cryptography hooks (`packages/frontend/src/lib/crypto.ts`) supporting client-side RSA-OAEP 2048-bit keypair generation and IndexedDB private key persistence. Added password-encrypted Recovery Kit JSON exports.
- **Signup, Login & Recovery UIs**: Built premium client interfaces for credential registration, login session starts, social Google sign-ins, and multi-device identity recovery.

## Phase 3: MongoDB Schema Setup & Room Metadata APIs
- **Core Models Configuration**: Created interfaces and Zod validator schemas for database collections (Rooms, memberships, messages) in `packages/frontend/src/lib/models.ts`. Enforced capacity limits (max 20) and message payloads.
- **Room API Route**: Added `packages/frontend/src/app/api/rooms/route.ts` with support for:
  * `POST`: Creates rooms, assigns unique invite links (`roomLink`), and registers the creator as the default Room Admin.
  * `GET`: Lists rooms utilizing database queries, case-insensitive keyword searches, tag filters, and index-optimized cursor-based pagination.
- **Database Indexes Provisioner**: Created `/api/setup-indexes` to automatically build compound sorting, unique validation, and query performance indexes (like `rooms(visibility, tags, createdAt)` and `room_messages(roomId, createdAt)`).

## Phase 4: Room Memberships & E2EE Key Exchange
- **Membership Model**: Added `status` (`pending` | `active` | `rejected` | `left`) to `room_memberships` for join-request lifecycle tracking.
- **HTTP APIs**:
  * `POST /api/rooms/:roomId/join` and `POST /api/rooms/join` (invite link) — create pending membership after capacity/kickout checks.
  * `GET /api/rooms/mine` — list the authenticated user's rooms.
  * `GET/PATCH /api/rooms/:roomId/membership` — fetch own membership; admin uploads wrapped room key.
  * `GET /api/rooms/:roomId/members` — active member list for room participants.
  * `GET /api/rooms/:roomId/join-requests` — admin lists pending requests with joiner public keys.
  * `POST/DELETE /api/rooms/:roomId/join-requests/:userId` — admin approve (with `encryptedRoomKey`) or reject.
- **Client Cryptography** (`packages/frontend/src/lib/crypto.ts`): Room AES-256-GCM key generation, RSA-OAEP wrap/unwrap, IndexedDB room-key storage, and message encrypt/decrypt helpers.
- **Client Orchestration** (`packages/frontend/src/lib/room-membership-client.ts`): `finalizeCreatorRoomKey`, `approveJoinRequest`, and `syncMemberRoomKey` wire the browser crypto flows to the APIs.

## Phase 5: WebSocket Server Setup & Authentication Handshake
- **Short-lived tickets**: `POST /api/ws/ticket` issues HMAC-signed tickets (60s TTL) only for users with active membership and a room key.
- **Socket middleware** (`packages/websocket-server`): Rejects connections without a valid ticket; binds `userId` to the socket.
- **Room channels**: `join_room` / `leave_room` verify MongoDB membership before subscribing to `room:{roomId}`.
- **Client helper** (`packages/frontend/src/lib/socket-client.ts`): Fetches a ticket and connects via Socket.IO with reconnection enabled.

## Kickout Count In-Memory Cache
- **Module** (`packages/frontend/src/lib/kickout-cache.ts`): Process-local `Map` keyed by `userId:roomId` — one entry per membership, matching how `kickoutCount` is stored in `room_memberships`.
- **Join checks** (`assertCanJoinRoom`): Per-room limit via `getRoomKickoutCount(roomId, userId)` and account-wide limit via `getUserKickoutCount(userId)` (sum across rooms, with each room row cached on DB load).
- **TTL**: 5 minutes by default (`KICKOUT_CACHE_TTL_MS` env override). Entries with `count >= 3` in a room are **pinned** until invalidation.
- **Invalidation**: `invalidateKickoutCache(userId, roomId)`, `invalidateUserKickoutCache(userId)`, and `incrementKickoutCache(userId, roomId, delta)` are exported from `membership-db.ts` for future kick/remove APIs.
- **Scaling note**: Cache is per Next.js server instance. Under horizontal scale, use Phase 8 Redis for shared kickout state across instances.

## Session Cache (API Auth)
- **Module** (`packages/frontend/src/lib/cachedSession.ts`): In-memory Map keyed by the `better-auth.session-token` cookie value.
- **Cached value**: Full Better Auth session (`user` + `session`, including `expiresAt`).
- **TTL**: `effectiveTTL = min(SESSION_CACHE_TTL_MS, session.expiresAt - now)` — default 60s (`SESSION_CACHE_TTL_MS` env).
- **Revocation safety**: On cache miss, `getCachedSession` calls `auth.api.getSession` with `disableCookieCache: true` so revoked sessions are not resurrected from Better Auth's signed cookie cache.
- **Better Auth cookieCache** (`auth.ts`): `maxAge: 5 min`, `refreshCache: false` (DB-backed setup). Speeds client/framework `getSession`; API routes use the server Map + DB on miss.
- **Invalidation**: `evictSession` on sign-out, revoke-session, change-password, and reset-password via [`auth/[...better-auth]/route.ts`](packages/frontend/src/app/auth/[...better-auth]/route.ts).
- **Usage**: All protected routes use `requireSession` from `api-auth.ts` (wraps `getCachedSession`). Optional `requireSession(req, { fresh: true })` for sensitive ops.
- **WebSocket tickets** (`ws-ticket.ts`) remain separate: 60s HMAC with `{ userId, roomId, exp }` only.
