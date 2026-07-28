/**
 * Zustand store backed by IndexedDB for room unread counts.
 *
 * Every mutation (increment, clear, set) writes through to IndexedDB first,
 * then updates in-memory state. On app boot, GlobalSocketProvider calls
 * loadFromDB() to hydrate the store.
 */

import { create } from "zustand";
import { DB_NAME, DB_VERSION } from "@/lib/crypto";

const UNREAD_STORE = "unread-counts";

function getUnreadDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeUnread(roomId: string, count: number, latestMessageTimeStamp?: number, version?: number): Promise<void> {
  const db = await getUnreadDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(UNREAD_STORE, "readwrite");
    const store = tx.objectStore(UNREAD_STORE);
    if (count <= 0) {
      const req = store.delete(roomId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } else {
      const req = store.put({ roomId, count, latestMessageTimeStamp: latestMessageTimeStamp ?? Date.now(), version: version ?? 0 });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }
  });
}

interface UnreadState {
  counts: Record<string, number>;
  timestamps: Record<string, number>;
  versions: Record<string, number>;
  increment: (roomId: string, count: number, version: number, timestamp?: number) => Promise<void>;
  clear: (roomId: string, version?: number) => Promise<void>;
  set: (roomId: string, count: number, version?: number, timestamp?: number) => Promise<void>;
  loadFromDB: () => Promise<void>;
  syncFromServer: (entries: { roomId: string; unreadCount: number; version: number; lastMessageTimestamp: number }[]) => Promise<void>;
}

export function formatUnreadBadge(count: number): string {
  if (count >= 101) return "100+";
  return count.toString();
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  counts: {},
  timestamps: {},
  versions: {},

  increment: async (roomId: string, count: number, version: number, timestamp?: number) => {
    const ts = timestamp ?? Date.now();
    // Cap at 101 so max stored in IndexedDB is 101 (displayed as 100+)
    const boundedCount = Math.min(count, 101);
    await writeUnread(roomId, boundedCount, ts, version);
    set((s) => ({
      counts: { ...s.counts, [roomId]: boundedCount },
      timestamps: { ...s.timestamps, [roomId]: ts },
      versions: { ...s.versions, [roomId]: version },
    }));
  },

  clear: async (roomId: string, version?: number) => {
    await writeUnread(roomId, 0, undefined, version);
    set((s) => {
      const nextCounts = { ...s.counts };
      delete nextCounts[roomId];
      const nextTimestamps = { ...s.timestamps };
      delete nextTimestamps[roomId];
      const nextVersions = { ...s.versions };
      delete nextVersions[roomId];
      return { counts: nextCounts, timestamps: nextTimestamps, versions: nextVersions };
    });
  },

  set: async (roomId: string, count: number, version?: number, timestamp?: number) => {
    // Cap at 101 so max stored in IndexedDB is 101 (displayed as 100+)
    const boundedCount = count <= 0 ? 0 : Math.min(count, 101);
    const ts = timestamp ?? Date.now();
    await writeUnread(roomId, boundedCount, ts, version);
    if (boundedCount <= 0) {
      set((s) => {
        const nextCounts = { ...s.counts };
        delete nextCounts[roomId];
        const nextTimestamps = { ...s.timestamps };
        delete nextTimestamps[roomId];
        const nextVersions = { ...s.versions };
        delete nextVersions[roomId];
        return { counts: nextCounts, timestamps: nextTimestamps, versions: nextVersions };
      });
    } else {
      set((s) => ({
        counts: { ...s.counts, [roomId]: boundedCount },
        timestamps: { ...s.timestamps, [roomId]: ts },
        ...(version !== undefined ? { versions: { ...s.versions, [roomId]: version } } : {}),
      }));
    }
  },

  loadFromDB: async () => {
    const db = await getUnreadDB();
    const entries: { roomId: string; count: number; latestMessageTimeStamp?: number; version?: number }[] = await new Promise(
      (resolve, reject) => {
        const tx = db.transaction(UNREAD_STORE, "readonly");
        const store = tx.objectStore(UNREAD_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result as any[]);
        req.onerror = () => reject(req.error);
      }
    );
    const counts: Record<string, number> = {};
    const timestamps: Record<string, number> = {};
    const versions: Record<string, number> = {};
    for (const e of entries) {
      if (e.count > 0) {
        counts[e.roomId] = Math.min(e.count, 101);
        if (e.latestMessageTimeStamp) {
          timestamps[e.roomId] = e.latestMessageTimeStamp;
        }
        if (typeof e.version === "number") {
          versions[e.roomId] = e.version;
        }
      }
    }
    set({ counts, timestamps, versions });
  },

  syncFromServer: async (entries) => {
    for (const e of entries) {
      const boundedCount = Math.min(e.unreadCount, 101);
      await writeUnread(e.roomId, boundedCount, e.lastMessageTimestamp, e.version);
    }
    const localEntries = await (async () => {
      const db = await getUnreadDB();
      return new Promise<{ roomId: string }[]>((resolve, reject) => {
        const tx = db.transaction(UNREAD_STORE, "readonly");
        const store = tx.objectStore(UNREAD_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result as any[]);
        req.onerror = () => reject(req.error);
      });
    })();
    // Delete any local entries not in the server list
    const serverRoomIds = new Set(entries.map((e) => e.roomId));
    for (const local of localEntries) {
      if (!serverRoomIds.has(local.roomId)) {
        const db = await getUnreadDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(UNREAD_STORE, "readwrite");
          const store = tx.objectStore(UNREAD_STORE);
          const req = store.delete(local.roomId);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      }
    }
    // Hydrate Zustand
    await get().loadFromDB();
  },
}));

