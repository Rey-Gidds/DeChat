# Fix Global Socket Events + Notification System

## Root Cause Analysis

### Core Issue: React Effect Timing Race

**The room page's global socket event handlers are registered inside a bootstrap `useEffect` with `[]` deps. React runs child effects BEFORE parent effects, so `GlobalSocketProvider` hasn't connected yet → `getGlobalSocket()` returns `null` → the `if (gsocket)` guard skips ALL handler registration. The polling interval only updates status text — it NEVER re-registers handlers.**

This breaks: all 9 event handlers, `viewing_room_start`, clear unread on open.

### Bug 2: Heartbeat kill on room leave
Room page cleanup calls `stopHeartbeat()`, killing the shared interval. Heartbeat dead after navigating away.

### Bug 3: Server `socket.data.roomId` overwrite for global sockets
Using `roomId` for viewing state on global sockets → navigating rooms leaks viewing presence.

### Bug 4: Zero user-facing notifications — no toast system

The codebase has no toast library. Every success/error goes to console or gets silently swallowed.

---

## Full Notification Audit — What Needs Toasts

### Critical (no feedback at all)

| Event | Server emit | Client handler | Gap |
|-------|-------------|----------------|-----|
| **Kicked from room** | `room_member_kicked` → `user:${userId}` | global-socket-context clears unread + revalidates | No toast, no redirect. User silently removed. |
| **Room deleted** | `room_deleted` → `user:${userId}` + `room:${roomId}` | global-socket-context clears unread + revalidates | No toast. Room vanishes silently. |
| **Room disabled** | `room_disabled` → `room:${roomId}` | **NOT HANDLED AT ALL** | No listener anywhere. Room silently becomes read-only. |
| **Room renamed** | `room_renamed` → `room:${roomId}` | **NOT HANDLED AT ALL** | Stale name shown until page refresh. |
| **Socket disconnected** | socket.io `disconnect` | `console.warn` only | User has no idea they're offline. |
| **Socket reconnection failed** | tier-2 fallback | Silent retry | User sees stale UI with no indicator. |

### Important (succeeds silently)

| Operation | Current feedback |
|-----------|-----------------|
| Profile pic uploaded | None (just SWR revalidate) |
| Profile pic removed | None |
| Name changed | None (just SWR revalidate) |
| Room created | None |
| Room join request approved | `REQUEST_APPROVED` → SWR revalidate only |
| Room join request rejected | `REQUEST_REJECTED` → SWR revalidate only |
| New message while in other room | Badge number only — no toast |
| Room settings changed | None |

### Existing (hand-rolled, should migrate)

| Place | Current approach |
|-------|-----------------|
| Edit/delete message errors | `setToast()` inline div (page.tsx) |
| Quoted message deleted | `setToast()` inline div |
| Unsupported file type | `alert()` native dialog |
| Leave room failure | `alert()` native dialog |
| Approve/reject request failure | `alert()` native dialogs (room-options-page) |
| Sign-in/sign-up errors | Red inline text |

---

## Fix Plan

### Part A: Socket Event Fixes

#### A1. Extract global socket event wiring into reactive `useEffect` (`page.tsx`)
- Import `useGlobalSocket` from `global-socket-context`
- Add `const { socket: gsSocket, connected: gsConnected } = useGlobalSocket()`
- Remove `if (USE_GLOBAL_SOCKET)` block from bootstrap `useEffect` (lines 1043-1222), keep legacy `else` path
- Add new `useEffect([gsSocket, gsConnected, roomId])` that registers all 11 handlers
- Includes `room_renamed` and `room_disabled` handlers (not previously registered)
- Run `setStatus("Connected")`, `clearUnread(roomId)`, emit `viewing_room_start`, set heartbeat roomId on enter
- Cleanup: `off()` all handlers, emit `viewing_room_stop`, clear heartbeat roomId
- **Remove `stopHeartbeat()` from cleanup** — heartbeat is now provider-owned

#### A2. Fix heartbeat (`socket-client.ts`)
- Add `let globalActiveRoomId: string | null = null` and `setGlobalActiveRoomId()`
- `startGlobalHeartbeat()` reads `globalActiveRoomId` each tick, no parameter
- `GlobalSocketProvider` calls `startGlobalHeartbeat()` (no arg)

