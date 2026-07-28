# frontend
- Self-referential UI indicators (like typing status) must be filtered out for the originating user — a user should never see their own typing indicator; only other room members should see it. Confidence: 0.80
- Always follow the application's existing theme/style when implementing any frontend component. Confidence: 0.85
- Clear the input box (setDraft("")) immediately on send/submit, before any async operations, so the UI feels instant to the user. Confidence: 0.85
- Unread counts per room must be persisted to durable client-side storage (e.g., IndexedDB), not kept solely in-memory, so counts survive page refreshes, tab closures, and browser restarts. Confidence: 0.90
- Unread counts for a room must be cleared (reset to zero) immediately when the user opens and successfully joins that room — otherwise stale badge counts accumulate across sessions. Confidence: 0.85
- Every user-facing action must show a toast notification on both success and failure — profile changes, name updates, room created/joined/left, kick/disable events, error messages, new message counts. Nothing should succeed or fail silently. Confidence: 0.90
