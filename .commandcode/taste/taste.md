# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# architecture
- Reply subdocument previews must persist and display correctly even after the quoted (original) message is deleted — no cascade update of `replyTo.deletedAt` on replies. Confidence: 0.85

# frontend
- Always follow the application's existing theme/style when implementing any frontend component. Confidence: 0.85
- Clear the input box (setDraft("")) immediately on send/submit, before any async operations, so the UI feels instant to the user. Confidence: 0.85

# websocket
- `clientMessageId` must never be broadcasted to the room; it is strictly sender-side for outbox reconciliation and optimistic UI updates. Confidence: 0.85

# ui-interactions
- Info/context button must be positioned beside each message bubble (not overlapping it) and open a floating popover/dialog with action options. Confidence: 0.85
- Swipe-to-reply gestures must be mobile-only, guarded by pointer type detection — disable swipe interactions on desktop/laptop. Confidence: 0.85
- Swipe gestures must be bounded within the chat box horizontally and spring back to original position when released below threshold. Confidence: 0.80
- For mobile, implement custom long-press handlers for copy/action menus instead of relying on default browser context menu behavior, which doesn't work reliably on mobile devices. Confidence: 0.65

