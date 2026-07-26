# Fix Global Socket Event Wiring

## Root Cause Analysis

### Core Issue: React Effect Timing Race

**The room page's global socket event handlers are registered inside a `useEffect` with `[]` deps that runs Phase 4 bootstrap. React runs child effects BEFORE parent effects. So `GlobalSocketProvider` hasn't connected yet → `getGlobalSocket()` returns `null` → the `if (gsocket)` guard at line 1191 skips ALL handler registration. The polling interval at line 1041 only updates status text — it NEVER re-registers handlers.**

This single timing bug cascades to break:
- All 9 event handlers (messages, typing, presence, key rotation) — **never registered**
- `viewing_room_start` emit — **never emitted**
- Clear unread on room open — **never called**

### Bug 2: Heartbeat kill on room leave
Room page cleanup calls `stopHeartbeat()` at line 1521, which clears the shared `heartbeatInterval`. Since `GlobalSocketProvider`'s `startGlobalHeartbeat(null)` is a no-op when interval exists, the heartbeat is permanently dead after navigating away from any room.

### Bug 3: `socket.data.roomId` overwrite for global sockets
Server's `viewing_room_start` handler sets `socket.data.roomId = roomId`. For a global socket (where `roomId` starts as `undefined`), this means navigating room A → B overwrites the value. The disconnect handler only emits `viewing_room_stop` for the LAST `socket.data.roomId`, leaking presence from earlier rooms.

### Bug 4: No toast notifications
`GlobalSocketProvider` handles kick/delete events but only updates SWR — no visible feedback to user.

### Minor: `room_renamed`/`room_disabled` not listened to
Server emits these but no client code listens.

---

## Fix Plan

### 1. Extract global socket event wiring into a reactive `useEffect` (`page.tsx`)

**Current approach (broken):** Inside Phase 4 bootstrap `useEffect` with `[]` deps, calls `getGlobalSocket()` once.

**Fix:** Add `useGlobalSocket()` hook. Add a separate `useEffect` keyed on `[gsSocket, gsConnected, roomId]` that registers/unregisters all 11 event handlers.

### 2. Fix heartbeat — decouple activeRoomId from interval lifecycle (`socket-client.ts`)

Add a module-level `globalActiveRoomId` that the heartbeat reads each tick. Room page sets/clears it, Provider owns the interval lifecycle.

### 3. Fix server `socket.data.roomId` overwrite (`types.ts` + `index.ts` + `subscription-manager.ts`)

Add `viewingRoomId?: string` to `AuthedSocket.data` and use it everywhere viewing state is tracked.

### 4. Add toast notifications (sonner) for kick/delete events

---

## Files Changed

| File | Change |
|------|--------|
| `packages/frontend/src/lib/socket-client.ts` | Add `globalActiveRoomId` + `setGlobalActiveRoomId`, remove param from `startGlobalHeartbeat` |
| `packages/frontend/src/lib/global-socket-context.tsx` | Update heartbeat call signature, add toast notifications |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Remove global socket block from bootstrap effect, add reactive `useEffect` with `useGlobalSocket()`, remove heartbeat kill |
| `packages/frontend/src/app/layout.tsx` | Add `<Toaster />` |
| `packages/frontend/package.json` | Add `sonner` |
| `packages/websocket-server/src/types.ts` | Add `viewingRoomId` |
| `packages/websocket-server/src/index.ts` | Use `viewingRoomId` for viewing state |
| `packages/websocket-server/src/subscription-manager.ts` | Use `viewingRoomId` |
