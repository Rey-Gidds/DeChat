import { ensureMongoConnected, getDb } from "./mongodb";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TagStatDoc {
  tag: string;
  totalCount: number;
  dailyCounts: number[];
  last7DaysCount: number;
  last30DaysCount: number;
  trendingScore: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Cache abstraction ──────────────────────────────────────────────────────

export interface TagCache {
  getTrending(): TagStatDoc[] | null;
  setTrending(tags: TagStatDoc[]): void;
  getPopular(): TagStatDoc[] | null;
  setPopular(tags: TagStatDoc[]): void;
  invalidate(): void;
}

export class InMemoryTagCache implements TagCache {
  private trending: { data: TagStatDoc[]; loadedAt: number } | null = null;
  private popular: { data: TagStatDoc[]; loadedAt: number } | null = null;

  constructor(private ttlMs: number = 24 * 60 * 60 * 1000) {}

  getTrending(): TagStatDoc[] | null {
    if (this.trending && Date.now() - this.trending.loadedAt < this.ttlMs) {
      return this.trending.data;
    }
    return null;
  }

  setTrending(tags: TagStatDoc[]): void {
    this.trending = { data: tags, loadedAt: Date.now() };
  }

  getPopular(): TagStatDoc[] | null {
    if (this.popular && Date.now() - this.popular.loadedAt < this.ttlMs) {
      return this.popular.data;
    }
    return null;
  }

  setPopular(tags: TagStatDoc[]): void {
    this.popular = { data: tags, loadedAt: Date.now() };
  }

  invalidate(): void {
    this.trending = null;
    this.popular = null;
  }
}

const TAG_CACHE_TTL_MS =
  parseInt(process.env.TAG_CACHE_TTL_MS || "", 10) || 24 * 60 * 60 * 1000;
const tagCache = new InMemoryTagCache(TAG_CACHE_TTL_MS);

const COLLECTION = "tag_stats";

// ── Direct DB write on room creation ───────────────────────────────────────

/**
 * Upsert tag_stats documents for every tag assigned to a newly created room.
 *
 * Uses a MongoDB aggregation pipeline update to atomically:
 * - $inc totalCount by 1
 * - Prepend today's count to `dailyCounts` (or increment the head if we already
 *   pushed for today), keeping max 30 entries
 * - Set the helper field `currentDate` (YYYY-MM-DD) so the next write on the
 *   same day knows to increment the head rather than push a new entry
 */
export async function incrementTagCounts(tags: string[]): Promise<void> {
  if (tags.length === 0) return;

  await ensureMongoConnected();
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const bulkOps = tags.map((tag) => ({
    updateOne: {
      filter: { tag },
      update: [
        {
          $set: {
            totalCount: { $add: [{ $ifNull: ["$totalCount", 0] }, 1] },
            dailyCounts: {
              $cond: {
                if: { $eq: ["$currentDate", today] },
                // Same day: increment the head of the array
                then: {
                  $let: {
                    vars: {
                      head: {
                        $add: [
                          { $ifNull: [{ $arrayElemAt: ["$dailyCounts", 0] }, 0] },
                          1,
                        ],
                      },
                      tail: {
                        $ifNull: [{ $slice: ["$dailyCounts", 1, 29] }, []],
                      },
                    },
                    in: { $concatArrays: [["$$head"], "$$tail"] },
                  },
                },
                // New day: prepend 1, keep up to 30 entries
                else: {
                  $let: {
                    vars: {
                      tail: {
                        $ifNull: [{ $slice: ["$dailyCounts", 0, 29] }, []],
                      },
                    },
                    in: { $concatArrays: [[1], "$$tail"] },
                  },
                },
              },
            },
            currentDate: today,
            updatedAt: "$$NOW",
            createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
            tag: { $ifNull: ["$tag", tag] },
          },
        },
      ],
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    await db.collection(COLLECTION).bulkWrite(bulkOps);
  }
}

// ── Scheduled aggregation ──────────────────────────────────────────────────

/**
 * Compute rolling window counts and trending scores from `dailyCounts`.
 *
 * For every tag_stats document:
 * - Sum `dailyCounts[0..6]` → last7DaysCount
 * - Sum `dailyCounts[0..29]` → last30DaysCount
 * - Compute trendingScore = last7DaysCount + 0.05*last30DaysCount + 0.01*totalCount
 *
 * Call this via GET /api/tags/aggregate once daily.
 * Cache is invalidated at the end so the next read fetches fresh data.
 */
export async function runTagAggregation(): Promise<{ updated: number }> {
  await ensureMongoConnected();
  const db = getDb();
  const now = new Date();

  const docs = await db
    .collection<TagStatDoc>(COLLECTION)
    .find({})
    .toArray();

  if (docs.length === 0) return { updated: 0 };

  const updates = docs.map((doc) => {
    const counts = doc.dailyCounts || [];
    let last7DaysCount = 0;
    let last30DaysCount = 0;

    for (let i = 0; i < Math.min(counts.length, 30); i++) {
      if (i < 7) last7DaysCount += counts[i];
      last30DaysCount += counts[i];
    }

    const rawScore =
      last7DaysCount + 0.05 * last30DaysCount + 0.01 * doc.totalCount;
    const trendingScore = Math.round(rawScore * 100) / 100;

    return {
      updateOne: {
        filter: { tag: doc.tag },
        update: {
          $set: {
            last7DaysCount,
            last30DaysCount,
            trendingScore,
            updatedAt: now,
          },
        },
      },
    };
  });

  await db.collection(COLLECTION).bulkWrite(updates);
  tagCache.invalidate();

  return { updated: updates.length };
}

// ── Read helpers (backed by cache) ─────────────────────────────────────────

export async function getTrendingTags(limit = 20): Promise<TagStatDoc[]> {
  const cached = tagCache.getTrending();
  if (cached) return cached.slice(0, limit);

  await ensureMongoConnected();
  const docs = await getDb()
    .collection<TagStatDoc>(COLLECTION)
    .find({ totalCount: { $gt: 0 } })
    .sort({ trendingScore: -1 })
    .limit(limit)
    .toArray();

  tagCache.setTrending(docs);
  return docs;
}

export async function getPopularTags(limit = 20): Promise<TagStatDoc[]> {
  const cached = tagCache.getPopular();
  if (cached) return cached.slice(0, limit);

  await ensureMongoConnected();
  const docs = await getDb()
    .collection<TagStatDoc>(COLLECTION)
    .find({ totalCount: { $gt: 0 } })
    .sort({ totalCount: -1 })
    .limit(limit)
    .toArray();

  tagCache.setPopular(docs);
  return docs;
}