#### A3. Fix server viewing state (`types.ts`, `index.ts`, `subscription-manager.ts`)
- Add `viewingRoomId?: string` to `AuthedSocket.data`
- Use everywhere viewing state is tracked instead of `roomId`

### Part B: Notification System

#### B1. Install `sonner` toast library
- `npm install sonner` in `packages/frontend`
- Add `<Toaster theme="dark" position="bottom-right" />` to root layout

#### B2. Add toast notifications in GlobalSocketProvider (`global-socket-context.tsx`)

```
onMemberKicked  → toast.error(`You were removed from ${roomName}`)
onRoomDeleted   → toast.error(`${roomName} has been deleted`)
onMemberLeft    → toast(`You left ${roomName}`)
```

#### B3. Add toast notifications in room page socket effect

```
room_disabled handler → toast.error("This room has been disabled")
room_renamed handler  → toast(`Room renamed to ${newName}`)  (also updates roomMeta)
```

#### B4. Migrate existing `alert()` calls to `toast.error()`

| File | Current | Replace with |
|------|---------|-------------|
| room page line 1807 | `alert("Unsupported file type")` | `toast.error("Unsupported file type. Only images and videos are allowed.")` |
| room page line 2262 | `alert("Failed to leave room")` | `toast.error("Failed to leave room")` |
| room-options-page.tsx lines 146, 161, 176, 196 | `alert(...)` | `toast.error(...)` |
| profile page | inline errors | Keep inline for validation, add `toast.success(...)` on success |

#### B5. Migrate existing `setToast` inline div to sonner

Replace all `setToast(...)` calls in page.tsx with `toast.error(...)` / `toast(...)` and remove the hand-rolled toast div.

#### B6. Add success toasts

| Operation | Toast |
|-----------|-------|
| Profile pic uploaded | `toast.success("Profile picture updated")` |
| Profile pic removed | `toast.success("Profile picture removed")` |
| Name changed | `toast.success("Name updated")` |
| Room created | `toast.success("Room created")` |
| Join request approved | `toast.success("You were approved to join ${roomName}")` |
| Leave room success | `toast.success("You left ${roomName}")` |
| Message edited | No toast needed (inline update sufficient) |
| Message sent | No toast needed |

#### B7. Add connection status toasts

| Event | Toast |
|-------|-------|
| Socket disconnected | `toast.error("Connection lost. Reconnecting...", { id: "socket-disconnect", duration: Infinity })` |
| Socket reconnected | `toast.success("Reconnected", { id: "socket-disconnect" })` |
| Socket reconnect failed | `toast("Could not reconnect. Check your internet.", { id: "socket-disconnect", duration: Infinity })` |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/frontend/src/lib/socket-client.ts` | Add `globalActiveRoomId` + `setGlobalActiveRoomId`, simplify `startGlobalHeartbeat` |
| `packages/frontend/src/lib/global-socket-context.tsx` | Update heartbeat, add member-event toasts, add connection-status toasts |
| `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Extract global socket handlers to reactive `useEffect`, migrate setToast→sonner, replace alerts→sonner |
| `packages/frontend/src/app/layout.tsx` | Add `<Toaster />` |
| `packages/frontend/src/app/profile/page.tsx` | Add success toasts for pfp/name |
| `packages/frontend/src/components/chat/room-settings.tsx` | Replace `alert()` → `toast.error()` |
| `packages/frontend/package.json` | Add `sonner` |
| `packages/websocket-server/src/types.ts` | Add `viewingRoomId` |
| `packages/websocket-server/src/index.ts` | Use `viewingRoomId` for viewing state |
| `packages/websocket-server/src/subscription-manager.ts` | Use `viewingRoomId` |

---

## Verification

1. `npx tsc --noEmit` in both packages
2. Open room in 2 tabs → typing indicator works
3. Send message → real-time delivery
4. Navigate away → heartbeat continues globally
5. In-room messages don't increment unread while viewing
6. Get kicked → toast appears + unread cleared
7. Change profile → success toast
8. Disconnect WiFi → "Connection lost" toast → reconnect → "Reconnected" toast
9. Room renamed → toast + name updates in header
10. Room disabled → toast
