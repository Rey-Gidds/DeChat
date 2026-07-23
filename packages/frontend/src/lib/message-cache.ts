import { DB_NAME, DB_VERSION } from "@/lib/crypto";
import type { RealtimeRoomMessage } from "./socket-client";

export const CACHE_WINDOW_SIZE = 100;
export const DELTA_LIMIT = 200;
export const MAX_CACHED_ROOMS = 100;

export interface RoomCacheMeta {
  roomId: string;
  newestCachedMessageId: string;
  newestCachedCreatedAt: string; // ISO
  oldestCachedMessageId: string;
  oldestCachedCreatedAt: string; // ISO
  messageCount: number;
  lastAccessedAt: number; // epoch ms for LRU
}

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Returns all cached messages for a given room, sorted by createdAt ASC.
 */
export async function getCachedMessages(roomId: string): Promise<RealtimeRoomMessage[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("message-cache", "readonly");
    const store = tx.objectStore("message-cache");
    const index = store.index("by-room");
    const req = index.getAll(roomId);

    req.onsuccess = () => {
      const messages = req.result as RealtimeRoomMessage[];
      // Sort in memory by createdAt ASC to be absolutely sure
      messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      resolve(messages);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Gets cache metadata for a specific room.
 */
export async function getRoomCacheMeta(roomId: string): Promise<RoomCacheMeta | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("room-cache-meta", "readonly");
    const store = tx.objectStore("room-cache-meta");
    const req = store.get(roomId);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Updates metadata for a room, updating the lastAccessedAt timestamp.
 */
async function updateCacheMeta(
  db: IDBDatabase,
  roomId: string,
  messages: RealtimeRoomMessage[]
): Promise<void> {
  if (messages.length === 0) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("room-cache-meta", "readwrite");
      const store = tx.objectStore("room-cache-meta");
      const req = store.delete(roomId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  const oldest = messages[0];
  const newest = messages[messages.length - 1];

  const meta: RoomCacheMeta = {
    roomId,
    newestCachedMessageId: newest.id,
    newestCachedCreatedAt: newest.createdAt,
    oldestCachedMessageId: oldest.id,
    oldestCachedCreatedAt: oldest.createdAt,
    messageCount: messages.length,
    lastAccessedAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction("room-cache-meta", "readwrite");
    const store = tx.objectStore("room-cache-meta");
    const req = store.put(meta);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Appends messages to the sliding window cache of a room, trimming the oldest
 * elements if it exceeds the window size.
 */
export async function appendToCache(
  roomId: string,
  messages: RealtimeRoomMessage[],
  windowSize = CACHE_WINDOW_SIZE
): Promise<void> {
  if (messages.length === 0) return;
  const db = await getDB();

  // Step 1: Put all new messages in cache
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("message-cache", "readwrite");
    const store = tx.objectStore("message-cache");
    for (const msg of messages) {
      store.put(msg);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Step 2: Get full list of cached messages for this room, sort, and trim if needed
  const cached = await getCachedMessages(roomId);
  if (cached.length > windowSize) {
    const toDeleteCount = cached.length - windowSize;
    const toDelete = cached.slice(0, toDeleteCount);
    const kept = cached.slice(toDeleteCount);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("message-cache", "readwrite");
      const store = tx.objectStore("message-cache");
      for (const msg of toDelete) {
        store.delete(msg.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await updateCacheMeta(db, roomId, kept);
  } else {
    await updateCacheMeta(db, roomId, cached);
  }
}

/**
 * Replaces the entire cache window of a room with a fresh set of messages.
 */
export async function replaceCache(
  roomId: string,
  messages: RealtimeRoomMessage[]
): Promise<void> {
  const db = await getDB();

  // Step 1: Delete all existing messages for this room
  const cached = await getCachedMessages(roomId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("message-cache", "readwrite");
    const store = tx.objectStore("message-cache");
    for (const msg of cached) {
      store.delete(msg.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Step 2: Put new messages and update meta
  if (messages.length > 0) {
    // Trim input messages immediately if they exceed CACHE_WINDOW_SIZE
    const trimmed = messages.slice(-CACHE_WINDOW_SIZE);
    
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("message-cache", "readwrite");
      const store = tx.objectStore("message-cache");
      for (const msg of trimmed) {
        store.put(msg);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await updateCacheMeta(db, roomId, trimmed);
  } else {
    await updateCacheMeta(db, roomId, []);
  }
}

/**
 * Evicts least recently accessed room caches to keep the database size bounded.
 */
export async function evictLRURooms(maxRooms = MAX_CACHED_ROOMS): Promise<void> {
  const db = await getDB();
  
  // Step 1: Fetch all room metadata records
  const allMeta: RoomCacheMeta[] = await new Promise((resolve, reject) => {
    const tx = db.transaction("room-cache-meta", "readonly");
    const store = tx.objectStore("room-cache-meta");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  if (allMeta.length <= maxRooms) return;

  // Step 2: Sort metadata by lastAccessedAt ASC (least recently accessed first)
  allMeta.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const toEvict = allMeta.slice(0, allMeta.length - maxRooms);

  for (const meta of toEvict) {
    await clearRoomCache(meta.roomId);
  }
}

/**
 * Clears all cached messages and cache metadata for a specific room.
 */
export async function clearRoomCache(roomId: string): Promise<void> {
  const db = await getDB();
  
  // Delete from message-cache
  const cached = await getCachedMessages(roomId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("message-cache", "readwrite");
    const store = tx.objectStore("message-cache");
    for (const msg of cached) {
      store.delete(msg.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Delete from room-cache-meta
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("room-cache-meta", "readwrite");
    const store = tx.objectStore("room-cache-meta");
    const req = store.delete(roomId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Removes a single message from the cache by its ID and refreshes the room's
 * cache metadata. Called when a message_deleted socket event fires so that
 * deleted messages never reappear on a future room rejoin.
 */
export async function removeFromCache(roomId: string, messageId: string): Promise<void> {
  const db = await getDB();

  // Delete the message entry
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("message-cache", "readwrite");
    const store = tx.objectStore("message-cache");
    const req = store.delete(messageId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // Refresh metadata with whatever remains
  const remaining = await getCachedMessages(roomId);
  await updateCacheMeta(db, roomId, remaining);
}

/**
 * Updates a cached message in-place (e.g., after an edit ACK).
 * Uses put() which overwrites the existing entry by id.
 */
export async function updateInCache(
  roomId: string,
  messageId: string,
  updates: Partial<RealtimeRoomMessage>
): Promise<void> {
  const db = await getDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("message-cache", "readwrite");
    const store = tx.objectStore("message-cache");
    const req = store.get(messageId);
    req.onsuccess = () => {
      const existing = req.result as RealtimeRoomMessage | undefined;
      if (existing) {
        store.put({ ...existing, ...updates });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
