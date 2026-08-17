# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# architecture
- Outbox entries must never be pre-deleted or removed optimistically — they stay in IndexedDB (PENDING/RETRYING/FAILED) until the server acknowledgement is received and processed. The only deletion paths are a successful ACK from the server or the server-broadcasted copy of your own persisted message. Confidence: 0.90
- Reply subdocument previews must persist and display correctly even after the quoted (original) message is deleted — no cascade update of `replyTo.deletedAt` on replies. Confidence: 0.85
- All room joining (including room link-based joining) must be fully request-based — never direct. This ensures encryption keys are properly delivered to the joining member during the join handshake. Confidence: 0.80
- Membership lifecycle events (join/leave/kick) and unread/notification events must be delivered via user-specific channels — not just room broadcasts — so the affected user receives immediate UI reactions (toast, redirect, list update) regardless of which page they are currently viewing. Room broadcast alone is insufficient for membership changes. Confidence: 0.75

# frontend
See [frontend/taste.md](frontend/taste.md)
# performance
- Is interested in caching repeated authentication/session lookups to reduce database traffic, but expects explicit TTL, cleanup, and invalidation strategies to be designed alongside the cache. Confidence: 0.80
- Cached authentication/session data must be invalidated or refreshed immediately after user-profile mutations so updated values remain consistent; it should not remain stale until the normal TTL expires. Confidence: 0.95
# data-persistence
- MongoDB collection operations (especially for counters like unread counts) must handle the case where no document exists yet — use upsert or check-then-create patterns rather than assuming the document pre-exists. API endpoints that read from these collections will otherwise silently return nothing. Confidence: 0.80

# workflow
See [workflow/taste.md](workflow/taste.md)
# websocket
- `clientMessageId` must never be broadcasted to the room; it is strictly sender-side for outbox reconciliation and optimistic UI updates. Confidence: 0.85
- Reconnection backoff (Fibonacci or similar) must be long-tailed for backgrounded apps — capped at ~10 minutes, not tens of seconds. Short caps defeat the purpose of a background reconnection strategy. Confidence: 0.80
- When the app returns to foreground (visibilitychange / online), any in-flight backoff timer must be immediately cancelled and a force reconnect issued — no waiting for the next tick. Confidence: 0.85

# coding-style
- Uses `───` box-drawing characters for section divider comments (e.g., `// ── Section Name ──────────────────────────────────`) rather than simple dashes or slashes. Confidence: 0.85
- Uses underscore separators in large numeric literals for readability, e.g., `7_000`, `45_000`, `60 * 60 * 1_000`. Confidence: 0.85
- Uses `void` prefix for fire-and-forget async function calls (e.g., `void loadFromDB()`) to signal intentional non-awaiting rather than bare calls. Confidence: 0.80

# communication
- Before starting any implementation, ask clarifying questions — even many of them. Never proceed on assumptions; always confirm ambiguous design decisions with the user first. Confidence: 0.95
- The user may explicitly gate implementation phases (e.g., "Phase N will not be performed until I explicitly ask"). Respect these boundaries strictly — do not proceed beyond a gated phase without explicit permission, even if later phases appear straightforward or logically follow. Confidence: 0.80
- When implementing from an architectural plan, read and verify the entire plan first before writing any code — never jump straight to implementation without thorough plan review. Confidence: 0.85

# documentation
- Architecture and design documentation deliverables belong in the `completed_docs/` folder as markdown files. Confidence: 0.85
- Architectural/implementation plans must be super-detailed: exhaustively enumerate all features, events, edge cases, and state transitions affected by the change. The plan should be thorough enough that implementation becomes smooth with no open questions. Confidence: 0.90
- Implementation plan files are living progress trackers: mark completed phases with dates and checkboxes directly in the plan `.md` file as work progresses, and update the file-change summary tables to reflect current status. Confidence: 0.80

# ui-interactions
See [ui-interactions/taste.md](ui-interactions/taste.md)
