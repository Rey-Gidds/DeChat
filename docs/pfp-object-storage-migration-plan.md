# Architecture Document: Migration of User Profile Pictures to Object Storage

## 1. Executive Summary & Problem Statement

### 1.1 Problem Statement
In the initial implementation of DeChat, user profile pictures (`pfp`) were encoded directly as Base64 Data URLs (`data:image/...;base64,...`) and stored inline within the MongoDB `user` collection documents. 

This model creates severe architectural and performance bottlenecks:
1. **Database Bloat & BSON Overhead**: Storing up to 1 MB images as Base64 increases data size by ~33% (~1.33 MB per user document). MongoDB documents have a hard limit of 16 MB, and large user documents trigger frequent memory allocation, disk page swapping, and high cache evictions in WiredTiger.
2. **Session Serialization & Redis Cache Saturation**: User profiles are stored in session records cached in Upstash Redis and serialized across session verification layers. Storing megabyte Base64 strings in session caches rapidly exhausts Redis memory limits and inflates session network transfer overhead.
3. **Payload Inflation across Core APIs & WebSockets**:
   - `/api/rooms/[roomId]/members` returns complete member lists. If a room has 500 members with Base64 avatars, a single HTTP response can reach hundreds of megabytes.
   - Real-time WebSocket messages broadcast `senderPfp` alongside every chat message, repeatedly transmitting monolithic Base64 strings over socket frames for every single chat message sent.

### 1.2 Proposed Solution
Migrate user profile pictures to DeChat's object storage architecture (Cloudflare R2). Profile pictures are **unencrypted** because user avatars are public identity assets intended to be visible to all members and participants.

The client requests a presigned upload URL from the server, uploads the image binary directly to Cloudflare R2, and saves the object storage metadata in the user's document as a nested subdocument instead of the Base64 string. Clients fetch profile pictures directly from the public CDN / object storage, using the default avatar placeholder while loading.

---

## 2. High-Level Architecture & End-to-End Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Client (Web App)
    participant NextAPI as Next.js API (/api)
    participant S3 as Cloudflare R2 (Object Storage)
    participant CDN as Cloudflare CDN / Public URL
    participant Mongo as MongoDB
    participant Redis as Redis Cache
    participant WS as WebSocket Server

    rect rgb(240, 248, 255)
    note over User, S3: 1. Avatar Upload Flow (Direct to Object Storage)
    User->>NextAPI: 1. POST /api/me/pfp/upload-url (mimeType, size)
    NextAPI->>NextAPI: 2. Validate session, mimeType, and size (<= 2 MB)
    NextAPI->>Mongo: 3. Pre-assign or prepare metadata for user
    NextAPI-->>User: 4. Return presigned PUT URL + objectKey
    User->>S3: 5. Direct PUT image binary to Presigned URL (Content-Type: mimeType)
    User->>NextAPI: 6. POST /api/me/pfp/confirm (objectKey, mimeType, size)
    NextAPI->>Mongo: 7. Update user.pfp = PfpMetadata (nested doc)
    NextAPI->>Redis: 8. Invalidate / evict session cache
    NextAPI-->>User: 9. Return success + PfpMetadata
    end

    rect rgb(255, 248, 240)
    note over User, CDN: 2. Fetching & Rendering Members List / Chat Avatars
    User->>NextAPI: 10. GET /api/rooms/[roomId]/members
    NextAPI->>Mongo: 11. Query memberships & enrich with user.pfp (metadata)
    NextAPI-->>User: 12. Return members list with pfp metadata (instant, lightweight)
    User->>User: 13. Render Default Avatar placeholder immediately
    User->>CDN: 14. GET avatar from CDN URL (${CDN_URL}/${objectKey}) via <img>
    CDN-->>User: 15. Stream image binary; browser displays image natively
    end
