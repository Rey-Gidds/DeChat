"use strict";
// ── Min-Heap + HashMap typing lease manager ──────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypingLeaseManager = void 0;
class TypingLeaseManager {
    map = new Map(); // key="roomId:userId" → expiresAt
    heap = []; // Min-Heap by expiresAt
    timer = null;
    onExpire;
    LEASE_DURATION_MS = 800;
    constructor(onExpire) {
        this.onExpire = onExpire;
    }
    static makeKey(roomId, userId) {
        return `${roomId}:${userId}`;
    }
    // ── Public API ────────────────────────────────────────────────────────────
    /** Called on every typing event — renews/extends lease. Returns true if new, false if refresh. */
    refreshLease(roomId, userId) {
        const key = TypingLeaseManager.makeKey(roomId, userId);
        const existed = this.map.has(key);
        const expiresAt = Date.now() + this.LEASE_DURATION_MS;
        this.map.set(key, expiresAt);
        this.heapPush({ expiresAt, roomId, userId });
        this.scheduleNext();
        return !existed; // true = new lease → broadcast typing_started
    }
    /** Called on disconnect — immediately removes and returns true if user was typing. */
    removeUser(roomId, userId) {
        const key = TypingLeaseManager.makeKey(roomId, userId);
        const existed = this.map.delete(key);
        // Heap entries become stale — cleaned lazily on pop
        return existed;
    }
    /** Called when room is deleted — cleanup all typers for that room. */
    removeRoom(roomId) {
        for (const key of this.map.keys()) {
            if (key.startsWith(`${roomId}:`)) {
                this.map.delete(key);
            }
        }
        // Stale heap entries cleaned lazily
    }
    /** Returns list of userIds currently typing in a room. */
    getActiveTypers(roomId) {
        const prefix = `${roomId}:`;
        const result = [];
        for (const [key] of this.map) {
            if (key.startsWith(prefix)) {
                result.push(key.slice(prefix.length));
            }
        }
        return result;
    }
    /** Clean up timer — call on server shutdown. */
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    /** Periodic compaction — removes stale heap entries and rebuilds from active map entries. */
    compact() {
        this.heap.length = 0;
        const now = Date.now();
        for (const [, expiresAt] of this.map) {
            if (expiresAt > now) {
                // Only need one entry per map-key for heap scheduling;
                // we don't have roomId/userId from map value alone, but compaction
                // is a mass rebuild — we re-insert from map entries.
            }
        }
        // Rebuild heap from active map entries
        for (const [key, expiresAt] of this.map) {
            const colonIdx = key.indexOf(":");
            const roomId = key.slice(0, colonIdx);
            const userId = key.slice(colonIdx + 1);
            this.heapPush({ expiresAt, roomId, userId });
        }
    }
    // ── Heap operations ───────────────────────────────────────────────────
    heapPush(entry) {
        this.heap.push(entry);
        this.heapBubbleUp(this.heap.length - 1);
    }
    heapPop() {
        if (this.heap.length === 0)
            return undefined;
        const root = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.heapBubbleDown(0);
        }
        return root;
    }
    heapPeek() {
        return this.heap[0];
    }
    heapBubbleUp(i) {
        const entry = this.heap[i];
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.heap[parent].expiresAt <= entry.expiresAt)
                break;
            this.heap[i] = this.heap[parent];
            i = parent;
        }
        this.heap[i] = entry;
    }
    heapBubbleDown(i) {
        const entry = this.heap[i];
        const n = this.heap.length;
        while (true) {
            let smallest = i;
            const left = (i << 1) + 1;
            const right = left + 1;
            if (left < n && this.heap[left].expiresAt < this.heap[smallest].expiresAt) {
                smallest = left;
            }
            if (right < n && this.heap[right].expiresAt < this.heap[smallest].expiresAt) {
                smallest = right;
            }
            if (smallest === i)
                break;
            this.heap[i] = this.heap[smallest];
            i = smallest;
        }
        this.heap[i] = entry;
    }
    // ── Timer scheduling ──────────────────────────────────────────────────
    scheduleNext() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const root = this.heapPeek();
        if (!root)
            return;
        const delay = Math.max(0, root.expiresAt - Date.now());
        this.timer = setTimeout(() => this.onTimerFire(), delay);
    }
    onTimerFire() {
        const now = Date.now();
        // Process all expired entries
        while (this.heap.length > 0 && this.heapPeek().expiresAt <= now + 50) {
            const popped = this.heapPop();
            const key = TypingLeaseManager.makeKey(popped.roomId, popped.userId);
            const currentExpiresAt = this.map.get(key);
            // Lazy deletion: if map entry doesn't match, this heap entry is stale
            if (currentExpiresAt === popped.expiresAt) {
                this.map.delete(key);
                this.onExpire(popped.roomId, popped.userId);
            }
            // If stale (map removed or re-written with different expiresAt) → discard
        }
        // Also expire map entries whose leases have truly lapsed (catches edge cases
        // where the heap root is later than some map entry due to stale heap buildup)
        for (const [key, expiresAt] of this.map) {
            if (expiresAt <= now) {
                const colonIdx = key.indexOf(":");
                const roomId = key.slice(0, colonIdx);
                const userId = key.slice(colonIdx + 1);
                this.map.delete(key);
                this.onExpire(roomId, userId);
            }
        }
        this.scheduleNext();
    }
}
exports.TypingLeaseManager = TypingLeaseManager;
