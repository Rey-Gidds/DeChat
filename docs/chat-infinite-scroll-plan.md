# Plan: Chat Infinite Scroll, Highlight, & Message Behavior

## Overview

6 changes to the chat system:
1. Infinite scroll both directions via IntersectionObserver
2. `joinedAt` enforcement on quote clicks
3. Better highlight color (works on all message types)
4. Send-always-scroll-bottom / receive-never-auto-scroll behavior
5. Mobile gesture review (already solid - no changes)
6. Server-side `joinedAt` fix for around route

---

## Files to Change

### 1. `packages/frontend/src/lib/messages-client.ts`
- Add `reason?: string` to `MessagesAroundResponse` interface

### 2. `packages/frontend/src/app/api/rooms/[roomId]/messages/around/route.ts`
- Get `joinedAt` from membership record
- If `target.createdAt <= joinedAt`, return 200 with `{ messages: [], reason: "before_join" }`
- Add `createdAt: { $gt: joinedAt }` to older/newer query filters

### 3. `packages/frontend/src/components/chat/message-list.tsx`
- Remove "Load earlier messages" button
- Add top and bottom sentinel divs (`h-px`) with IntersectionObserver
- New props: `loadingNewer`, `hasNewer`, `onLoadNewer`
- Replace highlight styling with: `shadow-[0_0_0_1.5px_rgba(96,165,250,0.3)] transition-shadow duration-300`

### 4. `packages/frontend/src/app/rooms/[roomId]/page.tsx`
- Add `loadingNewer` state
- Create `loadNewerSentinel` callback (wraps `loadNewer` with loading guard)
- `handleQuoteClick`: check `response.reason === "before_join"` → silently return
- Socket `room_message`: `appendDecrypted([incoming], false)` (never auto-scroll on receive)
- `onSend`: after send, always scroll to bottom: `setIsAtBottom(true)`, reset cursors, `scrollToBottom("smooth")`
- Pass `loadingNewer`, `hasNewer`, `onLoadNewer` to MessageList

### 5. Mobile Gestures — No Changes
Swipe-to-reply is already solid:
- `isTouchDevice` guard, Pointer Events, 60px threshold, 50% bubble-width clamp
- CSS `transition-transform duration-200 ease-out` for spring-back
- Window-level `pointerup` catch for events outside bubble

---

## Edge Cases

| Case | Handling |
|------|----------|
| Fast scroll past sentinel | `loadingOlder`/`loadingNewer` guards prevent duplicate fetches |
| 0-height sentinel ignored by browser | Use `h-px` (1px) |
| Memory cap (500 messages) | Sentinels outside `messages.map()` survive trimming |
| Deleted quoted message | Server returns 404 → `catch` in `handleQuoteClick` shows `alert` |
| Pre-join quoted message | Server returns `reason: "before_join"` → frontend silently returns |
| Highlight on media messages | Box-shadow NOT clipped by `overflow-hidden` — works universally |

---

## Verification Checklist

1. Scroll up in chat → older messages load automatically via top sentinel
2. Click a quoted message → scroll down from jump position → newer messages load via bottom sentinel
3. Click quoted message with `createdAt <= joinedAt` → nothing happens
4. Click a deleted quoted message → alert shown
5. Send a new message → always scrolls to bottom regardless of current scroll position
6. Receive a message while scrolled up → down arrow with count, no auto-scroll
7. Receive a message while at bottom → message shows in list, no auto-scroll
8. Highlight on own message (white bg) → subtle blue ring visible
9. Highlight on received message (dark bg) → subtle blue ring visible
10. Highlight on media message → subtle blue ring visible
11. Swipe-to-reply on mobile → no regression
