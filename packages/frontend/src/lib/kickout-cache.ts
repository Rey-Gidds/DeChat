import { ObjectId } from "mongodb";

export const MAX_KICKOUTS = 3;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

type CacheEntry = {
  count: number;
  timestamp: number;
  pinned: boolean;
};

const kickoutCache = new Map<string, CacheEntry>();

function getTtlMs(): number {
  const env = process.env.KICKOUT_CACHE_TTL_MS;
  if (!env) return DEFAULT_TTL_MS;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function toIdString(id: ObjectId | string): string {
  return typeof id === "string" ? id : id.toString();
}

/** Composite key: one kickout count per user per room. */
export function cacheKey(
  userId: ObjectId | string,
  roomId: ObjectId | string
): string {
  return `${toIdString(userId)}:${toIdString(roomId)}`;
}

function userKeyPrefix(userId: ObjectId | string): string {
  return `${toIdString(userId)}:`;
}

function evictStaleEntries(now: number): void {
  if (kickoutCache.size <= MAX_CACHE_ENTRIES) return;

  for (const [key, entry] of kickoutCache.entries()) {
    if (entry.pinned) continue;
    if (now - entry.timestamp > getTtlMs()) {
      kickoutCache.delete(key);
    }
  }

  if (kickoutCache.size > MAX_CACHE_ENTRIES) {
    const sorted = [...kickoutCache.entries()]
      .filter(([, e]) => !e.pinned)
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, kickoutCache.size - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) {
      kickoutCache.delete(key);
    }
  }
}

function isFresh(entry: CacheEntry, now: number): boolean {
  if (entry.pinned) return true;
  return now - entry.timestamp < getTtlMs();
}

export function setRoomKickoutCount(
  userId: ObjectId | string,
  roomId: ObjectId | string,
  count: number
): void {
  const key = cacheKey(userId, roomId);
  kickoutCache.set(key, {
    count,
    timestamp: Date.now(),
    pinned: count >= MAX_KICKOUTS,
  });
}

export function invalidateKickoutCache(
  userId: ObjectId | string,
  roomId: ObjectId | string
): void {
  kickoutCache.delete(cacheKey(userId, roomId));
}

/** Remove all cached kickout entries for a user across every room. */
export function invalidateUserKickoutCache(userId: ObjectId | string): void {
  const prefix = userKeyPrefix(userId);
  for (const key of kickoutCache.keys()) {
    if (key.startsWith(prefix)) {
      kickoutCache.delete(key);
    }
  }
}

export function incrementKickoutCache(
  userId: ObjectId | string,
  roomId: ObjectId | string,
  delta: number
): number {
  const key = cacheKey(userId, roomId);
  const now = Date.now();
  const existing = kickoutCache.get(key);

  const nextCount = (existing?.count ?? 0) + delta;
  kickoutCache.set(key, {
    count: nextCount,
    timestamp: now,
    pinned: nextCount >= MAX_KICKOUTS,
  });
  return nextCount;
}

export async function getCachedRoomKickoutCount(
  userId: ObjectId,
  roomId: ObjectId,
  fetchFromDb: () => Promise<number>
): Promise<number> {
  const key = cacheKey(userId, roomId);
  const now = Date.now();
  const cached = kickoutCache.get(key);

  if (cached && isFresh(cached, now)) {
    return cached.count;
  }

  evictStaleEntries(now);

  const count = await fetchFromDb();
  setRoomKickoutCount(userId, roomId, count);
  return count;
}