```

---

## 3. Detailed Data Schemas

### 3.1 PFP Metadata Nested Document
Instead of a monolithic Base64 string, `pfp` becomes a lightweight nested subdocument in MongoDB:

```typescript
export interface PfpMetadata {
  type: "avatar";
  objectKey: string;     // Unique UUID in Cloudflare R2 bucket
  mimeType: string;      // "image/jpeg" | "image/png" | "image/webp" | "image/gif"
  size: number;          // Image size in bytes
  url?: string;          // Optional resolved public CDN URL (or derived on client)
  updatedAt: string;     // ISO timestamp
}
```

### 3.2 MongoDB User Schema Updates
In the `user` collection:
```typescript
interface UserDocument {
  _id: ObjectId;
  name: string;
  email: string;
  image?: string;
  publicKey?: string;
  encryptionEnabled?: boolean;
  // Previously: pfp?: string (Base64 data URL)
  // New Schema:
  pfp?: PfpMetadata | null;
  pfpNeedsReupload?: boolean; // Flag set during migration
  createdAt: Date;
  updatedAt: Date;
}
```

### 3.3 BetterAuth Configuration (`packages/frontend/src/lib/auth.ts`)
Update BetterAuth's `additionalFields` mapping:
```typescript
user: {
  additionalFields: {
    publicKey: { type: "string", required: false },
    pfp: { type: "object", required: false }, // Store nested PfpMetadata
    encryptionEnabled: { type: "boolean", required: false },
    pfpNeedsReupload: { type: "boolean", required: false },
  },
}
```

### 3.4 Session & Redis Cache Representation
When sessions are stored in Upstash Redis (`session:<token>`), the `user` object in the cached session payload now only contains the lightweight `PfpMetadata` (~120 bytes) instead of Base64 strings (~1.3 MB).

```json
{
  "session": {
    "user": {
      "id": "65e0a12f9b8c123456789abc",
      "name": "Alice",
      "email": "alice@example.com",
      "pfp": {
        "type": "avatar",
        "objectKey": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "mimeType": "image/webp",
        "size": 48210,
        "updatedAt": "2026-09-05T01:14:00.000Z"
      }
    }
  }
}
```

---

## 4. Object Storage & Upload Workflow

### 4.1 Presigned Upload Endpoint (`POST /api/me/pfp/upload-url`)
1. **Authentication**: Authenticate using `requireSession(req)`.
2. **Payload Validation**:
   - `mimeType`: Must be one of `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
   - `size`: Must be positive and $\le$ 2 MB.
3. **Generate Object Key**:
   - Format: `avatars/${userId}/${crypto.randomUUID()}` (or a flat UUID `avatars/${crypto.randomUUID()}`).
4. **Presigned URL Generation**:
   - Use AWS SDK S3 `PutObjectCommand` targeting the Cloudflare R2 bucket with `ContentType: mimeType`.
   - Set expiry to 300 seconds (5 minutes).
5. **Response**: Return `{ uploadUrl, objectKey }`.

### 4.2 Direct Upload from Client
1. User selects image file in profile settings.
2. Optional client-side compression/resize (e.g., max 512×512 resolution).
3. Client requests presigned URL via `POST /api/me/pfp/upload-url`.
4. Client uploads raw binary directly using `fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } })`.
5. Upon successful HTTP 200/204 response from R2, client confirms upload.

### 4.3 Confirmation Endpoint (`POST /api/me/pfp/confirm`)
1. Client sends `{ objectKey, mimeType, size }`.
2. Server verifies `objectKey` belongs to the avatar namespace and updates MongoDB:
   ```typescript
   const pfpMetadata: PfpMetadata = {
     type: "avatar",
     objectKey,
     mimeType,
     size,
     updatedAt: new Date().toISOString(),
   };

   await db.collection("user").updateOne(
     { _id: userId },
     { 
       $set: { pfp: pfpMetadata },
       $unset: { pfpNeedsReupload: "" } 
     }
   );
   ```
3. Server calls `invalidateCachedSession(...)` to purge Redis session cache and invalidate session data cookies.
4. Returns `{ ok: true, pfp: pfpMetadata }`.

---

## 5. Session Invalidation, Data Migration & Re-upload Notification

### 5.1 Comprehensive Invalidation & Reset Strategy
Because legacy sessions, cookies, and Redis caches contain Base64 strings:
1. **Database Field Reset**:
   - Run a migration script to clear all legacy Base64 strings and mark users for re-upload:
     ```javascript
     // Update all users who currently have a string or non-null legacy pfp
     await db.collection("user").updateMany(
       { pfp: { $exists: true, $type: "string" } },
       { 
         $set: { pfp: null, pfpNeedsReupload: true } 
       }
     );
     ```
2. **Session Invalidation**:
   - Invalidate all active sessions in MongoDB:
     ```javascript
     await db.collection("session").deleteMany({});
     ```
   - Flush / evict all Redis session keys (`session:*`) to ensure no stale Base64 data remains in memory.
   - All users are safely logged out and must log in again.

### 5.2 One-Time User Re-upload Notification
1. Following login, `/api/me` returns `pfpNeedsReupload: true` if the user's avatar was cleared during migration.
2. The frontend displays a one-time toast/banner:
   - *"Notice: We've upgraded profile picture storage for faster loading. Please re-upload your profile picture."*
