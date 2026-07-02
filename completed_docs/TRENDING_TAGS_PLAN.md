# Plan: Trending & Most Used Tags System (v2 — Simplified)

## Goal

Introduce a weighted-decay trending system and a most-used system for room tags. No `tag_daily_stats` collection. No real-time DB writes on room creation. Instead, an in-memory buffer accumulates tag usage, flushed to `tag_stats` once daily via a bulk write, followed by a trending score recomputation.

---

## Architecture Overview

```
Room Creation
  │
  └─► inMemoryTagBuffer.inc(tag)  ← O(1), no DB write
        │
        └─ stored on globalThis (process-local Map)


Daily Batch Job (GET /api/tags/aggregate)
  │
  1. Read in-memory buffer → Map<tag, count>
  2. For each tag in buffer:
     - $inc totalCount by buffer[tag]
     - $push dailyCounts[0] with buffer[tag], $slice: 30
  3. Clear buffer
  4. Read all tag_stats docs
  5. For each: compute last7DaysCount, last30DaysCount, trendingScore
  6. Bulk update tag_stats with new windows + scores
  7. Invalidate cache


API Read Path
  │
  GET /api/tags/trending  → InMemoryTagCache → tag_stats (sorted by trendingScore DESC)
  GET /api/tags/popular   → InMemoryTagCache → tag_stats (sorted by totalCount DESC)
```

---

## Schema Changes

### Single new collection: `tag_stats`

```typescript
interface TagStatDoc {
  tag: string;
  totalCount: number;              // cumulative — incremented during daily batch
  dailyCounts: number[];           // last 30 daily increments (index 0 = today). Max 30 elements.
  last7DaysCount: number;          // computed during daily batch — sum of dailyCounts[0..6]
  last30DaysCount: number;         // computed during daily batch — sum of dailyCounts[0..29]
  trendingScore: number;           // computed during daily batch
  createdAt: Date;
  updatedAt: Date;
}
```

`dailyCounts` is a rolling array — each daily batch prepends today's increment and slices to 30 entries. This eliminates the need for a separate `tag_daily_stats` collection while preserving the ability to compute accurate rolling windows.

### Indexes

| Collection | Index | Type | Purpose |
|---|---|---|---|
| `tag_stats` | `{ tag: 1 }` | Unique | Upsert lookup, dedup |
| `tag_stats` | `{ trendingScore: -1 }` | Non-unique | GET /api/tags/trending |
| `tag_stats` | `{ totalCount: -1 }` | Non-unique | GET /api/tags/popular |

---

## In-Memory Buffer

```typescript
// Module-level on globalThis (following existing patterns: tags cache, session cache, kickout cache)
globalThis.__tagUsageBuffer: Map<string, number> | undefined

// Called during room creation — O(1), no DB write
function incrementTagUsage(tags: string[]): void

// Called during daily batch — returns snapshot and clears
function flushTagUsageBuffer(): Map<string, number>
```

**Caveat**: In serverless (multi-instance), the in-memory buffer is per-instance. For the initial implementation targeting a single Node process or sticky sessions, this works directly. For multi-instance deployment, the buffer can be swapped to Redis behind the same abstraction pattern as `TagCache`.

---

## Aggregation Strategy

### Daily batch flow

```
1. Read and clear in-memory tag usage buffer
   → Map<"gaming", 12, "ai", 8, "music", 3>

2. Bulk write — for each tag in buffer:
   db.collection("tag_stats").updateOne(
     { tag },
     {
       $inc: { totalCount: bufferCount },
       $push: {
         dailyCounts: {
           $each: [bufferCount],
           $position: 0,     // prepend (index 0 = today)
           $slice: 30        // keep only last 30 entries
         }
       },
       $setOnInsert: { tag, createdAt: now }
     },
     { upsert: true }
   )

3. After all flush writes complete, read all tag_stats docs

4. For each tag, compute:
   dailyCopies = tag.dailyCounts  // [today, day-1, day-2, ..., day-29]
   last7DaysCount = sum(dailyCopies[0..6])
   last30DaysCount = sum(dailyCopies[0..29])
   totalCount = tag.totalCount
   trendingScore = last7DaysCount + (0.05 * last30DaysCount) + (0.01 * totalCount)

5. Bulk update all tag_stats docs with new windows + scores

6. Invalidate InMemoryTagCache
```

### Formula

```
trendingScore = last7DaysCount + (0.05 * last30DaysCount) + (0.01 * totalCount)
```

