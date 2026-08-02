"use strict";
// ── Unread counter manager (DB + cache) ──────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnreadCounterManager = void 0;
const mongodb_1 = require("mongodb");
const db_1 = require("./db");
class UnreadCounterManager {
    cache = new Map(); // key="${userId}:${roomId}" → count
    static makeKey(userId, roomId) {
        return `${userId}:${roomId}`;
    }
    updateCache(userId, roomId, count) {
        const key = UnreadCounterManager.makeKey(userId, roomId);
        if (count <= 0) {
            this.cache.delete(key);
        }
        else {
            this.cache.set(key, count);
        }
    }
    /** Ensure the unread_counters collection and indexes exist. */
    static async ensureIndexes() {
        const db = await (0, db_1.getDb)();
        const collections = await db.listCollections({ name: "unread_counters" }).toArray();
        if (collections.length === 0) {
            await db.createCollection("unread_counters");
        }
        await db.collection("unread_counters").createIndex({ userId: 1, roomId: 1 }, { unique: true });
        await db.collection("unread_counters").createIndex({ userId: 1 });
        await db.collection("unread_counters").createIndex({ roomId: 1 });
    }
    /** Atomically increment unread count for a user in a room. Returns new count + version. */
    async increment(userId, roomId, timestamp) {
        const db = await (0, db_1.getDb)();
        const now = new Date();
        const result = await db.collection("unread_counters").findOneAndUpdate({ userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId) }, {
            $inc: { unreadCount: 1, version: 1 },
            $set: { updatedAt: now, lastMessageTimestamp: timestamp },
            $setOnInsert: { createdAt: now },
        }, { upsert: true, returnDocument: "after" });
        if (result?.value) {
            this.updateCache(userId, roomId, result.value.unreadCount);
            return { count: result.value.unreadCount, version: result.value.version };
        }
        // Fallback: read current value
        const doc = await db.collection("unread_counters").findOne({
            userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId),
        });
        const count = doc?.unreadCount ?? 0;
        const version = doc?.version ?? 0;
        this.updateCache(userId, roomId, count);
        return { count, version };
    }
    /** Atomically reset unread count to 0 with version guard. Returns { success, actualCount, actualVersion }. */
    async resetIfVersion(userId, roomId, expectedVersion) {
        const db = await (0, db_1.getDb)();
        const now = new Date();
        const result = await db.collection("unread_counters").findOneAndUpdate({ userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId), version: expectedVersion }, { $set: { unreadCount: 0, updatedAt: now }, $inc: { version: 1 } }, { returnDocument: "after" });
        if (result?.value) {
            this.updateCache(userId, roomId, 0);
            return { success: true, actualCount: 0, actualVersion: result.value.version };
        }
        // Version mismatch — fetch current doc
        const current = await db.collection("unread_counters").findOne({
            userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId),
        });
        const actualCount = current?.unreadCount ?? 0;
        const actualVersion = current?.version ?? 0;
        return { success: false, actualCount, actualVersion };
    }
    /** Get unread count (cache-first, DB fallback). */
    async get(userId, roomId) {
        const key = UnreadCounterManager.makeKey(userId, roomId);
        const cached = this.cache.get(key);
        if (cached !== undefined)
            return cached;
        const db = await (0, db_1.getDb)();
        const doc = await db.collection("unread_counters").findOne({
            userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId),
        });
        const count = doc?.unreadCount ?? 0;
        this.updateCache(userId, roomId, count);
        return count;
    }
    /** Get all unread counters for a user. */
    async getAllForUser(userId) {
        const db = await (0, db_1.getDb)();
        const docs = await db.collection("unread_counters")
            .find({ userId: new mongodb_1.ObjectId(userId) })
            .project({ userId: 1, roomId: 1, unreadCount: 1, version: 1, updatedAt: 1, lastMessageTimestamp: 1 })
            .toArray();
        return docs.map((d) => ({
            userId: d.userId.toHexString(),
            roomId: d.roomId.toHexString(),
            unreadCount: d.unreadCount,
            version: d.version,
            updatedAt: d.updatedAt,
            lastMessageTimestamp: d.lastMessageTimestamp,
        }));
    }
    /** Delete counter for a user+room pair (on leave/kick/block). */
    async delete(userId, roomId) {
        const db = await (0, db_1.getDb)();
        await db.collection("unread_counters").deleteOne({
            userId: new mongodb_1.ObjectId(userId), roomId: new mongodb_1.ObjectId(roomId),
        });
        this.cache.delete(UnreadCounterManager.makeKey(userId, roomId));
    }
    /** Delete all counters for a room (on room deletion). */
    async deleteByRoom(roomId) {
        const db = await (0, db_1.getDb)();
        await db.collection("unread_counters").deleteMany({
            roomId: new mongodb_1.ObjectId(roomId),
        });
        // Clear matching cache entries
        for (const key of this.cache.keys()) {
            if (key.endsWith(`:${roomId}`)) {
                this.cache.delete(key);
            }
        }
    }
}
exports.UnreadCounterManager = UnreadCounterManager;
