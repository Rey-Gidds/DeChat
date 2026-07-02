# GIF / Giphy Integration — Architecture & Implementation Plan

> **Status**: Draft for review  
> **Project**: DeChat — Privacy-First E2EE Messaging  
> **Date**: 2026-06-09  
> **Context**: Add GIF support via the Giphy API while preserving the existing privacy-first architecture. GIFs bypass the encrypted media pipeline entirely — they're served directly from Giphy's CDN and only their metadata is encrypted inside the existing message envelope.

---

## Table of Contents

- [1. Architecture Overview](#1-architecture-overview)
- [2. Giphy API Integration Strategy](#2-giphy-api-integration-strategy)
- [3. Caching Strategy](#3-caching-strategy)
- [4. API Design (Backend Routes)](#4-api-design-backend-routes)
- [5. WebSocket Flow](#5-websocket-flow)
- [6. Data Model Changes](#6-data-model-changes)
- [7. UI Integration Strategy](#7-ui-integration-strategy)
- [8. Performance Considerations](#8-performance-considerations)
- [9. Edge Case Analysis](#9-edge-case-analysis)
- [10. Migration Plan](#10-migration-plan)
- [11. File Change Summary](#11-file-change-summary)
- [12. Commit Breakdown](#12-commit-breakdown)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                              │
│                                                                      │
│  User opens GIF picker                                               │
│     │                                                                │
│     ▼                                                                │
│  GET /api/gifs/trending    (trending GIFs on open)                   │
│  GET /api/gifs/search?q=X (search results, debounced 400ms)          │
│  GET /api/gifs/categories  (category grid)                           │
│     │                                                                │
│     ▼                                                                │
│  User selects a GIF                                                  │
│     │                                                                │
│     ▼                                                                │
│  encryptMessage(JSON.stringify({                                     │
│    type: "gif",                                                      │
│    gifId, gifUrl, previewUrl,                                        │
│    width, height, size                                               │
│  }), roomKey)                                                        │
│     │                                                                │
│     ▼                                                                │
│  sendEncryptedMessage({ ciphertext, iv, authTag, messageType: "gif" })│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
         │ WebSocket "send_message"
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WebSocket Server (:3001)                           │
│  • Validates membership + room active state                          │
│  • Persists ciphertext/iv/authTag to MongoDB room_messages           │
│  • Broadcasts to room via "room_message"                             │
│  • NEVER stores or proxies GIF binaries                              │
└─────────────────────────────────────────────────────────────────────┘
         │ Broadcast
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Receiving Client(s)                                │
│  • Receive "room_message" event                                      │
│  • decryptMessage(payload) → JSON.parse → GifMetadata                │
│  • Render <img src={gifUrl} /> — loaded directly from Giphy CDN      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Next.js Server (:3000)                             │
│                                                                      │
│  POST /api/gifs/search  ──→  Giphy API  ──→ response cached         │
│  POST /api/gifs/trending ──→  Giphy API  ──→ response cached         │
│  POST /api/gifs/categories ─→  Giphy API  ──→ response cached       │
│                                                                      │
│  Cache: InMemoryGifSearchCache                                       │
│  ├── Search results: 1 hour TTL                                     │
│  ├── Trending results: 15-30 min TTL                                │
│  └── Categories: 24 hour TTL                                        │
│                                                                      │
│  Abstraction: GifSearchCache interface                               │
│  ├── Current: InMemoryGifSearchCache                                 │
│  └── Future: RedisGifSearchCache                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| **GIF metadata encrypted inside existing message envelope** | No new collections, no schema changes. MongoDB stores only `ciphertext`, `iv`, `authTag` — same as text messages. |
| **GIFs loaded directly from Giphy CDN** | No proxying, no re-uploading to R2. GIFs are public by nature (Giphy-hosted). The encrypted message payload just references them by URL. |
| **Server is the sole Giphy API gateway** | Giphy API key never exposed to clients. Server-side caching means one search benefits all users. No CORS issues. |
| **`messageType: "gif"` added to the existing union** | Distinguishable from text/image/video at the socket event level. The server already passes `messageType` through untouched. |
| **No GIF binaries stored anywhere server-side** | Cache stores only Giphy response metadata (JSON), never GIF files. MongoDB stores only encrypted payloads. R2 is not used for GIFs. |

---

## 2. Giphy API Integration Strategy

### 2.1 Giphy API Endpoints Used

| Giphy Endpoint | Purpose | Our API Route |
|---------------|---------|--------------|
| `GET https://api.giphy.com/v1/gifs/search?q=...&api_key=...&limit=...&offset=...` | Search GIFs by query | `GET /api/gifs/search?q=...&offset=...` |
| `GET https://api.giphy.com/v1/gifs/trending?api_key=...&limit=...&offset=...` | Trending GIFs | `GET /api/gifs/trending?offset=...` |
| `GET https://api.giphy.com/v1/gifs/categories?api_key=...` | GIF categories | `GET /api/gifs/categories` |

### 2.2 Media Format Strategy

Giphy returns multiple renditions per GIF. We request the following via the API (all renditions are included by default — we select on the client):

| Rendition | Size | Use Case |
|-----------|------|----------|
| `fixed_width_small` (or `downsized_still`) | ~50-150KB | Preview thumbnails in the picker grid |
| `original` (or `downsized`) | ~1-5MB | Full-size render in chat (fallback) |
| `original_mp4` (or `downsized_mp4`) | ~200-800KB | Optimized video render in chat (preferred) |
| `looping` | ~100-400KB | Alternative optimized format |

The client receives all renditions and picks the best one for the current context:
- **In chat bubble**: Render the `original_mp4` URL as a `<video>` element with `autoplay loop muted playsinline` for best performance
- **Fallback**: Use `original` or `downsized` GIF URL if the client doesn't support the video format
- **In picker**: Use `fixed_width_small` for grid thumbnails

### 2.3 Giphy API Response Shape (What We Cache)

```typescript
interface GiphyGifObject {
  id: string;
  title: string;
  username: string;
  rating: string;
  images: {
    fixed_width: { url: string; width: string; height: string; size: string };
    fixed_width_small: { url: string; width: string; height: string; size: string };
    original: { url: string; width: string; height: string; size: string };
    original_mp4: { url: string; width: number; height: number; mp4_size: string; mp4: string };
    downsized: { url: string; width: string; height: string; size: string };
    downsized_mp4: { url: string; width: number; height: number; mp4_size: string; mp4: string };
    looping: { mp4: string; mp4_size: string };
  };
  import_datetime: string;
  trending_datetime: string;
  user?: {
    avatar_url: string;
    display_name: string;
    username: string;
  };
}

interface GiphySearchResponse {
  data: GiphyGifObject[];
  pagination: {
    total_count: number;
    count: number;
    offset: number;
  };
  meta: {
    status: number;
    msg: string;
    response_id: string;
  };
}

interface GiphyCategoriesResponse {
  data: Array<{
    name: string;
    name_encoded: string;
    gif: GiphyGifObject;     // representative GIF for the category
    subcategories?: Array<{
      name: string;
      name_encoded: string;
    }>;
  }>;
}
```

### 2.4 Giphy API Key Management

- **Stored server-side** in `GIPHY_API_KEY` environment variable
- **Never exposed to the client** — all requests go through our backend
- **Rate limiting**: Giphy provides a free tier. Our server-side cache further reduces requests.

### 2.5 GIF Metadata in Message Payload

```typescript
// Encrypted inside the message ciphertext
interface GifMetadata {
  type: "gif";
  gifId: string;               // Giphy GIF ID
  gifUrl: string;              // Direct Giphy CDN URL (mp4 preferred)
  previewUrl: string;          // fixed_width_small URL for preview/placeholder
  width: number;
  height: number;
  size: number;                // Size in bytes (for display)
  title?: string;              // Content description from Giphy
}
```

This is serialized to JSON, encrypted with `encryptMessage()` using the room key, and sent as the `ciphertext` in a standard `send_message` event with `messageType: "gif"`.

---

## 3. Caching Strategy

### 3.1 Cache Abstraction

```typescript
// packages/frontend/src/lib/gif-cache.ts  (server-side, in Next.js API routes)

interface GifSearchCacheEntry {
  data: unknown;          // The Giphy API response JSON
  timestamp: number;      // When this entry was created
}

interface GifSearchCache {
  get(key: string): Promise<GifSearchCacheEntry | null>;
  set(key: string, entry: GifSearchCacheEntry, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

### 3.2 InMemoryGifSearchCache Implementation

```typescript
class InMemoryGifSearchCache implements GifSearchCache {
  private store = new Map<string, GifSearchCacheEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async get(key: string): Promise<GifSearchCacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    // Check TTL expiration
    const age = Date.now() - entry.timestamp;
    return age; // Will be checked by caller against TTL
    return entry;
  }

  async set(key: string, entry: GifSearchCacheEntry, ttlMs: number): Promise<void> {
    // Clear existing timer if re-setting
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    this.store.set(key, entry);
    this.timers.set(key, setTimeout(() => {
      this.store.delete(key);
      this.timers.delete(key);
    }, ttlMs));
  }

  async invalidate(key: string): Promise<void> {
    this.store.delete(key);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
```

### 3.3 Singleton Instance

The cache is a module-level singleton in the Next.js API route handler. It persists across requests within the same process (no external dependency).

```typescript
// Singleton — lives as long as the Node.js process
const gifCache: GifSearchCache = new InMemoryGifSearchCache();
```

### 3.4 TTL Strategy

| Cache Key Pattern | TTL | Rationale |
|------------------|-----|-----------|
| `search:{normalized_query}` | 1 hour | Search results are relatively stable. 1h is long enough to benefit all users, short enough to get fresh results. |
| `trending` | 15 minutes | Trending GIFs change frequently. 15min keeps it fresh while still reducing Giphy calls. Configurable. |
| `categories` | 24 hours | Categories are essentially static (changed by Giphy, not user-driven). 24h is safe. |

### 3.5 Cache Key Normalization

```typescript
function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}
```

This ensures `"cat"` and `"Cat "` share the same cache entry.

### 3.6 What We Cache

- **Only Giphy API response JSON** — the `data` array, `pagination` offset, category list
- **Never GIF binaries** — GIF files are fetched directly from Giphy CDN by the browser
- **No user-specific data** — cache is shared across all users

### 3.7 Future Redis Implementation

```typescript
class RedisGifSearchCache implements GifSearchCache {
  constructor(private redis: Redis) {}

  async get(key: string): Promise<GifSearchCacheEntry | null> {
    const raw = await this.redis.get(`gif:${key}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async set(key: string, entry: GifSearchCacheEntry, ttlMs: number): Promise<void> {
    await this.redis.setex(`gif:${key}`, Math.ceil(ttlMs / 1000), JSON.stringify(entry));
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(`gif:${key}`);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys('gif:*');
    if (keys.length > 0) await this.redis.del(...keys);
  }
}
```

---

## 4. API Design (Backend Routes)

### 4.1 `GET /api/gifs/search`

**Purpose:** Search Giphy GIFs by query string

```
GET /api/gifs/search?q=funny+cat&offset=0&limit=20

Response 200:
{
  results: Array<{
    id: string;
    title: string;
    previewUrl: string;     // fixed_width_small URL (for picker grid)
    gifUrl: string;         // original_mp4 URL (for chat render)
    fallbackUrl: string;    // original/downsized GIF URL (fallback render)
    width: number;
    height: number;
    size: number;
  }>,
  next: string | null       // cursor for next page
}
```

**Implementation steps:**
1. Check cache for `search:{normalized_query}:{pos || ''}`
2. If cached and within TTL, return cached data
3. If not cached, call Tenor `/v2/search?q=...&key=...&limit=...&pos=...&media_filter=mp4,gif,tinygif`
4. Transform response to our internal format
5. Cache transformed response with 1h TTL
6. Return response

**Validation:**
- `q` required, max 100 chars
- `pos` optional (cursor for pagination)
- `limit` optional, default 20, max 50
- Must have active session (authenticated user)

### 4.2 `GET /api/gifs/trending`

**Purpose:** Get trending GIFs (shown when picker opens)

```
GET /api/gifs/trending?offset=0&limit=20

Response 200:
{
  results: Array<GifResult>,   // same shape as search results
  next: string | null
}
```

**Implementation steps:**
1. Check cache for `trending:{offset || ''}`
2. If cached and within TTL (15min), return cached
3. If not cached, call Giphy `v1/gifs/trending?api_key=...&limit=...&offset=...`
4. Transform and cache
5. Return response

### 4.3 `GET /api/gifs/categories`

**Purpose:** Get GIF categories (for category grid in picker)

```
GET /api/gifs/categories

Response 200:
{
  categories: Array<{
    name: string;           // "Anime", "Sports", etc.
    name_encoded: string;   // search query for this category
    image: string;          // category thumbnail URL
  }>
}
```

**Implementation steps:**
1. Check cache for `categories`
2. If cached and within TTL (24h), return cached
3. If not cached, call Giphy `v1/gifs/categories?api_key=...`
4. Transform and cache
5. Return response

### 4.4 Auth & Rate Limiting

All three endpoints require:
- Valid session (checked via better-auth)
- No additional permissions — any authenticated user can search GIFs

Server-side rate limiting (future consideration): Add a simple in-memory rate limiter per user (e.g., 30 requests/min to the Giphy-backed endpoints) to prevent abuse via the server's Giphy API key.

---

## 5. WebSocket Flow

### 5.1 Sending a GIF

The existing `sendEncryptedMessage` flow handles GIFs with zero changes to the WebSocket server logic:

```typescript
// Client-side, after user selects a GIF
async function onSendGif(gif: GifSelection, roomKey: CryptoKey) {
  const metadata: GifMetadata = {
    type: "gif",
    gifId: gif.id,
    gifUrl: gif.mp4Url,
    previewUrl: gif.tinygifUrl,
    width: gif.width,
    height: gif.height,
    size: gif.size,
    title: gif.title,
  };

  // Encrypt with existing room key (same as text messages)
  const encrypted = await encryptMessage(JSON.stringify(metadata), roomKey);

  // Send via existing WebSocket infrastructure
  const response = await sendEncryptedMessage({
    roomId,
    ...encrypted,
    messageType: "gif",     //   only change: new messageType value
  });
}
```

The server-side `send_message` handler already:
1. Validates membership + room active state
2. Validates `ciphertext`, `iv`, `authTag` are non-empty and within `MAX_ENVELOPE_FIELD_SIZE` (8192 bytes)
3. Validates `messageType` is in the allowed set → we just add `"gif"` to the set
4. Persists to MongoDB (same collection, same fields)
5. Broadcasts to room

### 5.2 Receiving a GIF

```typescript
// Client receives "room_message" event
socket.on("room_message", async (incoming: RealtimeRoomMessage) => {
  if (incoming.roomId !== roomId || !roomKeyRef.current) return;

  // Decrypt the message body
  const decryptedJson = await decryptMessage(incoming, roomKeyRef.current);

  if (incoming.messageType === "gif") {
    const metadata: GifMetadata = JSON.parse(decryptedJson);
    // Decryption succeeded → metadata is authentic
    // Render the GIF using metadata.gifUrl (Tenor CDN)
  } else {
    // Existing text/image/video handling
    await appendDecrypted([incoming]);
  }
});
```

### 5.3 Server-Side Changes (Minimal)

**`packages/websocket-server/src/index.ts`:**

```typescript
// Line 245 — update the validation set
if (!["text", "image", "file", "gif"].includes(messageType)) {
  ack?.({ ok: false, error: "Invalid messageType" });
  return;
}
```

**`packages/websocket-server/src/db.ts`:**

```typescript
// Line 50 — update the type union
messageType: "text" | "image" | "file" | "gif";
```

That's it. The existing `persistEncryptedMessage` function stores whatever `ciphertext`/`iv`/`authTag` it receives — it never inspects the content. The `fetchMessagesSince` and REST history endpoints pass `messageType` through transparently. No DB schema changes.

---

## 6. Data Model Changes

### 6.1 `UiMessage` (Frontend, `message-list.tsx`)

```typescript
// Updated — add optional GIF metadata
export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
  messageType?: "text" | "image" | "video" | "gif";   // NEW: "gif"
  mediaMetadata?: ImageMetadata | VideoMetadata;         // existing
  gifMetadata?: GifMetadata;                            // NEW
}
```

### 6.2 `GifMetadata` Type (New, `lib/models.ts`)

```typescript
export interface GifMetadata {
  type: "gif";
  gifId: string;
  gifUrl: string;         // original_mp4 URL for optimized rendering
  previewUrl: string;     // fixed_width_small URL for picker/placeholder
  fallbackUrl: string;    // original/downsized GIF URL as fallback
  width: number;
  height: number;
  size: number;
  title?: string;
}
```

### 6.3 `OutboundEncryptedMessage.messageType` (`socket-client.ts`)

```typescript
// Updated union
messageType?: "text" | "image" | "file" | "gif";
```

### 6.4 `RoomMessage.messageType` (Server, `models.ts`)

```typescript
// Updated union
messageType: "text" | "image" | "file" | "gif";
```

### 6.5 `PersistEncryptedMessageInput.messageType` (Server, `db.ts`)

```typescript
// Updated union
messageType: "text" | "image" | "file" | "gif";
```

### 6.6 No MongoDB Schema Changes

The `room_messages` collection stores:
```typescript
{
  _id: ObjectId,
  roomId: ObjectId,
  senderId: ObjectId,
  ciphertext: string,      // Encrypted JSON with GifMetadata
  iv: string,
  authTag: string,
  messageType: "text" | "image" | "file" | "gif",  // Just a new enum value
  createdAt: Date
}
```

No new fields, no new collections, no migration needed. Existing indexes work unchanged.

---

## 7. UI Integration Strategy

### 7.1 GIF Button in ChatInput

A single subtle GIF button added to the ChatInput, to the left of the textarea:

```
┌─────────────────────────────────────────────────────────┐
│ [GIF] [Image] [Video] │ Message text...         [Send]  │
└─────────────────────────────────────────────────────────┘
```

**Design:**
- Icon: `FileImage` or a custom "GIF" label button from lucide-react
- Size: `h-9 w-9`, same as other action buttons
- Style: `text-neutral-600 hover:text-white` (matches the existing design language)
- No border by default, subtle border on hover
- Positioned before Image/Video buttons (logical order: GIF first, then static images)
- On mobile: same position, min 44x44px touch target

### 7.2 GIF Picker Modal

Opens when the GIF button is clicked. Full-screen overlay modal:

```
┌──────────────────────────────────────────────────────────┐
│  ← GIF Picker                                     [X]   │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 🔍 Search GIFs...                               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Categories bar (horizontal scroll):                     │
│  [Anime] [Sports] [Reactions] [Memes] [Animals] [...]   │
│                                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                   │
│  │ GIF  │ │ GIF  │ │ GIF  │ │ GIF  │                   │
│  │ 1    │ │ 2    │ │ 3    │ │ 4    │                   │
│  └──────┘ └──────┘ └──────┘ └──────┘                   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                   │
│  │ GIF  │ │ GIF  │ │ GIF  │ │ GIF  │                   │
│  │ 5    │ │ 6    │ │ 7    │ │ 8    │                   │
│  └──────┘ └──────┘ └──────┘ └──────┘                   │
│                                                          │
│  [Load more...]                                          │
└──────────────────────────────────────────────────────────┘
```

**States:**
- **Initial (no search)**: Shows trending GIFs + category bar
- **Searching**: Debounced input (400ms), results replace trending grid
- **Empty search results**: "No GIFs found for 'query'" message
- **Loading**: Skeleton grid with `animate-pulse` placeholders (4-8 cells)
- **Error**: "Could not load GIFs. Try again." with retry button
- **Selected**: GIF highlights briefly, modal closes, GIF sends as message

**Modal implementation:**
```tsx
function GifPicker({ open, onClose, onSelect }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [categories, setCategories] = useState<GifCategory[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const debouncedQuery = useDebounce(query, 400);

  // On mount: fetch trending + categories
  // On debouncedQuery change: fetch search results
  // On category click: set query to category searchterm
  // Infinite scroll or "Load more" button for pagination
}
```

### 7.3 Rendering GIFs in Chat

```tsx
// Inside MessageBubble, when messageType === "gif"
{gifMetadata && (
  <div className="relative overflow-hidden rounded-sm">
    <video
      src={gifMetadata.gifUrl}
      poster={gifMetadata.previewUrl}
      autoPlay
      loop
      muted
      playsInline
      className="max-h-80 w-full object-contain"
      onError={(e) => {
        // Fallback to GIF format if mp4 fails
        (e.target as HTMLVideoElement).src = gifMetadata.fallbackUrl;
      }}
    />
    <span className="mt-1 block text-right text-[10px] text-neutral-500">
      {formatTime(message.createdAt)}
      {!message.isOwn && <span className="ml-2 text-[10px] uppercase text-neutral-600">GIF</span>}
    </span>
  </div>
)}
```

**Why `<video>` instead of `<img>` for GIFs:**
- MP4/WebM video is 10-20x smaller than GIF format
- `<video autoplay loop muted playsinline>` renders identically to an animated GIF
- Browsers natively support optimized playback
- Giphy provides mp4 renditions via API

**Fallback:** If the video element errors, switch to `gifMetadata.fallbackUrl` (the original .gif file) — Giphy always provides this.

### 7.4 GIF in Message History

When loading older messages via `fetchMessageHistory()`:
1. Fetch encrypted records from REST API
2. `decryptBatch()` decrypts each record
3. For `messageType === "gif"`: parse decrypted JSON as `GifMetadata`
4. Store in `UiMessage.gifMetadata`
5. `MessageBubble` renders `<video>` with `gifMetadata.gifUrl`
6. GIFs load directly from Giphy CDN — no cache priming needed

### 7.5 Mobile Layout

| Element | Mobile Behavior |
|---------|----------------|
| GIF button | Visible in ChatInput, same position, 44px touch target |
| GIF Picker | Full-screen modal, covers entire viewport (`inset-0`) |
| Search bar | At top, auto-focuses on open |
| Results grid | 2 columns (vs 3-4 on desktop) |
| Categories | Horizontal scroll, swipeable |
| Close button | Top-right, `h-10 w-10` touch target |
| GIF bubble | Full width (`max-w-[85%]`), same as text bubbles |

### 7.6 Dark Theme Consistency

All new UI elements use existing design tokens:
- Modal overlay: `bg-black/80 backdrop-blur-sm`
- Modal container: `border border-neutral-800 bg-neutral-950`
- Search input: `border border-neutral-800 bg-black text-white placeholder:text-neutral-600`
- Category pills: `border border-neutral-800 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-400 hover:border-neutral-600 hover:text-white`
- GIF grid: `gap-2` with rounded corners
- Loading skeleton: `animate-pulse bg-neutral-800 rounded-sm`
- Close button: `text-neutral-500 hover:text-white`
- Selected state: Brief green border flash on the selected GIF

---

## 8. Performance Considerations

### 8.1 Debounced Search

- Debounce interval: **400ms** (between the 300-500ms requirement)
- Implementation: `useDebounce` hook (already exists in codebase at `hooks/use-debounce.ts`)
- Prevents excessive API calls while typing
- Previous search requests are **not aborted** (acceptable — cache will serve subsequent requests for the same query)

### 8.2 Search as You Type vs. Explicit Search

- The picker auto-searches as the user types (debounced)
- No "Search" button needed — results update in real-time
- When clearing the search field, reverts to trending GIFs

### 8.3 GIF Rendering Performance

- **MP4 is always preferred** over GIF — 10-20x smaller files, hardware-decoded
- Lazy loading: GIFs in the message list use browser-native lazy loading via `<video preload="metadata">`
- No client-side cache needed for GIFs (unlike encrypted media) — Giphy CDN + browser HTTP cache handle this
- GIFs loaded from history are fetched on-demand as user scrolls (browser handles this naturally)

### 8.4 Picker Pagination

- Initial load: 20 results (both trending and search)
- "Load more" button at bottom of grid OR infinite scroll
- Next page: `GET /api/gifs/trending?offset=<next>` or `GET /api/gifs/search?q=...&offset=<next>`
- Each page is separately cached by its `offset` cursor

### 8.5 Network Considerations

- Server-side cache hit: ~1ms response (in-memory lookup)
- Server-side cache miss: ~200-500ms (Giphy API round trip)
- GIF rendering: Depends on Giphy CDN (typically fast, globally distributed)
- The server cache means the **first user** to search a query pays the latency; all subsequent users get instant results

---

## 9. Edge Case Analysis

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | **Giphy API is down** | Server returns 502 from `/api/gifs/*` routes. Picker shows "Could not load GIFs" error with retry button. Existing GIF messages continue to render (URLs still valid as long as Giphy CDN is up). |
| 2 | **Giphy API key is invalid/missing** | Server returns 500 with "Giphy API not configured". Picker shows error. Admin must add `GIPHY_API_KEY` to env. |
| 3 | **Giphy rate limit exceeded** | Giphy returns 429. Our server returns 429. Picker shows "Too many requests. Try again later." Cache helps prevent this. |
| 4 | **GIF URL is dead (removed from Giphy)** | `<video>` element fires `onError`. Show fallback URL (`.gif`). If that also fails, show placeholder with GIF ID + "GIF removed" text. |
| 5 | **User picks a GIF while offline** | `sendEncryptedMessage` fails (WebSocket disconnected). Error toast shown. The picker closes, GIF is not lost (user re-opens picker and re-selects). |
| 6 | **GIF metadata exceeds MAX_ENVELOPE_FIELD_SIZE** | GIF metadata is ~300-500 bytes. Well under 8192 byte limit. Not a concern. |
| 7 | **Malformed GIF metadata in history** | `JSON.parse()` throws in `decryptBatch` catch block. Message is skipped (same as undecryptable text messages). No crash. |
| 8 | **User sends GIF in disabled room** | Server rejects `send_message` with "ROOM_DISABLED". Error toast shown. |
| 9 | **Category API returns unexpected format** | Our transformation layer normalizes the response. If parsing fails, categories section is hidden, trending still works. |
| 10 | **Search query with special characters** | `encodeURIComponent` handles encoding. Giphy API accepts standard UTF-8. |
| 11 | **Empty search query** | Don't call search endpoint. Show trending instead. |
| 12 | **Very long search query (>100 chars)** | Reject with 400 on server side. Client-side limit of 100 chars on input. |
| 13 | **Multiple users search same query simultaneously** | First request fetches from Giphy and caches. Subsequent concurrent requests may all miss cache → multiple Giphy calls (race condition). Acceptable for MVP. Future: add a lock/mutex pattern. |
| 14 | **GIF picker opened while media upload in progress** | Independent — GIF picker uses different API endpoints and doesn't compete with media upload. Both can operate simultaneously. |
| 15 | **User switches rooms while picker is open** | Picker is local UI state. It closes when the GIF button is re-clicked or user navigates. No cross-room state issues. |
| 16 | **GIF in a room with no active members** | Message persists to MongoDB. When members join later and sync history, they'll see and render the GIF. |
| 17 | **Giphy API returns GIF with 0x0 dimensions** | Set `width: 200, height: 200` as fallback for rendering aspect ratio. |
| 18 | **Old clients (before GIF support) receive a GIF message** | The decrypted body will be JSON string like `{"type":"gif","gifId":"...","gifUrl":"..."}`. It renders as raw JSON in a text bubble. Not ideal but not destructive. The `messageType` field lets forward-compatible clients handle it properly. |

---

## 10. Migration Plan

### Phase 1: Backend — Giphy API Routes + Cache

| Step | File(s) | What |
|------|---------|------|
| 1 | `.env.example`, production env | Add `GIPHY_API_KEY` |
| 2 | `packages/frontend/src/lib/gif-cache.ts` (NEW) | `GifSearchCache` interface + `InMemoryGifSearchCache` implementation |
| 3 | `packages/frontend/src/app/api/gifs/search/route.ts` (NEW) | Search endpoint: validate → check cache → call Giphy → cache → respond |
| 4 | `packages/frontend/src/app/api/gifs/trending/route.ts` (NEW) | Trending endpoint: same pattern |
| 5 | `packages/frontend/src/app/api/gifs/categories/route.ts` (NEW) | Categories endpoint: same pattern |
| 6 | `packages/frontend/src/lib/models.ts` | Add `GifMetadata` interface |
| 7 | `packages/frontend/src/lib/socket-client.ts` | Add `"gif"` to `messageType` union in `OutboundEncryptedMessage` and `RealtimeRoomMessage` |

### Phase 2: WebSocket Server (Minimal)

| Step | File(s) | What |
|------|---------|------|
| 8 | `packages/websocket-server/src/index.ts` | Add `"gif"` to `messageType` validation set (line ~245) |
| 9 | `packages/websocket-server/src/db.ts` | Add `"gif"` to `PersistEncryptedMessageInput.messageType` union |

### Phase 3: GIF Picker UI

| Step | File(s) | What |
|------|---------|------|
| 10 | `packages/frontend/src/components/chat/gif-picker.tsx` (NEW) | Full GIF picker: search, trending, categories, grid, pagination |
| 11 | `packages/frontend/src/hooks/use-debounce.ts` | Already exists — 400ms debounce for search |
| 12 | `packages/frontend/src/components/chat/chat-input.tsx` | Add GIF button with `onGifClick` prop |
| 13 | `packages/frontend/src/components/chat/message-list.tsx` | Update `UiMessage` interface, update `MessageBubble` to render GIF messages |
| 14 | `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Wire up: GIF picker state, `onSendGif` handler, pass GIF button to `ChatInput`, update `decryptBatch` for GIF types |

### Phase 4: Testing

| Area | What to test |
|------|-------------|
| GIF picker | Open/close, search debounce, trending load, category click, pagination, empty state, error state |
| GIF send | Select GIF → encrypt → send → see in chat |
| GIF receive | Other client receives and renders GIF |
| History | Load old GIF messages from history → render |
| Cache | First search (cache miss) vs. second search (cache hit) |
| Edge cases | Dead GIF URL, Giphy API down, invalid API key, concurrent searches |
| Mobile | Picker layout, touch targets, scroll behavior |

### Rollback Plan

- **Remove `"gif"` from messageType union** on both client and server → server rejects GIF messages
- **GIF messages already in history** become undecryptable as valid JSON but render as raw text (same as any other unknown messageType). No data corruption.
- **Remove API routes** `/api/gifs/*` → GIF picker shows "Not available"
- **No database changes to roll back** — MongoDB data is unchanged

---

## 11. File Change Summary

### New Files (4)

| # | File | Purpose |
|---|------|---------|
| 1 | `packages/frontend/src/lib/gif-cache.ts` | `GifSearchCache` interface + `InMemoryGifSearchCache` (server-side, imported by API routes) |
| 2 | `packages/frontend/src/app/api/gifs/search/route.ts` | `GET /api/gifs/search` — search Giphy, cache results, return transformed response |
| 3 | `packages/frontend/src/app/api/gifs/trending/route.ts` | `GET /api/gifs/trending` — trending Giphy, cache with 15min TTL |
| 4 | `packages/frontend/src/app/api/gifs/categories/route.ts` | `GET /api/gifs/categories` — categories from Giphy, cache with 24h TTL |
| 5 | `packages/frontend/src/components/chat/gif-picker.tsx` | GIF picker modal: search, trending, categories, grid, pagination, dark theme |

*(5 new files)*

### Modified Files (7)

| # | File | Changes |
|---|------|---------|
| 6 | `.env.example` | Add `GIPHY_API_KEY` |
| 7 | `packages/frontend/src/lib/models.ts` | Add `GifMetadata` interface. Update `RoomMessage.messageType` to include `"gif"`. |
| 8 | `packages/frontend/src/lib/socket-client.ts` | Add `"gif"` to `messageType` union in `OutboundEncryptedMessage` and `RealtimeRoomMessage` |
| 9 | `packages/frontend/src/components/chat/chat-input.tsx` | Add GIF button with `onGifClick` prop |
| 10 | `packages/frontend/src/components/chat/message-list.tsx` | Update `UiMessage` with `gifMetadata`, update `MessageBubble` to render GIF via `<video>` |
| 11 | `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Wire `onSendGif`, GIF picker state, update `decryptBatch` for `"gif"` messageType |
| 12 | `packages/websocket-server/src/index.ts` | Add `"gif"` to `messageType` validation in `send_message` handler |
| 13 | `packages/websocket-server/src/db.ts` | Add `"gif"` to `PersistEncryptedMessageInput.messageType` union |

*(7 modified files)*

### Total: 12 files changed (5 new + 7 modified)

### Zero Changes

| System | Reason |
|--------|--------|
| MongoDB schema | No new collections, no new fields. Existing `room_messages` stores opaque encrypted payloads. |
| Cloudflare R2 | GIFs are never uploaded. They're served from Giphy CDN. |
| Crypto module (`crypto.ts`) | GIF metadata is encrypted using the existing `encryptMessage`/`decryptMessage` functions. No new crypto primitives needed. |
| Message history API | Returns `messageType` transparently. GIF messages in history are fetched, decrypted, and rendered identically to text. |
| Room membership/E2EE key exchange | Unchanged. Same room key protects both text and GIF messages. |
| Presence system | Unchanged. |
| Typing indicators | Unchanged. |
| Auth/sessions | Unchanged. Only requires valid session for Giphy-backed API routes. |

---

## 12. Commit Breakdown

| Commit | Files | Message |
|--------|-------|---------|
| 1 | `.env.example` | `chore: add GIPHY_API_KEY to environment config` |
| 2 | `packages/frontend/src/lib/gif-cache.ts` | `feat: add GifSearchCache interface and InMemoryGifSearchCache implementation` |
| 3 | `packages/frontend/src/app/api/gifs/search/route.ts`, `trending/route.ts`, `categories/route.ts` | `feat: add Giphy-backed GIF API routes with server-side caching` |
| 4 | `packages/frontend/src/lib/models.ts`, `socket-client.ts` + both websocket-server files | `feat: add "gif" messageType to type definitions and server validation` |
| 5 | `packages/frontend/src/components/chat/gif-picker.tsx` | `feat: add GIF picker modal with search, trending, categories, and dark theme` |
| 6 | `packages/frontend/src/components/chat/chat-input.tsx`, `message-list.tsx`, `rooms/[roomId]/page.tsx` | `feat: integrate GIF picker into chat input and render GIFs in message bubbles` |
