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
// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------
class InMemoryPresenceStore {
    /** roomId → userId → connectionCount */
    state = new Map();
    connect(roomId, userId) {
        let room = this.state.get(roomId);
        if (!room) {
            room = new Map();
            this.state.set(roomId, room);
        }
        const next = (room.get(userId) ?? 0) + 1;
        room.set(userId, next);
        return next;
    }
    disconnect(roomId, userId) {
        const room = this.state.get(roomId);
        if (!room)
            return 0;
        const prev = room.get(userId) ?? 0;
        if (prev <= 1) {
            room.delete(userId);
            if (room.size === 0)
                this.state.delete(roomId);
            return 0;
        }
        const next = prev - 1;
        room.set(userId, next);
        return next;
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
        return (this.state.get(roomId)?.get(userId) ?? 0) > 0;
    }
    count(roomId, userId) {
        return this.state.get(roomId)?.get(userId) ?? 0;
    }
    onlineUsers(roomId) {
        return new Set(this.state.get(roomId)?.keys() ?? []);
    }
    snapshot() {
        const out = {};
        for (const [roomId, room] of this.state) {
            const inner = {};
            for (const [userId, count] of room)
                inner[userId] = count;
            out[roomId] = inner;
        }
        return out;
    }
}
exports.InMemoryPresenceStore = InMemoryPresenceStore;
