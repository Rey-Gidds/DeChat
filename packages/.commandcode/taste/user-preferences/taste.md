# User Preferences
- Treats caches as purely a performance optimization — they must never become the source of truth. Confidence: 0.9
- Prefers optimistic / local‑first UI rendering: show cached data instantly, then reconcile in the background. Confidence: 0.85
- Prefers WebSocket RPC over HTTP for data‑synchronization operations (leverage the existing global connection). Confidence: 0.8
- Favours delta / incremental sync strategies — only send what changed rather than refetching everything. Confidence: 0.8
- Prefers lazy resource warming: do not eagerly load per‑room data on startup; warm only when the user explicitly opens a room. Confidence: 0.8
- Prefers plan‑first development; plans should live as `.md` files in a `docs` folder. Confidence: 0.85
- Requires explicit user approval before implementing any plan — never start coding from a plan without the user's explicit call to proceed. Confidence: 0.9
- Open to being asked clarifying questions during the design / planning phase. Confidence: 0.7
