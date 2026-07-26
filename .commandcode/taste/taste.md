# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# architecture
- Outbox entries must never be pre-deleted or removed optimistically — they stay in IndexedDB (PENDING/RETRYING/FAILED) until the server acknowledgement is received and processed. The only deletion paths are a successful ACK from the server or the server-broadcasted copy of your own persisted message. Confidence: 0.90
- Reply subdocument previews must persist and display correctly even after the quoted (original) message is deleted — no cascade update of `replyTo.deletedAt` on replies. Confidence: 0.85
- All room joining (including room link-based joining) must be fully request-based — never direct. This ensures encryption keys are properly delivered to the joining member during the join handshake. Confidence: 0.80
- Membership lifecycle events (join/leave/kick) and unread/notification events must be delivered via user-specific channels — not just room broadcasts — so the affected user receives immediate UI reactions (toast, redirect, list update) regardless of which page they are currently viewing. Room broadcast alone is insufficient for membership changes. Confidence: 0.75

# frontend
- Always follow the application's existing theme/style when implementing any frontend component. Confidence: 0.85
- Clear the input box (setDraft("")) immediately on send/submit, before any async operations, so the UI feels instant to the user. Confidence: 0.85
- Unread counts per room must be persisted to durable client-side storage (e.g., IndexedDB), not kept solely in-memory, so counts survive page refreshes, tab closures, and browser restarts. Confidence: 0.90
- Unread counts for a room must be cleared (reset to zero) immediately when the user opens and successfully joins that room — otherwise stale badge counts accumulate across sessions. Confidence: 0.85
- Every user-facing action must show a toast notification on both success and failure — profile changes, name updates, room created/joined/left, kick/disable events, error messages, new message counts. Nothing should succeed or fail silently. Confidence: 0.90

# workflow
- After writing a substantial new file, self-review the code for issues (duplicate logic, code smells) and rewrite/refactor immediately rather than deferring cleanup. Confidence: 0.80
- After completing a development phase, run the type-checker (`npx tsc --noEmit`) to verify no regressions before declaring the phase complete. Confidence: 0.85
- Before making any code changes — even small, targeted fixes — read all related files across the codebase to understand the full system context first. Don't jump to editing isolated files without tracing how they interconnect. Confidence: 0.85
- Use structured `todo_write` phase lists during multi-step implementation sessions: enumerate all phases upfront, then mark each as pending → in_progress → completed with descriptive `activeForm` labels as work progresses. Confidence: 0.85

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
- Info/context button must be positioned beside each message bubble (not overlapping it) and open a floating popover/dialog with action options. Confidence: 0.85
- Swipe-to-reply gestures must be mobile-only, guarded by pointer type detection — disable swipe interactions on desktop/laptop. Confidence: 0.85
- Swipe gestures must be bounded within the chat box horizontally and spring back to original position when released below threshold. Confidence: 0.80
- For mobile, implement custom long-press handlers for copy/action menus instead of relying on default browser context menu behavior, which doesn't work reliably on mobile devices. Confidence: 0.65

