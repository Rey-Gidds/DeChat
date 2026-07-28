// ── Unread counter manager (DB + cache) ──────────────────────────────────────

import { ObjectId } from "mongodb";
import { getDb } from "./db";

export interface UnreadCounterDoc {
  userId: string;
  roomId: string;
  unreadCount: number;
  version: number;
  updatedAt: Date;
  lastMessageTimestamp: Date;
}

export class UnreadCounterManager {
  private readonly cache = new Map<string, number>(); // key="${userId}:${roomId}" → count

  private static makeKey(userId: string, roomId: string): string {
    return `${userId}:${roomId}`;
  }

  private updateCache(userId: string, roomId: string, count: number): void {
    const key = UnreadCounterManager.makeKey(userId, roomId);
    if (count <= 0) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, count);
    }
  }

  /** Ensure the unread_counters collection and indexes exist. */
  static async ensureIndexes(): Promise<void> {
    const db = await getDb();
    const collections = await db.listCollections({ name: "unread_counters" }).toArray();
    if (collections.length === 0) {
      await db.createCollection("unread_counters");
    }
    await db.collection("unread_counters").createIndex(
      { userId: 1, roomId: 1 },
      { unique: true }
    );
    await db.collection("unread_counters").createIndex({ userId: 1 });
    await db.collection("unread_counters").createIndex({ roomId: 1 });
  }

  /** Atomically increment unread count for a user in a room. Returns new count + version. */
  async increment(userId: string, roomId: string, timestamp: Date): Promise<{ count: number; version: number }> {
    const db = await getDb();
    const now = new Date();
    const result = await db.collection("unread_counters").findOneAndUpdate(
      { userId: new ObjectId(userId), roomId: new ObjectId(roomId) },
      {
        $inc: { unreadCount: 1, version: 1 },
        $set: { updatedAt: now, lastMessageTimestamp: timestamp },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: "after" }
    );
    if (result?.value) {
      this.updateCache(userId, roomId, result.value.unreadCount);
      return { count: result.value.unreadCount, version: result.value.version };
    }
    // Fallback: read current value
    const doc = await db.collection("unread_counters").findOne({
      userId: new ObjectId(userId), roomId: new ObjectId(roomId),
    });
    const count = doc?.unreadCount ?? 0;
    const version = doc?.version ?? 0;
    this.updateCache(userId, roomId, count);
    return { count, version };
  }

  /** Atomically reset unread count to 0 with version guard. Returns { success, actualCount, actualVersion }. */
  async resetIfVersion(userId: string, roomId: string, expectedVersion: number): Promise<{ success: boolean; actualCount: number; actualVersion: number }> {
    const db = await getDb();
    const now = new Date();
    const result = await db.collection("unread_counters").findOneAndUpdate(
      { userId: new ObjectId(userId), roomId: new ObjectId(roomId), version: expectedVersion },
      { $set: { unreadCount: 0, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: "after" }
    );
    if (result?.value) {
      this.updateCache(userId, roomId, 0);
      return { success: true, actualCount: 0, actualVersion: result.value.version };
    }
    // Version mismatch — fetch current doc
    const current = await db.collection("unread_counters").findOne({
      userId: new ObjectId(userId), roomId: new ObjectId(roomId),
    });
    const actualCount = current?.unreadCount ?? 0;
    const actualVersion = current?.version ?? 0;
    return { success: false, actualCount, actualVersion };
  }

  /** Get unread count (cache-first, DB fallback). */
  async get(userId: string, roomId: string): Promise<number> {
    const key = UnreadCounterManager.makeKey(userId, roomId);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const db = await getDb();
    const doc = await db.collection("unread_counters").findOne({
      userId: new ObjectId(userId), roomId: new ObjectId(roomId),
    });
    const count = doc?.unreadCount ?? 0;
    this.updateCache(userId, roomId, count);
    return count;
  }

  /** Get all unread counters for a user. */
  async getAllForUser(userId: string): Promise<UnreadCounterDoc[]> {
    const db = await getDb();
    const docs = await db.collection("unread_counters")
      .find({ userId: new ObjectId(userId) })
      .project({ userId: 1, roomId: 1, unreadCount: 1, version: 1, updatedAt: 1, lastMessageTimestamp: 1 })
      .toArray();
    return docs.map((d: any) => ({
      userId: d.userId.toHexString(),
      roomId: d.roomId.toHexString(),
      unreadCount: d.unreadCount,
      version: d.version,
      updatedAt: d.updatedAt,
      lastMessageTimestamp: d.lastMessageTimestamp,
    }));
  }

  /** Delete counter for a user+room pair (on leave/kick/block). */
  async delete(userId: string, roomId: string): Promise<void> {
    const db = await getDb();
    await db.collection("unread_counters").deleteOne({
      userId: new ObjectId(userId), roomId: new ObjectId(roomId),
    });
    this.cache.delete(UnreadCounterManager.makeKey(userId, roomId));
  }

  /** Delete all counters for a room (on room deletion). */
  async deleteByRoom(roomId: string): Promise<void> {
    const db = await getDb();
    await db.collection("unread_counters").deleteMany({
      roomId: new ObjectId(roomId),
    });
    // Clear matching cache entries
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${roomId}`)) {
        this.cache.delete(key);
      }
    }
  }
}