Rounded to 2 decimal places. Prevents rich-get-richer by heavily weighting the 7-day window.

### Scheduling

Same as before — `GET /api/tags/aggregate?key=...` admin endpoint:
- **Production**: External cron service (cron-job.org, Vercel Cron Jobs) — once daily
- **Local dev**: `curl http://localhost:3000/api/tags/aggregate`

---

## API Design

**`GET /api/tags/trending?limit=20`** — Tags sorted by `trendingScore DESC`

**`GET /api/tags/popular?limit=20`** — Tags sorted by `totalCount DESC`

**`GET /api/tags/aggregate?key=...`** — Admin endpoint to trigger daily batch

**`GET /api/tags?q=...`** — No change (existing autocomplete)

---

## Caching Strategy

### `TagCache` interface (unchanged from v1)

```typescript
interface TagCache {
  getTrending(): TagStatDoc[] | null;
  setTrending(tags: TagStatDoc[]): void;
  getPopular(): TagStatDoc[] | null;
  setPopular(tags: TagStatDoc[]): void;
  invalidate(): void;
}
```

### InMemoryTagCache TTL

Since trending/popular data only changes once per day (during the batch job), the cache TTL is set to **24 hours** (86,400,000 ms). The cache is also explicitly invalidated after each successful batch run. This means:
- No stale data — batch invalidates on completion
- Safety net — 24hr TTL handles edge case where batch fails to run
- Near-zero DB reads for trending/popular endpoints

Configurable via `TAG_CACHE_TTL_MS` env var.

---

## UI Integration

### New `TrendingTags` component

Same as v1 — fetches from `/api/tags/trending?limit=10` and `/api/tags/popular?limit=10` on mount. Renders two sections with clickable chips. Returns `null` if empty.

### Room creation (`create-room-modal.tsx`)

Add `<TrendingTags>` inside `TagSelector`, above the input, shown only when `tags.length < 5`. Chips call `add(tag)` on click.

### Room discovery (`room-discovery.tsx`)

Add `<TrendingTags>` inside `TagFilter`, above the filter input. Same pattern — chips call the local `add()` function.

---

## File Change Summary (8 files — 4 new, 4 modified)

| File | Action | Description |
|---|---|---|
| `lib/tag-stats.ts` | **NEW** | Core: TagCache interface, InMemoryTagCache, in-memory buffer, incrementTagUsage(), flushTagUsageBuffer(), runTagAggregation(), getTrendingTags(), getPopularTags() |
| `api/tags/trending/route.ts` | **NEW** | GET /api/tags/trending |
| `api/tags/popular/route.ts` | **NEW** | GET /api/tags/popular |
| `api/tags/aggregate/route.ts` | **NEW** | GET /api/tags/aggregate — admin aggregation trigger |
| `api/rooms/route.ts` | **MODIFY** | Call `incrementTagUsage()` after room creation (in-memory only, no DB) |
| `api/setup-indexes/route.ts` | **MODIFY** | Add 3 indexes for `tag_stats` |
| `components/trending-tags.tsx` | **NEW** | Shared UI: trending + popular clickable chips |
| `components/rooms/create-room-modal.tsx` | **MODIFY** | Import + render TrendingTags in TagSelector |
| `components/rooms/room-discovery.tsx` | **MODIFY** | Import + render TrendingTags in TagFilter |

---

## Edge Cases

| # | Case | Behavior |
|---|---|---|
| 1 | No tags used yet | Buffer empty, tag_stats empty, UI returns null |
| 2 | First room with tags | Buffer increments, next batch creates + populates tag_stats upserts |
| 3 | Buffer lost on server restart (dev) | Incremental counts since last batch are lost. `totalCount` temporarily underreported. Next batch corrects by only writing what's in buffer. Acceptable for trending. |
| 4 | Buffer lost on serverless cold start | Same as #3 — some daily activity may be missed. Trending still shows accurate long-term trends. |
| 5 | Batch fails before clearing buffer | Buffer preserved — next batch run picks up accumulated counts correctly |
| 6 | Batch fails after clearing buffer but before bulk write | Buffer is empty — counts for that day are lost. Mitigation: snapshot buffer before clearing |
| 7 | Multiple batch runs in one day | Buffer accumulates ~12 hours of data per run. `dailyCounts` gets two prepend entries for the same day, causing slight overcount in rolling windows. Acceptable — trending is approximate by design. |
| 8 | `dailyCounts` grows beyond 30 | `$slice: 30` in the `$push` operation auto-trims — always max 30 entries |
