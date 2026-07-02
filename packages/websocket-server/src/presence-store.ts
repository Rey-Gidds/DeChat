/**
 * PresenceStore — abstraction over room-scoped online presence.
 *
 * Current backend: InMemoryPresenceStore (process-local).
 * Future backend: RedisPresenceStore (shared / horizontal scale-out).
 *
 * Neither the websocket event handlers nor the REST API should
 * depend on a concrete implementation.
 */

export interface PresenceStore {
  /** Increment the connection count for (roomId, userId). Returns the new count. */
  connect(roomId: string, userId: string): number;

  /** Decrement the connection count. When count reaches 0 the user is removed. Returns the new count (0 if removed). */
  disconnect(roomId: string, userId: string): number;

  /** Disconnect a user from all rooms they were in. Returns the list of roomIds they were removed from. */
  disconnectAll(userId: string): string[];

  /** True when the user has at least one active connection in this room. */
  isOnline(roomId: string, userId: string): boolean;

  /** Current connection count for a user in a room (0 if absent). */
  count(roomId: string, userId: string): number;

  /** Set of user IDs with active connections in this room. */
  onlineUsers(roomId: string): Set<string>;

  /** Snapshot the whole store (for debugging / admin endpoints). */
  snapshot(): Record<string, Record<string, number>>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryPresenceStore implements PresenceStore {
  /** roomId → userId → connectionCount */
  private readonly state = new Map<string, Map<string, number>>();

  connect(roomId: string, userId: string): number {
    let room = this.state.get(roomId);
    if (!room) {
      room = new Map();
      this.state.set(roomId, room);
    }
    const next = (room.get(userId) ?? 0) + 1;
    room.set(userId, next);
    return next;
  }

  disconnect(roomId: string, userId: string): number {
    const room = this.state.get(roomId);
    if (!room) return 0;

    const prev = room.get(userId) ?? 0;
    if (prev <= 1) {
      room.delete(userId);
      if (room.size === 0) this.state.delete(roomId);
      return 0;
    }

    const next = prev - 1;
    room.set(userId, next);
    return next;
  }

  disconnectAll(userId: string): string[] {
    const affected: string[] = [];
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

  isOnline(roomId: string, userId: string): boolean {
    return (this.state.get(roomId)?.get(userId) ?? 0) > 0;
  }

  count(roomId: string, userId: string): number {
    return this.state.get(roomId)?.get(userId) ?? 0;
  }

  onlineUsers(roomId: string): Set<string> {
    return new Set(this.state.get(roomId)?.keys() ?? []);
  }

  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [roomId, room] of this.state) {
      const inner: Record<string, number> = {};
      for (const [userId, count] of room) inner[userId] = count;
      out[roomId] = inner;
    }
    return out;
  }
}
