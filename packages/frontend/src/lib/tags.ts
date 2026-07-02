import { ensureMongoConnected, getDb } from "./mongodb";

const COLLECTION = "tags";

const NATIVE_TAGS = [
  "gaming", "music", "art", "dev", "crypto", "study", "vibes", "anime",
  "memes", "fashion", "food", "travel", "fitness", "photography", "design",
  "movies", "tv", "books", "poetry", "tech", "ai", "mental-health", "advice",
  "chill", "late-night", "shitposting", "fan-art", "cosplay", "k-pop",
  "valorant", "minecraft", "genshin", "football", "basketball", "cricket", "f1",
  "chess", "debate", "philosophy", "science", "math", "history", "languages",
  "productivity", "freelancing", "startup", "wellness", "pets", "nature", "cars",
];

type MongoGlobal = typeof globalThis & {
  __tagsCache?: { tags: string[]; loadedAt: number };
};

const globalTags = globalThis as MongoGlobal;

const MAX_AGE_MS = 60_000; // refresh from DB every 60s

function normalize(tag: string): string {
  return tag.toLowerCase().trim();
}

/** Return the in-memory tag list, refreshing from DB if stale. */
export async function getTags(): Promise<string[]> {
  const cached = globalTags.__tagsCache;
  if (cached && Date.now() - cached.loadedAt < MAX_AGE_MS) {
    return cached.tags;
  }

  try {
    await ensureMongoConnected();
    const docs = await getDb()
      .collection(COLLECTION)
      .find({})
      .project({ _id: 0, tag: 1 })
      .toArray();

    const tags = docs.map((d: any) => d.tag as string).filter(Boolean);

    if (tags.length > 0) {
      globalTags.__tagsCache = { tags, loadedAt: Date.now() };
      return tags;
    }

    // DB empty — seed native tags
    await seedTags();
    globalTags.__tagsCache = { tags: [...NATIVE_TAGS], loadedAt: Date.now() };
    return [...NATIVE_TAGS];
  } catch {
    // Fallback to native list on error
    return [...NATIVE_TAGS];
  }
}

/** Seed the DB with native tags if they don't exist. Idempotent. */
export async function seedTags(): Promise<void> {
  try {
    await ensureMongoConnected();
    const db = getDb();

    const existing = await db
      .collection(COLLECTION)
      .find({})
      .project({ _id: 0, tag: 1 })
      .toArray();
    const existingSet = new Set(existing.map((d: any) => d.tag as string));

    const toInsert = NATIVE_TAGS
      .filter((t) => !existingSet.has(t))
      .map((tag) => ({ tag, normalized: normalize(tag), count: 0 }));

    if (toInsert.length > 0) {
      await db.collection(COLLECTION).insertMany(toInsert);
    }

    // Ensure search index
    try {
      await db.collection(COLLECTION).createIndex({ normalized: 1 }, { unique: true });
    } catch {
      // index already exists
    }
  } catch (err) {
    console.error("[tags] seed failed:", err);
  }
}

/** Search tags by query (prefix match on normalized name). */
export async function searchTags(query: string): Promise<string[]> {
  const all = await getTags();
  if (!query.trim()) return all;
  const q = normalize(query);
  return all.filter((t) => t.includes(q));
}

/** Invalidate the in-memory cache so next call reloads from DB. */
export function invalidateTagsCache(): void {
  delete globalTags.__tagsCache;
}
