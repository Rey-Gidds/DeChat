// ── Min-Heap + HashMap typing lease manager ──────────────────────────────────

interface HeapEntry {
  expiresAt: number;
  roomId: string;
  userId: string;
}

export class TypingLeaseManager {
  private readonly map = new Map<string, number>();  // key="roomId:userId" → expiresAt
  private readonly heap: HeapEntry[] = [];            // Min-Heap by expiresAt
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onExpire: (roomId: string, userId: string) => void;
  private readonly LEASE_DURATION_MS = 800;

  constructor(onExpire: (roomId: string, userId: string) => void) {
    this.onExpire = onExpire;
  }

  private static makeKey(roomId: string, userId: string): string {
    return `${roomId}:${userId}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Called on every typing event — renews/extends lease. Returns true if new, false if refresh. */
  refreshLease(roomId: string, userId: string): boolean {
    const key = TypingLeaseManager.makeKey(roomId, userId);
    const existed = this.map.has(key);
    const expiresAt = Date.now() + this.LEASE_DURATION_MS;

    this.map.set(key, expiresAt);
    this.heapPush({ expiresAt, roomId, userId });
    this.scheduleNext();

    return !existed; // true = new lease → broadcast typing_started
  }

  /** Called on disconnect — immediately removes and returns true if user was typing. */
  removeUser(roomId: string, userId: string): boolean {
    const key = TypingLeaseManager.makeKey(roomId, userId);
    const existed = this.map.delete(key);
    // Heap entries become stale — cleaned lazily on pop
    return existed;
  }

  /** Called when room is deleted — cleanup all typers for that room. */
  removeRoom(roomId: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(`${roomId}:`)) {
        this.map.delete(key);
      }
    }
    // Stale heap entries cleaned lazily
  }

  /** Returns list of userIds currently typing in a room. */
  getActiveTypers(roomId: string): string[] {
    const prefix = `${roomId}:`;
    const result: string[] = [];
    for (const [key] of this.map) {
      if (key.startsWith(prefix)) {
        result.push(key.slice(prefix.length));
      }
    }
    return result;
  }

  /** Clean up timer — call on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Periodic compaction — removes stale heap entries and rebuilds from active map entries. */
  compact(): void {
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

  private heapPush(entry: HeapEntry): void {
    this.heap.push(entry);
    this.heapBubbleUp(this.heap.length - 1);
  }

  private heapPop(): HeapEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const root = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.heapBubbleDown(0);
    }
    return root;
  }

  private heapPeek(): HeapEntry | undefined {
    return this.heap[0];
  }

  private heapBubbleUp(i: number): void {
    const entry = this.heap[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].expiresAt <= entry.expiresAt) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = entry;
  }

  private heapBubbleDown(i: number): void {
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
      if (smallest === i) break;
      this.heap[i] = this.heap[smallest];
      i = smallest;
    }
    this.heap[i] = entry;
  }

  // ── Timer scheduling ──────────────────────────────────────────────────

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const root = this.heapPeek();
    if (!root) return;

    const delay = Math.max(0, root.expiresAt - Date.now());
    this.timer = setTimeout(() => this.onTimerFire(), delay);
  }

  private onTimerFire(): void {
    const now = Date.now();

    // Process all expired entries
    while (this.heap.length > 0 && this.heapPeek()!.expiresAt <= now + 50) {
      const popped = this.heapPop()!;
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
