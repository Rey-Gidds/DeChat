# Media Sharing Setup & Architecture Guide

This guide explains how to configure Cloudflare R2 for media sharing in DeChat, where to retrieve the necessary environment variables, and the detailed lifecycle flow for image and video uploads. It also details current architecture limits and potential implementation issues.

---

## 1. Cloudflare R2 Configuration & Credentials

To enable media sharing, you must configure a Cloudflare R2 bucket. Below is the step-by-step procedure to set up the bucket and retrieve the variables needed for your `packages/frontend/.env.local` file.

### Step 1: Create an R2 Bucket
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **R2** from the left-hand navigation menu.
3. Click **Create bucket**.
4. Name your bucket (e.g., `chat-media` or `dechat-media`).
5. Keep other settings default and click **Create bucket**.

### Step 2: Configure CORS (Cross-Origin Resource Sharing)
Since users upload files directly from their browsers (e.g., `http://localhost:3000`) to Cloudflare R2 via presigned URLs, you must configure a CORS policy to allow these requests:
1. In your R2 bucket dashboard, go to the **Settings** tab.
2. Scroll down to the **CORS Policy** section and click **Add CORS policy** (or Edit CORS policy).
3. Paste the following JSON configuration:
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "https://your-production-domain.com"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["Content-Type", "*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   *Note: For local development, you can use `"*"` in `AllowedOrigins`, but restrict it to your actual domains in production.*

### Step 3: Enable Public Read Access (CDN URL)
Since the media files are encrypted client-side before upload, they are mathematically secure even if stored in a public bucket. Enabling public read access allows the client to fetch them directly without complex presigned download URL generation:
1. In the R2 bucket dashboard, go to the **Settings** tab.
2. Scroll down to **Public Access**.
3. Under **r2.dev Subdomain**, click **Allow Access** to enable the default Cloudflare R2 public URL (e.g., `https://pub-xxxxxx.r2.dev`).
4. Alternatively, you can connect a **Custom Domain** (e.g., `media.dechat.app`) which is highly recommended for production environments to bypass default rate limits.
5. Copy this URL (without a trailing slash) — this will be used for `NEXT_PUBLIC_R2_PUBLIC_URL`.

### Step 4: Generate API Tokens for the Server
The Next.js backend requires API credentials to generate presigned upload URLs:
1. Navigate back to the main **R2** dashboard page in Cloudflare.
2. On the right-hand sidebar, click **Manage R2 API Tokens**.
3. Click **Create API token**.
4. Configure the token:
   - **Token name**: `dechat-media-token`
   - **Permissions**: Select **Edit** or **Admin Read & Write** (must have permissions to perform `PutObject` operations).
   - **TTL**: Select your preferred expiration (or leave it active indefinitely for production).
5. Click **Create API Token**.
6. **CRITICAL**: Copy the credentials immediately. You will be shown:
   - **Access Key ID** (`R2_ACCESS_KEY_ID`)
   - **Secret Access Key** (`R2_SECRET_ACCESS_KEY`)
   - **Account ID** (`R2_ACCOUNT_ID` - can also be copied from the URL or main R2 page).

---

## 2. Environment Variables Reference

Update your `packages/frontend/.env.local` file with the values retrieved above:

```env
# Cloudflare R2 (E2EE media file storage)
R2_ACCESS_KEY_ID=your_copied_access_key_id
R2_SECRET_ACCESS_KEY=your_copied_secret_access_key
R2_BUCKET_NAME=chat-media
R2_ACCOUNT_ID=your_copied_cloudflare_account_id
NEXT_PUBLIC_R2_PUBLIC_URL=https://pub-xxxxxx.r2.dev
```

---

## 3. Media Upload & Download Lifecycle Flow

DeChat uses a privacy-first, **client-side End-to-End Encrypted (E2EE)** media sharing architecture. Raw media bytes never touch the application server and are never stored in MongoDB.

### A. Image Upload Flow

```
[Browser Client]                                  [Next.js Server]            [Cloudflare R2]
   │                                                     │                           │
   ├── 1. Select image (File)                            │                           │
   ├── 2. Optimize client-side (to WebP)                 │                           │
   ├── 3. Encrypt WebP blob (AES-256-GCM)                │                           │
   │                                                     │                           │
   ├── 4. POST /api/media/upload-url ───────────────────>│                           │
   │      (Validate membership, auth, size)              ├── 5. Init S3 Client       │
   │                                                     ├── 6. Create presigned URL │
   │<────────────────────────────────────────────────────└── (expires in 5 min)      │
   │                                                     │                           │
   ├── 7. PUT Encrypted Blob (application/octet-stream) ────────────────────────────>│
   │                                                     │                           │
   ├── 8. Encrypt metadata JSON string (with Room Key)   │                           │
   ├── 9. Send "image" message via WebSockets ──────────>│ (WS Server saves to DB &  │
   │                                                     │  broadcasts metadata)     │
```

1. **User Action**: The user selects an image via the input. `onSendMedia(file)` is invoked in [page.tsx](file:///packages/frontend/src/app/rooms/[roomId]/page.tsx).
2. **Client-Side Optimization**: The raw file is passed to `optimizeImage(file)` in [media-optimizer.ts](file:///packages/frontend/src/lib/media-optimizer.ts). It decodes the image, downscales it to a maximum of 1920px (longest side) maintaining aspect ratio, and exports it as an optimized `image/webp` blob.
3. **Encryption**: The WebP blob is converted to an `ArrayBuffer` and encrypted client-side using the room's AES key via the Web Crypto API (`AES-256-GCM`). A random 12-byte Initialization Vector (IV) is generated.
4. **Presigned URL Request**: The client requests a presigned PUT upload URL from `/api/media/upload-url` on the Next.js server, passing the room ID, mimeType, and size.
5. **Server Verification**: The Next.js API route [route.ts](file:///packages/frontend/src/app/api/media/upload-url/route.ts):
   - Verifies the user is authenticated and has an `APPROVED` active room membership.
   - Verifies the room is active and not disabled.
   - Enforces a 10MB image limit.
   - Generates a unique UUID as the object key.
   - Generates an S3 presigned PUT URL with a 5-minute expiration and `ContentType` hardcoded to `"application/octet-stream"`.
6. **Direct Upload**: The client performs a `PUT` request with the encrypted binary payload directly to the Cloudflare R2 bucket.
7. **Metadata & WS Broadcast**: The client constructs an `ImageMetadata` object containing the `objectKey`, `mimeType` ("image/webp"), dimensions, and the base64-encoded IV. It encrypts this metadata JSON string with the room key and sends a WebSocket event containing the ciphertext to the server with `messageType: "image"`. The WebSocket server stores it in MongoDB and broadcasts it to all other room members.

---

### B. Video Upload Flow

Because video files are larger and transcoding them in the browser via WebAssembly (e.g., `ffmpeg.wasm`) is CPU-heavy, DeChat uses a hybrid approach: **videos are uploaded as-is, but a fast thumbnail is generated and encrypted separately.**

1. **User Action**: The user selects a video.
2. **Thumbnail Generation**: `generateVideoThumbnail(file)` in [media-optimizer.ts](file:///packages/frontend/src/lib/media-optimizer.ts) seeks to 10% of the video duration, draws the frame onto a canvas, downscales it to max 640px, and exports it as an `image/webp` thumbnail blob.
3. **Thumbnail Upload**:
   - The thumbnail is encrypted with the room AES key.
   - The client requests a presigned URL for the thumbnail and uploads the encrypted thumbnail to R2, obtaining a `thumbnailKey` and `thumbnailIv`.
4. **Main Video Encryption & Upload**:
   - The original video file (without client-side optimization) is converted to an `ArrayBuffer` and encrypted with the room AES key.
   - The client requests a presigned upload URL from the server (with a 100MB video size limit check).
   - The encrypted video is uploaded directly to R2.
5. **Metadata & WS Broadcast**: The client constructs a `VideoMetadata` object containing the video's `objectKey`, `mimeType`, dimensions, duration, video `iv`, and references to the `thumbnailKey` and `thumbnailIv`. This metadata is encrypted as a JSON string and sent over WebSockets with `messageType: "video"`.

---

### C. Media Downloading & Rendering Flow

```
[Receiving Client]                                 [Cloudflare R2 CDN]
   │                                                       │
   ├── 1. Receive WebSocket message                        │
   ├── 2. Decrypt message body with Room Key               │
   │      (Get objectKey, iv, mimeType)                    │
   │                                                       │
   ├── 3. GET https://<public-url>/<objectKey> ───────────>│
   │<──────────────────────────────────────────────────────└── (Serves encrypted bytes)
   │                                                       │
   ├── 4. Decrypt binary bytes (AES-256-GCM)               │
   ├── 5. URL.createObjectURL(decryptedBlob)               │
   └── 6. Render <img> or <video>                          │
```

1. **WS Event / History Load**: The client receives a message of type `"image"` or `"video"`.
2. **Decryption**: The client decrypts the message body (the JSON metadata) using the room key.
3. **Lazy Loading**: The [MediaMessage](file:///packages/frontend/src/components/chat/media-message.tsx) component mounts. It uses the `useMediaLoader` hook to load the media:
   - Checks the local in-memory cache for a match.
   - If not cached, it checks for a duplicate in-flight network request.
   - Fetches the encrypted raw bytes from `https://<public-url>/<objectKey>`.
   - Decrypts the binary bytes using the room key and the IV stored in the message metadata.
   - Stores the decrypted blob in the memory cache.
   - Creates a local blob URL (`URL.createObjectURL(decryptedBlob)`).
4. **Render**: The component assigns the blob URL to the `src` attribute of the `<img />` or `<video />` tag. (For videos, the decrypted thumbnail URL is used as the `poster` attribute).
5. **Cleanup**: When the component unmounts, the blob URL is revoked to prevent memory leaks.

---

## 4. Discovered Issues & Recommendations

During verification of the current implementation, the following potential bugs, limitations, and issues were identified:

### 1. Web Server Production Build Sync (`dist` vs `src`)
- **Issue**: The pre-compiled JavaScript server file [packages/websocket-server/dist/index.js](file:///packages/websocket-server/dist/index.js) does not include `"video"` in the permitted `messageType` check (it still lists `["text", "image", "file", "gif"]`).
- **Effect**: If you run the WebSocket server in production mode (`npm run start`), the server will reject video uploads with an `"Invalid messageType"` error.
- **Resolution**: Make sure to rebuild the websocket server using `npm run build:server` whenever changes are pulled, or run in development mode (`npm run dev:server`).

### 2. Race Condition in `useMediaLoader` Hook
- **Issue**: The [useMediaLoader](file:///packages/frontend/src/lib/media-storage.ts#L293-L359) hook uses a single component-level ref `mountedRef` to prevent state updates after unmount. When the hook's parameters (like `objectKey`) change, the cleanup function sets `mountedRef.current = false`, but the subsequent render re-initializes it to `true`. An older in-flight request can resolve *after* the new request starts, causing a race condition where the older image/video overrides the new one because both check the same `mountedRef.current` state.
- **Resolution**: Use a local boolean variable inside the `useEffect` closure (e.g., `let active = true;` and set `active = false` in the cleanup) to ensure only the latest request updates the state.

### 3. Orphan Objects in Cloudflare R2
- **Issue**: There is no cleanup or cleanup-on-failure logic for orphaned files. If the client successfully uploads the encrypted media to R2 but the subsequent WebSocket message fails to send (due to network disruption, room deletion, or session logout), the file is left in R2 indefinitely.
- **Resolution**: Implement a lifecycle policy on the Cloudflare R2 bucket to clean up objects older than a certain period, or build a backend task to prune unreferenced object keys.

### 4. Dead Code in Storage Layer
- **Issue**: The function `uploadToR2` in [media-storage.ts](file:///packages/frontend/src/lib/media-storage.ts#L158-L231) is defined but never exported or called. The actual upload logic is written directly inside `onSendMedia` in [page.tsx](file:///packages/frontend/src/app/rooms/[roomId]/page.tsx).
- **Resolution**: Clean up the unused `uploadToR2` code to avoid developer confusion.

### 5. Lack of Video Transcoding
- **Issue**: Videos are uploaded as-is without client-side compression or transcoding.
- **Effect**: If a user uploads an unsupported file format or codec (like some `.mov` or `.avi` files), the video may fail to play back on other users' browsers. Large files will also consume significant bandwidth and take longer to decrypt.
- **Resolution**: Restrict video uploads to web-compatible formats (`video/mp4`, `video/webm`) and add client-side file size restrictions before starting the encryption step.
