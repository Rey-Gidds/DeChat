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

async function writeUnread(roomId: string, count: number, latestMessageTimeStamp?: number): Promise<void> {
  const db = await getUnreadDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(UNREAD_STORE, "readwrite");
    const store = tx.objectStore(UNREAD_STORE);
    if (count <= 0) {
      const req = store.delete(roomId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } else {
      const req = store.put({ roomId, count, latestMessageTimeStamp: latestMessageTimeStamp ?? Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }
  });
}

interface UnreadState {
  counts: Record<string, number>;
  timestamps: Record<string, number>;
  increment: (roomId: string, timestamp?: number) => Promise<void>;
  clear: (roomId: string) => Promise<void>;
  set: (roomId: string, count: number, timestamp?: number) => Promise<void>;
  loadFromDB: () => Promise<void>;
}

export function formatUnreadBadge(count: number): string {
  if (count >= 101) return "100+";
  return count.toString();
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  counts: {},
  timestamps: {},

  increment: async (roomId: string, timestamp?: number) => {
    const current = get().counts[roomId] ?? 0;
    const ts = timestamp ?? Date.now();
    // Cap at 101 so max stored in IndexedDB is 101 (displayed as 100+)
    const next = Math.min(current + 1, 101);
    await writeUnread(roomId, next, ts);
    set((s) => ({
      counts: { ...s.counts, [roomId]: next },
      timestamps: { ...s.timestamps, [roomId]: ts },
    }));
  },

  clear: async (roomId: string) => {
    await writeUnread(roomId, 0);
    set((s) => {
      const nextCounts = { ...s.counts };
      delete nextCounts[roomId];
      const nextTimestamps = { ...s.timestamps };
      delete nextTimestamps[roomId];
      return { counts: nextCounts, timestamps: nextTimestamps };
    });
  },

  set: async (roomId: string, count: number, timestamp?: number) => {
    // Cap at 101 so max stored in IndexedDB is 101 (displayed as 100+)
    const boundedCount = count <= 0 ? 0 : Math.min(count, 101);
    const ts = timestamp ?? Date.now();
    await writeUnread(roomId, boundedCount, ts);
    if (boundedCount <= 0) {
      set((s) => {
        const nextCounts = { ...s.counts };
        delete nextCounts[roomId];
        const nextTimestamps = { ...s.timestamps };
        delete nextTimestamps[roomId];
        return { counts: nextCounts, timestamps: nextTimestamps };
      });
    } else {
      set((s) => ({
        counts: { ...s.counts, [roomId]: boundedCount },
        timestamps: { ...s.timestamps, [roomId]: ts },
      }));
    }
  },

  loadFromDB: async () => {
    const db = await getUnreadDB();
    const entries: { roomId: string; count: number; latestMessageTimeStamp?: number }[] = await new Promise(
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
    for (const e of entries) {
      if (e.count > 0) {
        counts[e.roomId] = Math.min(e.count, 101);
        if (e.latestMessageTimeStamp) {
          timestamps[e.roomId] = e.latestMessageTimeStamp;
        }
      }
    }
    set({ counts, timestamps });
  },
}));

