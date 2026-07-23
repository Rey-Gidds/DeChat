/**
 * PresenceStore — abstraction over room-scoped online presence.
 *
 * Current backend: InMemoryPresenceStore (process-local).
 * Future backend: RedisPresenceStore (shared / horizontal scale-out).
 *
 * Neither the websocket event handlers nor the REST API should
 * depend on a concrete implementation.
 */

const HEARTBEAT_DRIFT_MS = 60_000; // mark offline after 60s without a heartbeat
const CLEANUP_INTERVAL_MS = 30_000; // scan for stale entries every 30s

export interface PresenceStore {
  /** Increment the connection count for (roomId, userId). Returns the new count. */
  connect(roomId: string, userId: string): number;

  /** Decrement the connection count. When count reaches 0 the user is removed. Returns the new count (0 if removed). */
  disconnect(roomId: string, userId: string): number;

  /** Disconnect a user from all rooms they were in. Returns the list of roomIds they were removed from. */
  disconnectAll(userId: string): string[];

  /** Update the heartbeat timestamp for a user in a specific room. */
  heartbeat(roomId: string, userId: string): void;

  /** True when the user has at least one active connection and heartbeat is not stale. */
  isOnline(roomId: string, userId: string): boolean;

  /** Current connection count for a user in a room (0 if absent). */
  count(roomId: string, userId: string): number;

  /** Set of user IDs with active connections in this room (filtered by heartbeat freshness). */
  onlineUsers(roomId: string): Set<string>;

  /** Snapshot the whole store (for debugging / admin endpoints). */
  snapshot(): Record<string, Record<string, number>>;

  /** Scan and evict users whose heartbeat has exceeded the drift threshold. Returns the list of {roomId, userId} that became offline. */
  evictStale(): Array<{ roomId: string; userId: string }>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface PresenceEntry {
  connectionCount: number;
  lastHeartbeat: number;
}

export class InMemoryPresenceStore implements PresenceStore {
  /** roomId → userId → { connectionCount, lastHeartbeat } */
  private readonly state = new Map<string, Map<string, PresenceEntry>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Start periodic heartbeat eviction. Call once when the server starts. */
  startCleanup(onStaleUsers: (roomId: string, userId: string) => void): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const evicted = this.evictStale();
      for (const { roomId, userId } of evicted) {
        onStaleUsers(roomId, userId);
      }
    }, CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private getOrCreate(roomId: string, userId: string): PresenceEntry {
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

  connect(roomId: string, userId: string): number {
    const entry = this.getOrCreate(roomId, userId);
    entry.connectionCount += 1;
    entry.lastHeartbeat = Date.now();
    return entry.connectionCount;
  }

  disconnect(roomId: string, userId: string): number {
    const room = this.state.get(roomId);
    if (!room) return 0;

    const entry = room.get(userId);
    if (!entry) return 0;

    entry.connectionCount -= 1;
    if (entry.connectionCount <= 0) {
      room.delete(userId);
      if (room.size === 0) this.state.delete(roomId);
      return 0;
    }

    return entry.connectionCount;
  }

  heartbeat(roomId: string, userId: string): void {
    const room = this.state.get(roomId);
    if (!room) return;
    const entry = room.get(userId);
    if (!entry) return;
    entry.lastHeartbeat = Date.now();
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
    const entry = this.state.get(roomId)?.get(userId);
    if (!entry || entry.connectionCount <= 0) return false;
    return Date.now() - entry.lastHeartbeat < HEARTBEAT_DRIFT_MS;
  }

  count(roomId: string, userId: string): number {
    return this.state.get(roomId)?.get(userId)?.connectionCount ?? 0;
  }

  onlineUsers(roomId: string): Set<string> {
    const now = Date.now();
    const room = this.state.get(roomId);
    if (!room) return new Set();
    const online = new Set<string>();
    for (const [userId, entry] of room) {
      if (entry.connectionCount > 0 && now - entry.lastHeartbeat < HEARTBEAT_DRIFT_MS) {
        online.add(userId);
      }
    }
    return online;
  }

  evictStale(): Array<{ roomId: string; userId: string }> {
    const now = Date.now();
    const evicted: Array<{ roomId: string; userId: string }> = [];
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

  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [roomId, room] of this.state) {
      const inner: Record<string, number> = {};
      for (const [userId, entry] of room) inner[userId] = entry.connectionCount;
      out[roomId] = inner;
    }
    return out;
  }
}
