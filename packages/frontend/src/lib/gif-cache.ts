export interface GifSearchCacheEntry {
  data: unknown;
  timestamp: number;
}

export interface GifSearchCache {
  get(key: string): Promise<GifSearchCacheEntry | null>;
  set(key: string, entry: GifSearchCacheEntry, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryGifSearchCache implements GifSearchCache {
  private store = new Map<string, GifSearchCacheEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Map<string, Promise<unknown>>();

  async get(key: string): Promise<GifSearchCacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return entry;
  }

  async set(key: string, entry: GifSearchCacheEntry, ttlMs: number): Promise<void> {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    this.store.set(key, entry);
    this.timers.set(
      key,
      setTimeout(() => {
        this.store.delete(key);
        this.timers.delete(key);
      }, ttlMs)
    );
  }

  /** Returns a promise if there's already an in-flight fetch for this key. */
  dedupInFlight<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = fetcher().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
    this.inFlight.delete(key);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.inFlight.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

const gifCache = new InMemoryGifSearchCache();
export default gifCache;

/** Check if entry is still within its TTL. If expired, evict it immediately. */
function isEntryFresh(entry: GifSearchCacheEntry, ttlMs: number): boolean {
  const age = Date.now() - entry.timestamp;
  return age < ttlMs;
}

export function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

function getGiphyApiKey(): string {
  const key = process.env.GIPHY_API_KEY;
  if (!key) throw new Error("GIPHY_API_KEY is not configured");
  return key;
}

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

export interface GifResult {
  id: string;
  title: string;
  previewUrl: string;
  gifUrl: string;
  fallbackUrl: string;
  width: number;
  height: number;
  size: number;
}

export interface GifCategory {
  name: string;
  name_encoded: string;
  image: string;
}

function transformGiphyGif(gif: any): GifResult {
  const images = gif.images ?? {};
  const preview = images.fixed_width_small ?? images.fixed_width ?? images.downsized_small ?? {};
  const mp4 = images.original_mp4 ?? images.downsized_mp4 ?? {};
  const original = images.original ?? images.downsized ?? {};

  return {
    id: gif.id,
    title: gif.title ?? "",
    previewUrl: preview.url ?? "",
    gifUrl: mp4.mp4 ?? original.url ?? "",
    fallbackUrl: original.url ?? preview.url ?? "",
    width: Number(original.width) || 200,
    height: Number(original.height) || 200,
    size: Number(original.size) || 0,
  };
}

export async function searchGifs(
  query: string,
  offset = 0,
  limit = 20
): Promise<{ results: GifResult[]; next: string | null }> {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return { results: [], next: null };
  const cacheKey = `search:${normalized}:${offset}`;

  const cached = await gifCache.get(cacheKey);
  if (cached && isEntryFresh(cached, 3_600_000)) {
    return cached.data as { results: GifResult[]; next: string | null };
  }

  return gifCache.dedupInFlight(cacheKey, async () => {
    const apiKey = getGiphyApiKey();
    const url = `${GIPHY_BASE}/search?api_key=${apiKey}&q=${encodeURIComponent(normalized)}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(`Giphy API error: ${res.status}`);
    }

    const json = await res.json();
    const results = (json.data ?? []).map(transformGiphyGif);
    const totalCount = json.pagination?.total_count ?? 0;
    const next = offset + limit < totalCount ? String(offset + limit) : null;

    const result = { results, next };
    await gifCache.set(cacheKey, { data: result, timestamp: Date.now() }, 3_600_000);

    return result;
  });
}

export async function trendingGifs(
  offset = 0,
  limit = 20
): Promise<{ results: GifResult[]; next: string | null }> {
  const cacheKey = `trending:${offset}`;

  const cached = await gifCache.get(cacheKey);
  if (cached && isEntryFresh(cached, 900_000)) {
    return cached.data as { results: GifResult[]; next: string | null };
  }

  return gifCache.dedupInFlight(cacheKey, async () => {
    const apiKey = getGiphyApiKey();
    const url = `${GIPHY_BASE}/trending?api_key=${apiKey}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(`Giphy API error: ${res.status}`);
    }

    const json = await res.json();
    const results = (json.data ?? []).map(transformGiphyGif);
    const totalCount = json.pagination?.total_count ?? 0;
    const next = offset + limit < totalCount ? String(offset + limit) : null;

    const result = { results, next };
    await gifCache.set(cacheKey, { data: result, timestamp: Date.now() }, 900_000);

    return result;
  });
}

export async function fetchCategories(): Promise<GifCategory[]> {
  const cacheKey = "categories";

  const cached = await gifCache.get(cacheKey);
  if (cached && isEntryFresh(cached, 86_400_000)) {
    return cached.data as GifCategory[];
  }

  return gifCache.dedupInFlight(cacheKey, async () => {
    const apiKey = getGiphyApiKey();
    const url = `${GIPHY_BASE}/categories?api_key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) throw new Error("RATE_LIMITED");
      throw new Error(`Giphy API error: ${res.status}`);
    }

    const json = await res.json();
    const categories: GifCategory[] = (json.data ?? []).map((cat: any) => ({
      name: cat.name,
      name_encoded: cat.name_encoded,
      image: cat.gif?.images?.fixed_width_small?.url ?? cat.gif?.images?.original?.url ?? "",
    }));

    await gifCache.set(cacheKey, { data: categories, timestamp: Date.now() }, 86_400_000);

    return categories;
  });
}