3. Once the user uploads a new profile picture (or dismisses the notification), `pfpNeedsReupload` is cleared.

---

## 6. API, WebSocket, & Cache Upgrades

### 6.1 Room Members API (`/api/rooms/[roomId]/members`)
- **Old Behavior**: Returned `user.pfp` as an inline Base64 data URL string.
- **New Behavior**: Returns `user.pfp` as `PfpMetadata | null`.
- **Performance Impact**: Member list response payload drops by **>99%** (e.g. from 50 MB down to < 50 KB for large rooms), drastically improving room loading speed and reducing bandwidth.

### 6.2 WebSocket Server (`websocket-server`)
- `getSenderInfo(roomId, userId)` extracts `user.pfp` as `PfpMetadata | null`.
- Outbound socket messages (`message:new`, `message:edit`) transmit `senderPfp: PfpMetadata | null`.
- Socket frames remain minimal and predictable.

### 6.3 Redis Caching Strategy
- Redis session key `session:<token>` stores only the structured `PfpMetadata`.
- In-memory WebSocket user cache stores `PfpMetadata`.
- No media binary data or Base64 strings ever touch Redis.

---

## 7. Client-Side Rendering & CDN Resolution

### 7.1 CDN URL Resolution
Because the avatars are unencrypted and stored in Cloudflare R2, they can be served directly through Cloudflare's edge CDN:
```typescript
export function getAvatarUrl(pfp?: PfpMetadata | string | null): string | null {
  if (!pfp) return null;
  // Backward compatibility check for legacy string URLs
  if (typeof pfp === "string") {
    return pfp.startsWith("http") || pfp.startsWith("data:") ? pfp : null;
  }
  const cdnBase = process.env.NEXT_PUBLIC_R2_PUBLIC_URL || "";
  return `${cdnBase}/${pfp.objectKey}`;
}
```

### 7.2 Avatar Component with Placeholder (`Avatar.tsx`)
1. **Placeholder State**:
   - While the image is loading, or if the user has no avatar, display the default fallback avatar (`<User />` icon with styled neutral background).
2. **Native Browser Caching**:
   - By using standard CDN URLs with `<img>`, the browser natively handles HTTP caching (via `Cache-Control: public, max-age=31536000, immutable`), reducing redundant network requests automatically without complex custom decryption logic.

```tsx
export function Avatar({ pfp, size = 32, className }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const avatarUrl = getAvatarUrl(pfp);

  if (!avatarUrl || error) {
    return (
      <div
        className={`shrink-0 flex items-center justify-center rounded-full bg-neutral-800 ${className ?? ""}`}
        style={{ width: size, height: size }}
      >
        <User size={Math.round(size * 0.5)} className="text-neutral-500" />
      </div>
    );
  }

  return (
    <div
      className={`relative shrink-0 rounded-full overflow-hidden ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {/* Fallback placeholder while image loads */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-800">
          <User size={Math.round(size * 0.5)} className="text-neutral-500" />
        </div>
      )}
      <img
        src={avatarUrl}
        alt="Avatar"
        className={`w-full h-full object-cover transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        loading="lazy"
      />
    </div>
  );
}
```

---

## 8. Verification & Rollout Plan

### 8.1 Automated & Manual Testing
1. **Upload & Confirm API Tests**:
   - Verify `POST /api/me/pfp/upload-url` validates MIME types and file size ($\le$ 2 MB).
   - Verify `POST /api/me/pfp/confirm` stores `PfpMetadata` correctly and unsets `pfpNeedsReupload`.
2. **Session Invalidation Verification**:
   - Confirm active session records in MongoDB and Redis are cleared.
   - Confirm previously logged-in client receives 401 and is redirected to login.
3. **Members List & WebSocket Verification**:
   - Test `/api/rooms/[roomId]/members` returns `PfpMetadata` objects.
   - Verify WebSocket messages contain lightweight `senderPfp` objects.
   - Verify avatar images load seamlessly from R2 CDN URL with default placeholder fallback during network fetch.

### 8.2 Migration Steps
1. Deploy updated backend endpoints (`/api/me/pfp/upload-url`, `/api/me/pfp/confirm`).
2. Run database migration script:
   - Empty `pfp` fields on all users and set `pfpNeedsReupload: true`.
   - Delete all documents in `session` collection.
   - Flush Upstash Redis session cache.
3. Deploy frontend changes (`Avatar` CDN resolution, placeholder handling, re-upload notification).
