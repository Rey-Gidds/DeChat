# E2EE Media Architecture — Privacy-First Images & Videos

> **Status**: Draft for review  
> **Project**: DeChat — Privacy-First E2EE Messaging  
> **Date**: 2026-06-09  
> **Context**: Add privacy-first end-to-end encrypted media sharing (images + videos) that never touches the application server and is never stored in MongoDB.

---

## Table of Contents

- [1. Core Design Decisions](#1-core-design-decisions)
- [2. Architecture Overview](#2-architecture-overview)
- [3. Upload Lifecycle](#3-upload-lifecycle)
- [4. Download Lifecycle](#4-download-lifecycle)
- [5. Encryption Flow](#5-encryption-flow)
- [6. Caching Strategy](#6-caching-strategy)
- [7. UI Integration Plan](#7-ui-integration-plan)
- [8. Data Model Changes](#8-data-model-changes)
- [9. Storage Considerations](#9-storage-considerations)
- [10. Performance Considerations](#10-performance-considerations)
- [11. Edge Case Analysis](#11-edge-case-analysis)
- [12. File Change Summary](#12-file-change-summary)
- [13. Migration Plan](#13-migration-plan)

---

## 1. Core Design Decisions

### Decision 1: Reuse existing room AES key for media encryption

The same AES-256-GCM room key used for message encryption is used to encrypt/decrypt media blobs. No per-media keys, no `encryptedMediaKey` distribution. This keeps the MVP simple — if you can read messages in a room, you can view its media.

### Decision 2: Media never passes through the application server

The client encrypts before uploading and decrypts after downloading. The application server (both Next.js and WebSocket server) **never** receives raw media bytes. Only the presigned URL endpoint exists server-side — and the server only issues the URL, it never proxies the upload.

### Decision 3: Encrypted blobs stored in Cloudflare R2, never MongoDB

Media blobs are large (hundreds of KB to tens of MB). Storing them in MongoDB would bloat the database, slow down backup/restore, and increase costs. R2 provides S3-compatible object storage with no egress fees and global CDN access.

### Decision 4: CDN URLs are public; security relies on encryption

Since the stored blobs are encrypted with the room key, there is no risk in exposing them publicly. Object keys are random UUIDs with no user/room metadata. This removes the need for presigned download URLs and allows direct CDN access for fast retrieval.

### Decision 5: Client-side optimization before encryption

Images are resized, converted to WebP, and compressed client-side using the Canvas API before encryption. Video thumbnails are generated from the first frame. This minimizes storage costs, bandwidth, and decryption time.

### Decision 6: In-memory cache with abstraction layer for future IndexedDB

Media objects are cached in memory after decryption for fast re-rendering. The cache interface is designed so that IndexedDB persistence can be added later without changing the media loading API.

### Decision 7: In-flight request deduplication

When multiple `MessageBubble` components render simultaneously (e.g., scrolling through media-heavy chats), only one network request is made per unique object key. Subsequent requests await the same promise.

### Decision 8: Encrypted metadata in existing message envelope

Media metadata (type, dimensions, mimeType, size, objectKey, thumbnailKey) is JSON-serialized, encrypted with the room key, and sent as the `ciphertext` body of a standard `send_message` WebSocket event. This reuses the existing encrypted message history architecture — no new database collections or message types.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (Client)                      │
│                                                              │
│  Select File                                                 │
│     │                                                        │
│     ▼                                                        │
│  Optimize (Canvas API)                                       │
│  ┌────────────┐  ┌────────────┐                             │
│  │ Image:      │  │ Video:     │                             │
│  │ Resize      │  │ Thumbnail  │                             │
│  │ WebP conv.  │  │ (first     │                             │
│  │ Compress    │  │  frame)    │                             │
│  └────────────┘  └────────────┘                             │
│     │                                                        │
│     ▼                                                        │
│  Encrypt with Room AES-256-GCM Key                           │
│     │                                                        │
│     ├──→ Request presigned upload URL from backend           │
│     │       ┌──────────────────────┐                         │
│     │       │ POST /api/media/     │                         │
│     │       │   upload-url         │                         │
│     │       │ Returns: {           │                         │
│     │       │   uploadUrl,         │                         │
│     │       │   objectKey          │                         │
│     │       │ }                    │                         │
│     │       └──────────┬───────────┘                         │
│     │                  │                                      │
│     ▼                  ▼                                      │
│  Upload encrypted blob directly to Cloudflare R2              │
│     │                                                        │
│     ▼                                                        │
│  Send WebSocket message with encrypted metadata               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ { ciphertext: encrypt(JSON.stringify({              │     │
│  │     type, objectKey, mimeType, width, height,       │     │
│  │     size, thumbnailKey?                             │     │
│  │   })), iv, authTag, messageType: "image"|"video"   │     │
│  │ }                                                   │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         │
         │ WebSocket "send_message"
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    WebSocket Server (:3001)                   │
│                                                              │
│  • Validates membership + room active state                  │
│  • Stores encrypted payload in MongoDB room_messages         │
│    (same as text messages — ciphertext, iv, authTag)         │
│  • Broadcasts to all room members via "room_message" event   │
│  • NEVER sees raw media bytes                                │
│  • No code changes to media handling — it's opaque data      │
└─────────────────────────────────────────────────────────────┘
         │
         │ Broadcast to room
         ▼
┌─────────────────────────────────────────────────────────────┐
│                  Receiving Client(s)                         │
│                                                              │
│  Receive "room_message" event                                │
│     │                                                        │
│     ▼                                                        │
│  Decrypt message payload with room key                       │
│  → JSON.parse() → MediaMetadata                              │
│     │                                                        │
│     ▼                                                        │
│  Check in-memory cache                                       │
│     ├── HIT → render immediately                             │
│     └── MISS → check in-flight requests                      │
│              ├── EXISTS → await existing promise             │
│              └── MISS → fetch from CDN                       │
│                        → decrypt with room key               │
│                        → store in cache                      │
│                        → render                              │
│                                                              │
│  CDN URL: https://<r2-public-domain>/<objectKey>             │
│  (public URL since blob is encrypted)                        │
└─────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
RoomChatPage (page.tsx)
├── RoomHeader
├── MessageList
│   ├── MessageBubble (text messages — existing)
│   │   └── renders message.body as text
│   └── MessageBubble (media messages — new)
│       └── MediaMessage component
│           ├── Image → <img> with decrypted blob URL
│           └── Video → <video> with decrypted blob URL + thumbnail
├── TypingIndicator
└── ChatInput
    ├── TextArea (existing)
    ├── Send Button (existing)
    ├── Image Upload Button (new)
    └── Video Upload Button (new)
```

### Data Flow Summary

| Step | Component | Action |
|------|-----------|--------|
| 1 | ChatInput | User clicks image/video button → file input opens |
| 2 | ChatInput → RoomChatPage | `onSendMedia(file)` called |
| 3 | RoomChatPage | Calls `optimizeMedia(file)` → encryptMedia(blob, roomKey) |
| 4 | RoomChatPage | `POST /api/media/upload-url` → gets `{ uploadUrl, objectKey }` |
| 5 | RoomChatPage | `PUT uploadUrl` with encrypted blob body → R2 |
| 6 | RoomChatPage | `sendEncryptedMessage({ ciphertext: encrypt(JSON.stringify(metadata)), messageType: "image"|"video" })` |
| 7 | Server | Persists encrypted envelope → broadcasts to room |
| 8 | Receiving client | `decryptMessage(payload)` → JSON parse → MediaMetadata |
| 9 | Receiving client | `MediaMessage` component → check cache → fetch CDN → decrypt → render |

---

## 3. Upload Lifecycle

### Step 1: User selects media

```
User clicks image/video button in ChatInput
  → Hidden <input type="file" accept="image/*|video/*"> triggered
  → File object captured
```

### Step 2: Client-side optimization

```typescript
// Image path
async function optimizeImage(file: File): Promise<{ optimized: Blob; thumbnail?: Blob; metadata: ImageMetadata }> {
  // 1. Decode image into ImageBitmap via createImageBitmap
  // 2. Calculate new dimensions (max 1920px on longest side, maintains aspect ratio)
  // 3. Draw onto OffscreenCanvas at new dimensions
  // 4. Export as WebP with quality 0.8 via canvas.toBlob('image/webp', 0.8)
  // 5. Return optimized blob + dimensions + original name/size
}
```

**Image optimization parameters:**
- Max dimension: 1920px (longest side), maintains aspect ratio
- Format: WebP (widely supported, excellent compression)
- Quality: 0.8 (good balance of quality/size)
- Min dimension: 200px (don't upscale small images)

```typescript
// Video path — thumbnail only (heavy transcoding deferred to future)
async function generateVideoThumbnail(file: File): Promise<{ thumbnail: Blob; metadata: { width: number; height: number; duration: number } }> {
  // 1. Create video element, load file as object URL
  // 2. Seek to 10% of duration (or 0 if very short)
  // 3. Draw frame to canvas
  // 4. Export as WebP with quality 0.7, max dimension 640px
  // 5. Return thumbnail blob + dimensions
}
```

**Video optimization:** For MVP, videos are uploaded as-is (no client-side transcoding — that requires ffmpeg.wasm which is a heavy dependency). Only a thumbnail is generated client-side.

### Step 3: Object key generation

```typescript
const objectKey = crypto.randomUUID();  // "550e8400-e29b-41d4-a716-446655440000"
const thumbnailKey = crypto.randomUUID(); // for videos
```

Never uses filenames, user IDs, room IDs, or other identifiable data.

### Step 4: Encrypt with room key

```typescript
// Binary encryption using the same AES-256-GCM room key
export async function encryptMedia(
  blob: Blob,
  roomKey: CryptoKey
): Promise<{ encrypted: Blob; iv: string }> {
  const plaintext = await blob.arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    roomKey,
    plaintext
  );
  return {
    encrypted: new Blob([encryptedBuffer]),
    iv: btoa(String.fromCharCode(...iv)),
  };
}
```

The encrypted blob is opaque to everyone who doesn't have the room key.

### Step 5: Request presigned upload URL

```
POST /api/media/upload-url
Authorization: (session cookie)
Body: { mimeType: string, size: number, roomId: string }

Response: {
  uploadUrl: string,    // Presigned PUT URL, expires in 5 minutes
  objectKey: string     // UUID v4 — already generated client-side or server-side
}
```

**Server-side validation:**
1. Verify authenticated session
2. Verify active APPROVED membership in the room with `encryptedRoomKey`
3. Validate room is not disabled
4. Size limits: image max 10MB, video max 100MB
5. Generate presigned R2 PUT URL with 5-minute expiry
6. Return URL + objectKey

### Step 6: Upload directly to R2

```typescript
await fetch(uploadUrl, {
  method: "PUT",
  body: encryptedBlob,   // The encrypted blob, not the original
  headers: { "Content-Type": "application/octet-stream" },  // Opaque binary
});
```

The server never sees this request — it goes directly from browser to R2.

### Step 7: Send encrypted metadata via WebSocket

```typescript
const metadata: ImageMetadata = {
  type: "image",
  objectKey: "550e8400-e29b-41d4-a716-446655440000",
  mimeType: "image/webp",
  width: 1200,
  height: 900,
  size: 245000,
};

const encrypted = await encryptMessage(JSON.stringify(metadata), roomKey);
const response = await sendEncryptedMessage({
  roomId,
  ...encrypted,
  messageType: "image",  // or "video"
});
```

### Retry Logic

| Failure Point | Strategy |
|---------------|----------|
| Presigned URL request fails | Show error toast, keep file selected, retry button |
| R2 upload fails | Retry with new presigned URL, max 3 attempts, exponential backoff |
| WebSocket message fails | Show error toast, file was already uploaded (orphan cleanup needed) |
| Optimistic: message fails after upload | Orphan object in R2 (no cleanup for MVP — acceptable for low volume) |

---

## 4. Download Lifecycle

### Step 1: Receive WebSocket message

```typescript
socket.on("room_message", async (incoming: RealtimeRoomMessage) => {
  if (incoming.messageType === "text") {
    await appendDecrypted([incoming]);  // existing flow
  } else {
    // Still decrypt the message body to get metadata
    // But don't fetch media yet — let MediaMessage component handle it
    await appendDecrypted([incoming]);
  }
});
```

### Step 2: Decrypt message → get metadata

```typescript
const decryptedJson = await decryptMessage(payload, roomKey);
const metadata: ImageMetadata | VideoMetadata = JSON.parse(decryptedJson);
```

The `UiMessage` is extended to carry `messageType` and raw `mediaMetadata`.

### Step 3: MediaMessage component renders

```
MediaMessage renders in MessageBubble
  → useMediaLoader(metadata.objectKey, roomKey)  // custom hook
     ├── Check in-memory cache
     │   └── HIT → return cached decrypted blob URL
     ├── Check in-flight Map
     │   └── HIT → await existing promise
     ├── Fetch from CDN: GET https://media.dechat.app/<objectKey>
     │   (returns encrypted blob — opaque bytes)
     ├── Decrypt with room key: decryptMedia(encryptedBlob, roomKey)
     ├── Store in cache + create object URL
     └── Return blob URL for rendering
```

### Step 4: Render

```typescript
// Image
<img src={blobUrl} alt="Shared image" width={metadata.width} height={metadata.height} />

// Video
<video src={blobUrl} poster={thumbnailBlobUrl} controls preload="metadata" />
```

### Step 5: Cleanup

```typescript
// Revoke object URLs when component unmounts or media changes
useEffect(() => {
  return () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (thumbnailBlobUrl) URL.revokeObjectURL(thumbnailBlobUrl);
  };
}, [blobUrl, thumbnailBlobUrl]);
```

### Message History (REST API)

When loading history via `fetchMessageHistory()`, the same flow applies:
1. Fetch encrypted message records from REST API
2. Decrypt each message with room key → get plaintext or media metadata
3. For media messages, store metadata in `UiMessage`
4. `MessageBubble` renders `MediaMessage` which lazy-loads the blob

Encrypted messages in MongoDB are already returned with `messageType`, so the client knows which are media before decrypting.

---

## 5. Encryption Flow

### Media Encryption (send)

```typescript
export async function encryptMedia(
  plaintext: ArrayBuffer,  // Raw optimized bytes
  roomKey: CryptoKey       // AES-256-GCM room key
): Promise<{ encrypted: ArrayBuffer; iv: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    roomKey,
    plaintext
  );
  return {
    encrypted: encryptedBuffer,
    iv: btoa(String.fromCharCode(...iv)),
  };
}
```

The IV is **not stored alongside the encrypted blob in R2**. The IV is embedded in the encrypted message metadata (sent via WebSocket). This means:
- An attacker with R2 access has encrypted blobs but no IVs
- Room members decrypt the message to get both the IV and objectKey
- They can then fetch the blob + IV and decrypt

### Media Decryption (receive)

```typescript
export async function decryptMedia(
  encrypted: ArrayBuffer,  // Fetched from R2 CDN
  roomKey: CryptoKey,      // AES-256-GCM room key
  iv: Uint8Array           // 12-byte IV from decrypted metadata
): Promise<ArrayBuffer> {
  return window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    roomKey,
    encrypted
  );
}
```

### Key Points

- Same room key used for both message and media encryption
- IV is random per upload, per message, and per media blob
- The IV for the media blob is transported inside the encrypted message payload
- Without the room key, blob bytes in R2 are indecipherable
- AES-GCM provides authenticated encryption — tampered blobs fail decryption

### Why reuse the room key?

| Approach | Pro | Con |
|----------|-----|-----|
| **Reuse room key (chosen)** | Simple, no key distribution, consistent with message encryption | Single key encrypts all media in room |
| Per-media key | Forward secrecy per-media | Requires key wrapping + distribution in message payload (+200 bytes per message) |
| Derived sub-key from room key | Per-media key without distribution | Complex derivation scheme, no meaningful security gain over reusing room key |

For an MVP, reusing the room key is the pragmatic choice. The room key already protects all past and future messages — adding media doesn't change the threat model.

---

## 6. Caching Strategy

### Layer 1: In-Flight Request Deduplication

```typescript
// Singleton Map — global to the app
const inflightRequests = new Map<string, Promise<DecryptedMediaResult>>();
```

**Purpose:** When scrolling through a media-heavy chat, multiple `MediaMessage` components might mount simultaneously for the same objectKey (e.g., same image referenced in a reply). This deduplication ensures only one network fetch is ever in flight for a given objectKey.

**Behavior:**
1. Component A requests objectKey "abc-123"
2. No cache hit, no in-flight → fetch starts, promise stored in Map
3. Component B requests same objectKey "abc-123" (same render cycle)
4. Cache miss, but in-flight hit → returns existing promise
5. Both components resolve with the same decrypted blob
6. On promise settlement (resolve or reject), entry is removed from Map

### Layer 2: In-Memory Cache

```typescript
interface CacheEntry {
  blob: Blob;           // Decrypted media blob
  mimeType: string;     // Original mime type (image/webp, video/mp4)
  timestamp: number;    // When this entry was cached
}

class InMemoryMediaCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries = 50;
  private ttl = 10 * 60 * 1000;  // 10 minutes

  async get(key: string): Promise<CacheEntry | null> { ... }
  async set(key: string, entry: CacheEntry): Promise<void> { ... }
  async delete(key: string): Promise<void> { ... }
  async clear(): Promise<void> { ... }
}
```

**Eviction strategy:**
- Max 50 entries (each could be several MB for images, larger for videos — ~200-500MB total budget)
- TTL of 10 minutes from insertion
- On insertion when full: evict oldest entry (Map preserves insertion order)
- On room leave: clear entire cache

**Purpose:** Fast room re-entry and smooth scrolling through recent media. If a user leaves and re-enters a room within 10 minutes, all recently viewed media renders instantly.

### Layer 3: Blob URL Lifecycle

When media is retrieved from cache or network:
1. Decrypted blob → `URL.createObjectURL(decryptedBlob)` → memory-efficient URL
2. URL passed to `<img>` or `<video>` src
3. On component unmount or media change: `URL.revokeObjectURL()`

Blob URLs are cheap (they reference the blob in memory rather than copying), but must be revoked to avoid memory leaks.

### Cache Abstraction Interface

```typescript
// Allows future IndexedDB persistence without changing consumers
interface MediaCacheProvider {
  get(objectKey: string): Promise<DecryptedMediaResult | null>;
  set(objectKey: string, result: DecryptedMediaResult): Promise<void>;
  delete(objectKey: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Cache Check Order

```
Consumer requests objectKey
  → 1. Check in-memory cache
       HIT → return blob immediately
  → 2. Check in-flight Map
       HIT → await existing promise
       MISS → create promise, store in Map
         → 3. Fetch encrypted blob from CDN
         → 4. Decrypt with room key + IV
         → 5. Store in in-memory cache
         → 6. Remove from in-flight Map
         → 7. Return blob
```

### Why no server-side caching?

Media blobs can be very large (10-100MB). Caching them server-side would:
- Bloat the application server's memory
- Duplicate storage already handled by Cloudflare CDN
- Create cache invalidation complexity
- Require additional infrastructure

Instead:
- **Cloudflare CDN**: Edge-caches the encrypted blobs (automatic with R2 public bucket)
- **Browser HTTP cache**: Standard `Cache-Control` headers on R2 public URLs
- **Client memory cache**: Decrypted blobs for instant re-render within session

---

## 7. UI Integration Plan

### 7.1 ChatInput — Media Upload Buttons

Two subtle buttons added to the ChatInput, consistent with the existing dark theme:

```
┌─────────────────────────────────────────────────────────┐
│                                                        │
│  [Image] [Video]  │ Message text...         [Send]     │
│                                                        │
└─────────────────────────────────────────────────────────┘
```

**Design:**
- Buttons placed to the left of the textarea (before the text input area)
- Small icon-only buttons: `ImageIcon` and `VideoIcon` from lucide-react
- Same styling as existing UI elements: `text-neutral-600 hover:text-white`
- `h-9 w-9` with no border by default, or subtle `border border-neutral-800`
- Hidden file inputs: `<input type="file" accept="image/*" hidden />` and `<input type="file" accept="video/*" hidden />`

**Mobile layout:**
- Buttons remain visible, same position
- Touch targets min 44x44px
- File picker triggers native photo library

### 7.2 MessageBubble — Media Rendering

**Current `MessageBubble`:**
```
┌───────────────────────────┐
│ SENDER NAME               │
│ ┌───────────────────────┐ │
│ │ Message text body     │ │
│ │                  12:30│ │
│ └───────────────────────┘ │
└───────────────────────────┘
```

**Updated `MessageBubble` for media:**
```
┌───────────────────────────┐
│ SENDER NAME               │
│ ┌───────────────────────┐ │
│ │ ┌─────────────────┐  │ │
│ │ │   Image/Video   │  │ │
│ │ │   (rendered     │  │ │
│ │ │    inline)      │  │ │
│ │ └─────────────────┘  │ │
│ │  Caption text (opt) │ │
│ │              12:30  │ │
│ └───────────────────────┘ │
└───────────────────────────┘
```

**Image rendering:**
```tsx
{metadata.type === "image" && (
  <div className="relative overflow-hidden">
    {loading ? (
      <div className="aspect-video animate-pulse bg-neutral-800" />
    ) : (
      <img
        src={blobUrl}
        alt="Shared image"
        className="max-h-96 w-full object-contain rounded-sm"
        loading="lazy"
        onClick={() => setExpanded(true)}  // Optional: lightbox in future
      />
    )}
  </div>
)}
```

**Video rendering:**
```tsx
{metadata.type === "video" && (
  <div className="relative overflow-hidden">
    {loading ? (
      <div className="aspect-video animate-pulse bg-neutral-800" />
    ) : (
      <video
        src={blobUrl}
        poster={thumbnailBlobUrl}
        controls
        preload="metadata"
        className="max-h-96 w-full rounded-sm"
      >
        Your browser does not support video playback.
      </video>
    )}
  </div>
)}
```

**Loading state:** Subtle `animate-pulse` skeleton matching the aspect ratio of the media. No spinners or text — consistent with the app's minimal design.

**Error state:**
```tsx
{error && (
  <div className="flex items-center justify-center aspect-video border border-neutral-800 bg-neutral-950 rounded-sm">
    <AlertTriangle size={20} className="text-neutral-600" />
    <span className="text-[10px] text-neutral-600 ml-2">Failed to load media</span>
  </div>
)}
```

### 7.3 Max Width & Alignment

Media messages follow the same alignment as text bubbles:
- Own messages: right-aligned, `bg-neutral-200 text-black` (white bubble)
- Others: left-aligned, `border border-neutral-800 bg-neutral-900` (dark bubble)
- Max width: `max-w-[85%]` mobile, `max-w-[70%]` desktop
- Images/videos fill the bubble width but respect aspect ratio

### 7.4 Responsive Considerations

| Device | Behavior |
|--------|----------|
| Desktop (sm+) | Max image height 400px, inline rendering with controls |
| Mobile | Max height 300px, tap to play video (native player) |
| Both | Images are `object-contain` (preserves aspect ratio, no cropping) |

### 7.5 Typing Indicator for Media

When a user is uploading media, show "User is sharing media..." in the typing indicator area (reuses existing `typing_start`/`typing_stop` events with a preview like "📷 Sharing an image" or "🎬 Sharing a video").

---

## 8. Data Model Changes

### 8.1 `UiMessage` (frontend)

```typescript
// Current
export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
}

// Updated
export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
  messageType?: "text" | "image" | "video";  // NEW
  mediaMetadata?: ImageMetadata | VideoMetadata;  // NEW
}
```

### 8.2 Media Metadata Types

```typescript
// New types in lib/models.ts or lib/media.ts
export interface ImageMetadata {
  type: "image";
  objectKey: string;      // UUID v4 — R2 object key
  mimeType: string;       // "image/webp"
  width: number;          // px
  height: number;         // px
  size: number;           // original encrypted file size in bytes (for display)
  iv: string;             // base64 IV used for encrypting the blob
}

export interface VideoMetadata {
  type: "video";
  objectKey: string;      // UUID v4 — R2 object key
  mimeType: string;       // "video/mp4"
  width: number;
  height: number;
  size: number;
  thumbnailKey: string;   // UUID v4 — R2 object key for thumbnail image blob
  thumbnailIv: string;    // base64 IV for thumbnail decryption
  duration?: number;      // seconds
  iv: string;             // base64 IV used for encrypting the video blob
}
```

### 8.3 `RoomMessage.messageType` (server)

```typescript
// Current
messageType: "text" | "image" | "file";

// Updated
messageType: "text" | "image" | "video";
```

Note: Removed `"file"` (unused) and added `"video"`. The existing `"image"` value is kept.

### 8.4 Schema Change: MongoDB `room_messages`

No schema change. The `ciphertext` field will contain encrypted JSON for media messages instead of encrypted text. The document structure (`_id`, `roomId`, `senderId`, `ciphertext`, `iv`, `authTag`, `messageType`, `createdAt`) remains identical.

This is the key insight: **media metadata is stored inside the existing encrypted message envelope**. No new documents, no new collections, no migration required.

---

## 9. Storage Considerations

### 9.1 Cloudflare R2 Configuration

**Bucket:** `dechat-media` (or configurable via `R2_BUCKET_NAME`)

**Public access:** Bucket is public (read-only) via R2.dev subdomain or custom domain. Since all objects are encrypted, there is no risk in making them publicly readable.

**Object lifecycle:**
- Object keys: UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- No prefixes or directories
- Thumbnail objects: separate UUID, no naming relationship to parent video

**CORS configuration (on R2 bucket):**
```json
{
  "AllowedOrigins": ["*"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3600
}
```

### 9.2 CDN URL Structure

```
https://<r2-public-domain>/<objectKey>
Example: https://pub-xxxxx.r2.dev/550e8400-e29b-41d4-a716-446655440000
```

Configurable via `NEXT_PUBLIC_R2_PUBLIC_URL` environment variable.

### 9.3 Sizing Estimates

| Media Type | Optimized Size | Encrypted Size | R2 Cost (per 100K objects) |
|------------|---------------|----------------|---------------------------|
| Image (WebP, 1920px) | 100-500 KB | +16 bytes (auth tag) | Negligible |
| Video (raw) | 1-50 MB | Same + 16 bytes | ~$0.36/GB-month |
| Video thumbnail | 20-50 KB | Same + 16 bytes | Negligible |

### 9.4 Object Lifetime

Orphan objects (upload succeeded but message send failed) are not cleaned up for MVP. In a future iteration:
- Add a TTL/expiration on objects when creating presigned URLs
- Or run a periodic cleanup script

### 9.5 Environment Variables

```
# .env — R2 Configuration (server-side)
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=dechat-media
R2_ACCOUNT_ID=your-cloudflare-account-id

# .env — Public (client-side)
NEXT_PUBLIC_R2_PUBLIC_URL=https://pub-xxxxx.r2.dev
```

---

## 10. Performance Considerations

### 10.1 Image Optimization

**Canvas-based pipeline:**
1. `createImageBitmap(file)` — decodes in worker thread (non-blocking)
2. Draw to `OffscreenCanvas` at target dimensions — GPU-accelerated
3. `canvas.toBlob('image/webp', 0.8)` — WebP encoding

**Performance characteristics:**
- 4K image → 1920px WebP: ~50-200ms on modern devices
- Memory: temporary pixel buffer is ~1920x1080x4 = ~8MB
- No main thread blocking (uses OffscreenCanvas + ImageBitmap)

### 10.2 Video Thumbnail

1. Create `<video>` element (offscreen) with file as `src`
2. `video.currentTime = 0.1` (seek to first frame)
3. Wait for `seeked` event
4. Draw to canvas, export as WebP

Takes ~100-500ms depending on codec and device.

### 10.3 Encryption Performance

AES-256-GCM is hardware-accelerated via Web Crypto API:
- 500KB image encrypt/decrypt: ~1-2ms
- 10MB video encrypt/decrypt: ~20-40ms
- Non-blocking (Web Crypto is async and runs off the main thread)

### 10.4 Cache Hit Rates

Expected behavior:
- Room re-entry within 10min: 90%+ cache hit for recently viewed media
- Scrolling through same conversation: 100% hit (media stays in cache)
- Initial load from message history: 0% hit (cache-as-you-scroll)

### 10.5 Memory Budget

- In-memory cache: 50 entries × ~1MB average = ~50MB baseline
- Video entries: 50MB each, so cache capacity reduces for large videos
- Total worst-case: ~500MB (if all 50 entries are 10MB videos)
- Mitigation: `maxEntries` can be dynamic based on actual sizes

---

## 11. Edge Case Analysis

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | **User selects very large image (20MP+)** | Canvas API handles it via `createImageBitmap` which decodes at full resolution, but the downscale to 1920px limits memory. SVG files rejected. |
| 2 | **User selects unsupported format (HEIC, TIFF)** | `createImageBitmap` doesn't support these → `optimizeImage` throws → caught error shown as "Unsupported image format" toast. |
| 3 | **Video codec not supported** | Thumbnail generation works (seeks to first frame), but playback depends on browser. The `<video>` element handles this — shown as unsupported message if codec missing. |
| 4 | **Upload fails mid-way** | Retry with new presigned URL (max 3 attempts, exponential backoff: 1s, 2s, 4s). If all fail, show error toast. |
| 5 | **Upload succeeds but WebSocket message fails** | Orphan object in R2. Show error toast. User can retry (re-upload). Future: TTL on objects. |
| 6 | **Room key lost mid-session** | Media becomes undecryptable. Same recovery flow as messages (recovery dialog → re-unlock room key → retry). |
| 7 | **CDN is slow/unreachable** | User sees loading skeleton indefinitely. Could add timeout (10s) → error state with retry button. |
| 8 | **IV doesn't match encrypted blob** | AES-GCM decrypt throws (authentication failure). Media marked as "Failed to load" with retry option. |
| 9 | **Message history contains media from before implementation** | Those messages won't have `messageType: "image"` or `"video"` — they'll be `messageType: "text"` with random ciphertext. `decryptMessage` will fail for those old messages and they'll be skipped by the existing try-catch in `decryptBatch`. No data loss. |
| 10 | **Multiple tabs open in same room** | Each tab has its own in-memory cache. No shared state — acceptable for MVP. Each tab fetches and caches independently. |
| 11 | **User revokes session/ticket while upload is in progress** | Presigned URL was already issued — upload completes. But WebSocket `send_message` fails (no valid ticket). Orphan object. |
| 12 | **R2 presigned URL expires before upload** | Upload fails with 403. Client requests new URL, retries. |
| 13 | **Image orientation (EXIF)** | Canvas `drawImage` ignores EXIF orientation. Need to apply EXIF rotation manually or accept that images may appear rotated. |
| 14 | **User pastes image from clipboard** | Could handle `paste` event on ChatInput's textarea. If clipboard contains an image file, treat it as media upload. Future feature. |
| 15 | **Video with no duration metadata** | `video.duration` returns NaN → fall back to `seek(0)`, use single frame at position 0. |
| 16 | **Concurrent uploads** | User can upload multiple images/videos simultaneously. Each gets its own presigned URL request, upload, and message send. No race conditions. |
| 17 | **Room disabled during upload** | Server rejects WebSocket `send_message` → error toast. File was already uploaded (orphan). |
| 18 | **User leaves room during upload** | Upload to R2 completes (independent of room membership). WebSocket send fails (server validates active membership). Orphan. |

---

## 12. File Change Summary

### New Files (5)

| # | File | Purpose |
|---|------|---------|
| 1 | `packages/frontend/src/lib/media-optimizer.ts` | Client-side image resize/WebP conversion, video thumbnail generation, file validation |
| 2 | `packages/frontend/src/lib/media-crypto.ts` | `encryptMedia(blob, roomKey)` and `decryptMedia(encryptedBuffer, roomKey, iv)` — binary AES-256-GCM using existing room key |
| 3 | `packages/frontend/src/lib/media-storage.ts` | Presigned URL request, R2 upload, CDN fetch, in-memory cache with abstraction interface, in-flight request deduplication, `useMediaLoader` hook |
| 4 | `packages/frontend/src/components/chat/media-message.tsx` | `MediaMessage` component: renders image inline or video with thumbnail + controls, manages loading/error states, handles blob URL lifecycle |
| 5 | `packages/frontend/src/app/api/media/upload-url/route.ts` | Next.js API route: validates auth + membership + room active, generates R2 presigned PUT URL, returns `{ uploadUrl, objectKey }` |

### Modified Files (11)

| # | File | Changes |
|---|------|---------|
| 6 | `packages/frontend/.env.example` | Add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`, `NEXT_PUBLIC_R2_PUBLIC_URL` |
| 7 | `packages/frontend/package.json` | Add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| 8 | `packages/frontend/src/lib/models.ts` | Add `ImageMetadata`, `VideoMetadata` interfaces. Update `RoomMessage.messageType` to include `"video"`. (Removed unused `"file"`) |
| 9 | `packages/frontend/src/lib/socket-client.ts` | Update `messageType` union to include `"video"` in `OutboundEncryptedMessage` and `RealtimeRoomMessage` |
| 10 | `packages/frontend/src/components/chat/chat-input.tsx` | Add image (`ImageIcon`) and video (`VideoIcon`) upload buttons with hidden file inputs. Add `onSendMedia` prop. Handle `onChange` for file inputs. |
| 11 | `packages/frontend/src/components/chat/message-list.tsx` | Update `UiMessage` interface: add `messageType` and `mediaMetadata`. Update `MessageBubble` to conditionally render `MediaMessage` for non-text messages. |
| 12 | `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Add `onSendMedia` handler: optimize → encrypt → get presigned URL → upload → send message. Update `decryptBatch` to parse media metadata. Pass `onSendMedia` to `ChatInput`. |
| 13 | `packages/websocket-server/src/index.ts` | Add `"video"` to `messageType` validation set. Optionally increase `MAX_ENVELOPE_FIELD_SIZE` to accommodate slightly larger encrypted metadata (though JSON metadata is typically <500 bytes, well under 8192). |
| 14 | `packages/websocket-server/src/db.ts` | Add `"video"` to `PersistEncryptedMessageInput.messageType` union. `fetchMessagesSince` already returns `messageType` from stored doc — no logic change needed. |
| 15 | `packages/frontend/src/lib/media-optimizer.ts` (define in new) | Already listed as new file #1 — this entry is intentionally blank. |
| 16 | `packages/frontend/next.config.ts` | If needed — check if `@aws-sdk/client-s3` imports need to be excluded from client bundle (since they're only used in API routes). Next.js automatically treeshakes API routes. |

### Summary Statistics

| Metric | Count |
|--------|-------|
| New files | 5 |
| Modified files | 11 |
| Total files changed | 16 |
| Frontend files | 14 |
| Server files | 2 |
| New dependencies | 2 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) |

---

## 13. Migration Plan

### Phase 1: Infrastructure Setup
1. Create Cloudflare R2 bucket
2. Configure CORS on bucket
3. Generate R2 API tokens
4. Add environment variables to `.env`

### Phase 2: Backend Changes
1. Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to frontend package
2. Create `POST /api/media/upload-url` API route
3. Update websocket server `messageType` validation
4. Update `PersistEncryptedMessageInput` type

### Phase 3: Client Libraries
1. `lib/media-crypto.ts` — encrypt/decrypt binary with room key
2. `lib/media-optimizer.ts` — image resize/WebP, video thumbnail
3. `lib/media-storage.ts` — cache, in-flight dedup, CDN fetch, `useMediaLoader` hook

### Phase 4: UI Integration
1. `MediaMessage` component — render image/video with loading states
2. `ChatInput` — upload buttons + file handlers
3. `MessageList` — conditionally render media messages
4. `RoomChatPage` — wire up media send flow, update decrypt batch

### Phase 5: Testing & Validation
1. Test upload flow end-to-end (optimize → encrypt → presigned URL → upload → message)
2. Test download flow (message → decrypt metadata → fetch CDN → decrypt blob → render)
3. Test cache hit/miss scenarios
4. Test error states (network failure, decryption failure, invalid file types)
5. Test concurrent uploads
6. Test message history with mixed text + media
7. Test mobile layout

### Rollback Plan

- **If R2 is unreachable**: Media upload fails, text messaging continues to work
- **If CDN is unreachable**: Media fails to load, text messages render normally
- **If incorrect bucket/credentials**: API route returns 500, client shows error toast
- **Full rollback**: Revert the 16 changed files. Media messages in history will fail to decrypt (since they're encrypted JSON, not plaintext) but existing text messages remain intact. Users see "Failed to load" for old media messages, which is acceptable.

### Backward Compatibility

- Old text messages: No change — `messageType: "text"` with encrypted plaintext continues to work
- Old clients: Will see media messages as unrenderable (the decrypted text will be JSON, which displays as-is in a text bubble). Since `messageType` is included in the message envelope, old clients could detect this and show "📷 Image" or "🎬 Video" placeholder instead of raw JSON.
- Media messages in history: Fully supported — the encrypted metadata is persisted in MongoDB just like any other message. Loading history fetches and decrypts metadata, then lazy-loads media from CDN.
