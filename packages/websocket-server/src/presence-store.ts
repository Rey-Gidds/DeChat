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

  /** Update global heartbeat timestamp for a user (always-online signal). */
  globalHeartbeat(userId: string): void;

  /** True when the user has at least one active connection and heartbeat is not stale. */
  isOnline(roomId: string, userId: string): boolean;

  /** True when the user has at least one global connection. */
  isGloballyOnline(userId: string): boolean;

  /** Current connection count for a user in a room (0 if absent). */
  count(roomId: string, userId: string): number;

  /** Set of user IDs with active connections in this room (filtered by heartbeat freshness). */
  onlineUsers(roomId: string): Set<string>;

  /** Snapshot the whole store (for debugging / admin endpoints). */
  snapshot(): Record<string, Record<string, number>>;

  /** Scan and evict users whose heartbeat has exceeded the drift threshold. Returns the list of {roomId, userId} that became offline. */
  evictStale(): Array<{ roomId: string; userId: string }>;

  // ── Viewing presence (Phase 4) ─────────────────────────────

  /** Mark a user as actively viewing a room (room page open). */
  viewingConnect(roomId: string, userId: string): void;

  /** Mark a user as no longer viewing a room (navigated away). */
  viewingDisconnect(roomId: string, userId: string): void;

  /** Refresh the viewing heartbeat for a user in a room. */
  viewingHeartbeat(roomId: string, userId: string): void;

  /** Set of userIds actively viewing this room. */
  viewingUsers(roomId: string): Set<string>;
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
  /** userId → lastHeartbeat (global socket presence) */
  private readonly globalState = new Map<string, number>();
  /** roomId → userId → lastHeartbeat (viewing presence) */
  private readonly viewingState = new Map<string, Map<string, number>>();
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

  globalHeartbeat(userId: string): void {
    this.globalState.set(userId, Date.now());
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

  isGloballyOnline(userId: string): boolean {
    const lastHb = this.globalState.get(userId);
    if (!lastHb) return false;
    return Date.now() - lastHb < HEARTBEAT_DRIFT_MS;
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

  // ── Viewing presence (Phase 4) ─────────────────────────────

  viewingConnect(roomId: string, userId: string): void {
    let room = this.viewingState.get(roomId);
    if (!room) {
      room = new Map();
      this.viewingState.set(roomId, room);
    }
    room.set(userId, Date.now());
  }

  viewingDisconnect(roomId: string, userId: string): void {
    const room = this.viewingState.get(roomId);
    if (!room) return;
    room.delete(userId);
    if (room.size === 0) this.viewingState.delete(roomId);
  }

  viewingHeartbeat(roomId: string, userId: string): void {
    const room = this.viewingState.get(roomId);
    if (!room) return;
    room.set(userId, Date.now());
  }

  viewingUsers(roomId: string): Set<string> {
    const now = Date.now();
    const room = this.viewingState.get(roomId);
    if (!room) return new Set();
    const viewers = new Set<string>();
    for (const [userId, lastHb] of room) {
      if (now - lastHb < HEARTBEAT_DRIFT_MS) viewers.add(userId);
    }
    return viewers;
  }
}
