"use strict";
/**
 * PresenceStore — abstraction over room-scoped online presence.
 *
 * Current backend: InMemoryPresenceStore (process-local).
 * Future backend: RedisPresenceStore (shared / horizontal scale-out).
 *
 * Neither the websocket event handlers nor the REST API should
 * depend on a concrete implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryPresenceStore = void 0;
const HEARTBEAT_DRIFT_MS = 60_000; // mark offline after 60s without a heartbeat
const CLEANUP_INTERVAL_MS = 30_000; // scan for stale entries every 30s
class InMemoryPresenceStore {
    /** roomId → userId → { connectionCount, lastHeartbeat } */
    state = new Map();
    /** userId → lastHeartbeat (global socket presence) */
    globalState = new Map();
    /** roomId → userId → lastHeartbeat (viewing presence) */
    viewingState = new Map();
    cleanupTimer = null;
    /** Start periodic heartbeat eviction. Call once when the server starts. */
    startCleanup(onStaleUsers) {
        if (this.cleanupTimer)
            return;
        this.cleanupTimer = setInterval(() => {
            const evicted = this.evictStale();
            for (const { roomId, userId } of evicted) {
                onStaleUsers(roomId, userId);
            }
        }, CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref)
            this.cleanupTimer.unref();
    }
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    getOrCreate(roomId, userId) {
        let room = this.state.get(roomId);
        if (!room) {
            room = new Map();
            this.state.set(roomId, room);
        }
        let entry = room.get(userId);
        if (!entry) {
            entry = { connectionCount: 0, lastHeartbeat: Date.now() };
            room.set(userId, entry);
        }
        return entry;
    }
    connect(roomId, userId) {
        const entry = this.getOrCreate(roomId, userId);
        entry.connectionCount += 1;
        entry.lastHeartbeat = Date.now();
        return entry.connectionCount;
    }
    disconnect(roomId, userId) {
        const room = this.state.get(roomId);
        if (!room)
            return 0;
        const entry = room.get(userId);
        if (!entry)
            return 0;
        entry.connectionCount -= 1;
        if (entry.connectionCount <= 0) {
            room.delete(userId);
            if (room.size === 0)
                this.state.delete(roomId);
            return 0;
        }
        return entry.connectionCount;
    }
    heartbeat(roomId, userId) {
        const room = this.state.get(roomId);
        if (!room)
            return;
        const entry = room.get(userId);
        if (!entry)
            return;
        entry.lastHeartbeat = Date.now();
    }
    globalHeartbeat(userId) {
        this.globalState.set(userId, Date.now());
    }
    disconnectAll(userId) {
        const affected = [];
        for (const [roomId, room] of this.state) {
            if (room.has(userId)) {
                room.delete(userId);
                if (room.size === 0) {
                    this.state.delete(roomId);
                }
                affected.push(roomId);
            }
        }
        return affected;
    }
    isOnline(roomId, userId) {
        const entry = this.state.get(roomId)?.get(userId);
        if (!entry || entry.connectionCount <= 0)
            return false;
        return Date.now() - entry.lastHeartbeat < HEARTBEAT_DRIFT_MS;
    }
    isGloballyOnline(userId) {
        const lastHb = this.globalState.get(userId);
        if (!lastHb)
            return false;
        return Date.now() - lastHb < HEARTBEAT_DRIFT_MS;
    }
    count(roomId, userId) {
        return this.state.get(roomId)?.get(userId)?.connectionCount ?? 0;
    }
    onlineUsers(roomId) {
        const now = Date.now();
        const room = this.state.get(roomId);
        if (!room)
            return new Set();
        const online = new Set();
        for (const [userId, entry] of room) {
            if (entry.connectionCount > 0 && now - entry.lastHeartbeat < HEARTBEAT_DRIFT_MS) {
                online.add(userId);
            }
        }
        return online;
    }
    evictStale() {
        const now = Date.now();
        const evicted = [];
        for (const [roomId, room] of this.state) {
            for (const [userId, entry] of room) {
                if (now - entry.lastHeartbeat >= HEARTBEAT_DRIFT_MS) {
                    room.delete(userId);
                    evicted.push({ roomId, userId });
                }
            }
            if (room.size === 0) {
                this.state.delete(roomId);
            }
        }
        return evicted;
    }
    snapshot() {
        const out = {};
        for (const [roomId, room] of this.state) {
            const inner = {};
            for (const [userId, entry] of room)
                inner[userId] = entry.connectionCount;
            out[roomId] = inner;
        }
        return out;
    }
    // ── Viewing presence (Phase 4) ─────────────────────────────
    viewingConnect(roomId, userId) {
        let room = this.viewingState.get(roomId);
        if (!room) {
            room = new Map();
            this.viewingState.set(roomId, room);
        }
        room.set(userId, Date.now());
    }
    viewingDisconnect(roomId, userId) {
        const room = this.viewingState.get(roomId);
        if (!room)
            return;
        room.delete(userId);
        if (room.size === 0)
            this.viewingState.delete(roomId);
    }
    viewingHeartbeat(roomId, userId) {
        const room = this.viewingState.get(roomId);
        if (!room)
            return;
        room.set(userId, Date.now());
    }
    viewingUsers(roomId) {
        const now = Date.now();
        const room = this.viewingState.get(roomId);
        if (!room)
            return new Set();
        const viewers = new Set();
        for (const [userId, lastHb] of room) {
            if (now - lastHb < HEARTBEAT_DRIFT_MS)
                viewers.add(userId);
        }
        return viewers;
    }
}
exports.InMemoryPresenceStore = InMemoryPresenceStore;
