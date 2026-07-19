# DeChat Architecture: Intelligent Room Reconnection & Sliding Working-Set Cache (Revision)

This revision refines the previous design by introducing a strict
separation between the persistent message cache and infinite-scroll
history.

## Core Principle

The client never stores the room history locally.

Instead it stores only a bounded **working-set** (for example the latest
200 messages). The server remains the source of truth for the complete
conversation.

There are four independent layers:

-   Server: complete message history.
-   IndexedDB: persistent working-set cache only.
-   React state: current room session (working-set + temporary history
    pages + optimistic messages).
-   Cursor pagination: on-demand history loading.

## Working-Set Cache

Each room maintains exactly one persistent cache window.

The cache is updated only by: - live websocket messages, - DELTA resume
synchronization, - REPLACE resume synchronization.

The cache is **never** updated when the user scrolls upward.

This keeps storage bounded and predictable.

## Infinite Scroll

Cursor pagination remains unchanged.

Older pages fetched through:

GET /messages/history?before=`<cursor>`{=html}

are inserted only into React state.

They are never written into IndexedDB.

When the user leaves the room those temporary history pages disappear
automatically.

When the room is reopened only the latest persistent working-set is
restored.

This intentionally prevents IndexedDB from becoming a local history
database.

## Room Opening

1.  Read working-set cache.
2.  Render immediately.
3.  Establish WebSocket in parallel.
4.  Call intelligent resume endpoint.
5.  Apply resume result.
6.  Continue with realtime websocket updates.

## Intelligent Resume

Client sends newestCachedMessageId and newestCachedCreatedAt.

Server compares them with room.latestMessageId and
room.latestMessageCreatedAt.

UP_TO_DATE: Return nothing.

DELTA: Return only the missing messages when the client's newest cached
message still belongs to the recent working-set.

REPLACE: If the gap exceeds the cache window, skip the delta completely
and simply return the latest cache window (for example 200 messages).
Replace the IndexedDB working-set with this latest window.

This bounds reconnection cost regardless of how long the user was away.

## Why Not Persist History Pages?

If every scroll operation updated IndexedDB then long browsing sessions
would slowly transform the cache into a local database.

Instead, history pages exist only for the current session and are
discarded on room exit.

The persistent cache always represents the most recent working-set
rather than arbitrary historical pages.

## LRU

Each room stores: - working-set messages - newest cursor - oldest
cursor - lastAccessedAt

IndexedDB stores only a fixed number of room caches (e.g. 100). The
least recently used room is evicted. Temporary history pages never
participate because they are not persisted.

## Architectural Invariants

1.  Server is the source of truth.
2.  IndexedDB stores only the bounded working-set.
3.  Infinite-scroll pages are memory-only.
4.  Cursor pagination is completely independent of cache management.
5.  Only websocket updates and resume synchronization modify the
    persistent cache.
6.  Room opening always begins from the cached working-set and
    synchronizes in the background.
7.  Large synchronization gaps always use REPLACE instead of downloading
    unbounded deltas.

This architecture provides instant room opening, bounded client storage,
constant reconnection cost, unchanged cursor pagination semantics, and a
clear separation of responsibilities between persistence, session state,
and history loading.
