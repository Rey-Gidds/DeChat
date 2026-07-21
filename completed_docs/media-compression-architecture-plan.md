# DeChat Media Compression & Pipeline Architecture — Design Plan

**Status:** Design only (no implementation).  
**Date:** 2026-07-16  
**Scope:** Redesign media compression behind a platform abstraction layer, add progressive video playback, EXIF/metadata stripping, and a minimalist caption + preview UI — while keeping the end-to-end encrypted (E2EE) R2 upload pipeline intact.

---

## 0. Executive Summary

The current DeChat media path is a **pure browser PWA**:

- Images are re-encoded to WebP client-side (`createImageBitmap` + `OffscreenCanvas`).
- **Videos are uploaded uncompressed** — only a WebP thumbnail is generated. No transcoding happens today.
- Everything is encrypted with the room AES-256-GCM key, uploaded to Cloudflare R2 via a presigned PUT URL, and only the encrypted metadata JSON travels over WebSocket.
- There is **no Capacitor**, no native detection, no caption, and no pre-upload preview UI.

This plan introduces a **`MediaCompressor` abstraction** so the compression backend is selected transparently by runtime platform:

| Runtime | Backend | Engine | Target |
|---|---|---|---|
| Capacitor Android | Native Kotlin plugin | `MediaCodec` + `MediaExtractor` + `MediaMuxer` (hardware) | H.264 MP4 |
| Capacitor iOS | Native Swift plugin | `AVFoundation` (`AVAssetReader`/`AVAssetWriter`/`AVAssetExportSession`) | H.264 MP4 |
| Browser (web) | `@ffmpeg/ffmpeg` v0.12 (WASM, multi-thread) | Software, self-hosted MT core | H.264 MP4 |

The React/Next.js layer never knows which backend runs. It calls a single async API: `compressMedia(file)`.

Supporting changes:
- **Progressive video playback** via R2 HTTP Range + Media Source Extensions (MSE), decrypting chunks as they stream.
- **Metadata stripping** — automatic via re-encode for video; explicit strip for any passthrough image path.
- **Caption** added as an optional `caption` field on `ImageMetadata`/`VideoMetadata`, encrypted inside the existing metadata JSON.
- **Minimalist preview + caption + send UI** matching the existing app theme, replacing the current "pick → instantly send" flow.
- **Per-file pipelining**: each file independently flows compress → encrypt → upload as soon as it finishes, overlapping transcoding with network transfer.

---

## 1. Current Pipeline (Baseline — What Exists Today)

### 1.1 File selection
`packages/frontend/src/components/chat/chat-input.tsx`
- Two hidden `<input type="file">`: `imageInputRef` (`accept="image/*"`), `videoInputRef` (`accept="video/*"`).
- `+` attach menu → `handleImageSelect` / `handleVideoSelect` → calls `onSendMedia(file)` immediately, then clears input.

### 1.2 Compression (browser-only)
`packages/frontend/src/lib/media-optimizer.ts`
- `optimizeImage(file)`: bitmap → `OffscreenCanvas`, longest side capped at **1920px** → `convertToBlob({ type: "image/webp", quality: 0.8 })` → `{ blob, width, height, mimeType: "image/webp" }`.
- `generateVideoThumbnail(file)`: `<video>` on blob URL → seek to 10% → `OffscreenCanvas` max 640px → WebP 0.7. **Raw video uploaded as-is.**
- Validators `isSupportedImage` / `isSupportedVideo`.

### 1.3 Encryption
`packages/frontend/src/lib/media-crypto.ts`
- `encryptMedia(plaintext: ArrayBuffer, roomKey: CryptoKey)` → AES-256-GCM, random 12-byte IV → `{ encrypted: ArrayBuffer, iv: base64 }`. Reuses the room key.

### 1.4 Presigned URL + R2
`packages/frontend/src/app/api/media/upload-url/route.ts`
- Validates session, room active, membership approved/non-blocked.
- Limits: image ≤10MB, video ≤100MB; only `image/*` / `video/*`.
- `objectKey = crypto.randomUUID()`.
- `S3Client` (`@aws-sdk/client-s3`) → `endpoint: https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, `region: "auto"`.
- `getSignedUrl(PutObjectCommand({ Bucket, Key, ContentType: "application/octet-stream" }), { expiresIn: 300 })`.
- Returns `{ uploadUrl, objectKey }`.

`packages/frontend/src/lib/media-storage.ts`
- `requestUploadUrl(roomId, mimeType, size)` → POST `/api/media/upload-url`.
- `uploadEncryptedBlob(uploadUrl, encryptedBlob)` → `fetch(uploadUrl, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" } })`.
- `useMediaLoader(objectKey, roomKey, iv, mimeType, thumbnailObjectKey?, thumbnailIv?)` → LRU + in-flight dedup → `fetch(CDN/objectKey)` → `arrayBuffer()` → `decryptMedia` → `URL.createObjectURL`. Currently fetches the **entire** object.

### 1.5 Data types
`packages/frontend/src/lib/models.ts`
```ts
interface ImageMetadata { type:"image"; objectKey; mimeType; width; height; size; iv }
interface VideoMetadata { type:"video"; objectKey; mimeType; width; height; size; thumbnailKey; thumbnailIv; duration?; iv }
type MediaMetadata = ImageMetadata | VideoMetadata;
```

### 1.6 Orchestration
`packages/frontend/src/app/rooms/[roomId]/page.tsx` → `onSendMedia(file)`:
1. Resolve `roomKey = await getRoomKeyVersion(roomId, currentKeyVersion)`.
2. Image: `optimizeImage` → encrypt. Video: encrypt raw + separately encrypt/upload WebP thumbnail.
3. Build metadata; `encryptMessage(JSON.stringify(metadata), roomKey)` → `sendEncryptedMessage({ roomId, clientMessageId, ..., messageType: "image"|"video" })`.

**Key gaps:** no transcoding, no caption, no preview, no native platform, no progressive playback.

---

## 2. Target Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  React / Next.js (platform-independent)                      │
│                                                              │
│  chat-input → MediaPreviewDialog ──▶ onSendMedia(file,cap)   │
│                                              │               │
│                          compressMedia(file) │  ◀── single async API
│                                              ▼               │
│                    ┌────────────────────────────────────┐   │
│                    │     MediaCompressor (interface)     │   │
│                    │  selectBackend() by runtime         │   │
│                    └────────────────────────────────────┘   │
│                       │            │            │            │
│         ┌─────────────┘            │            └──────────┐ │
│         ▼                          ▼                       ▼ │
│  BrowserBackend            AndroidBackend            iOSBackend│
│  (@ffmpeg/ffmpeg WASM)     (Capacitor Kotlin)       (Capacitor│
│                               MediaCodec/Extract/    Swift    │
│                               Muxer)                AVFoundation
│         │                          │                       │ │
│         └─────────────┬────────────┘            ────────────┘ │
│                       ▼                                       │
│   per-file pipeline: compress → encryptMedia → uploadR2       │
│   (independent per file; overlap CPU + network)               │
└─────────────────────────────────────────────────────────────┘
                       │  WS carries ONLY encrypted metadata
                       ▼
   Receiver: useMediaLoader → (Range fetch) → decrypt chunk → MSE
```

---

## 3. The `MediaCompressor` Abstraction

### 3.1 Interface
`packages/frontend/src/lib/media/compressor.ts`
```ts
export interface CompressOptions {
  kind: "image" | "video";
  /** Max longest-edge for images (px). Default 1920. */
  maxEdge?: number;
  /** Target video height (px). Default 720. */
  targetHeight?: number;
  /** 0–1 or CRF-style quality. Backend-specific mapping. */
  quality?: number;
  /** Optional onProgress for UX (0–1). */
  onProgress?: (p: number) => void;
}

export interface CompressResult {
  blob: Blob;            // compressed, metadata-stripped
  width: number;
  height: number;
  mimeType: string;      // image/webp or video/mp4
  durationMs?: number;   // video only
  thumbnailBlob?: Blob;  // video only: WebP poster
}

export interface MediaCompressor {
  readonly platform: "browser" | "android" | "ios";
  isAvailable(): boolean;
  compressMedia(file: File, opts?: CompressOptions): Promise<CompressResult>;
}
```

### 3.2 Backend selection (transparent)
`packages/frontend/src/lib/media/index.ts`
```ts
export function getMediaCompressor(): MediaCompressor {
  if (typeof window !== "undefined" && (window as any).Capacitor?.isNativePlatform?.()) {
    const plt = (window as any).Capacitor.getPlatform();
    if (plt === "android") return new AndroidMediaCompressor();
    if (plt === "ios")     return new IOSMediaCompressor();
  }
  return new BrowserMediaCompressor(); // default + WebCodecs-ready
}
```
- React layer imports only `compressMedia` re-export:
  `export const compressMedia = (f, o) => getMediaCompressor().compressMedia(f, o);`
- **Extensibility:** adding WebCodecs later = new `BrowserWebCodecsCompressor` implementing `MediaCompressor`, selected inside `getMediaCompressor()` when `window.VideoEncoder` exists. No UI/business-logic changes.

### 3.3 Browser backend (ffmpeg.wasm v0.12)
`packages/frontend/src/lib/media/browser-compressor.ts`
- Package: `@ffmpeg/ffmpeg` ^0.12 + `@ffmpeg/util` + `@ffmpeg/core-mt` (multi-thread).
- **Self-host** the core (`ffmpeg-core.js`/`.wasm`/`.worker.js`) under `public/ffmpeg/` (avoids CDN/COOP-COEP issues; faster, offline-capable). Set `SharedArrayBuffer` via `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (Next config headers on the media routes / document).
- Load lazily (dynamic `import()`), only when a video/image > threshold, to keep initial bundle small.
- **Video command (H.264 MP4, metadata stripped):**
  ```
  -i input -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset veryfast
  -crf 28 -c:a aac -b:a 128k -movflags +faststart -map_metadata -1 output.mp4
  ```
  `-map_metadata -1` guarantees EXIF/location/thumb stripping.
- **Image (WebP) command:**
  ```
  -i input -vf scale='min(1920,iw)':-2 -map_metadata -1 -quality 80 output.webp
  ```
- **Thumbnail:** derive from compressed video via `-ss 10% -frames:v 1 ... output.webp` (or reuse `generateVideoThumbnail` on the compressed blob).
- Progress mapped from ffmpeg `progress` events → `onProgress`.
- **Performance note (documented):** 1-min 212 MB → ~15 MB; browser software transcode ~30–90s; native hardware ~10–20s on flagship devices.

### 3.4 Android backend (Capacitor Kotlin plugin) — stubbed in plan, real impl when Capacitor added
`capacitor-plugins/android/media-compressor/src/.../MediaCompressorPlugin.kt`
- `@CapacitorPlugin(name = "MediaCompressor")` → `compress(options)` returns base64/blob path + dims + thumbnail path.
- Internals: `MediaExtractor` reads tracks → select video/audio → `MediaCodec` `createEncoderByType("video/avc")` with `COLOR_FormatSurface` (surface input) or `COLOR_FormatYUV420Flexible`; `MediaMuxer` writes `.mp4`. Adaptive: probe source resolution/bitrate, choose target height (720p default) + bitrate; hardware-accelerated encoder selected automatically by `MediaCodecList`.
- Metadata stripped inherently (new mux, no copy of source metadata).
- Exposes thumbnail via `MediaMetadataRetriever.getFrameAtTime`.
- Bridge: `Capacitor.addListener`/Promise resolves `CompressResult` to the web layer.

### 3.5 iOS backend (Capacitor Swift plugin) — stubbed in plan
`capacitor-plugins/ios/Plugin/MediaCompressorPlugin.swift`
- `@objc(MediaCompressorPlugin)` → `compress(_ call:)`.
- Preferred: `AVAssetReader` (reader tracks) + `AVAssetWriter` (writer with `AVVideoCodecType.h264`, `AVOutputSettingsAssistant` for adaptive bitrate) → hardware-accelerated. Fallback `AVAssetExportSession` with `preset = .hevc1920x1080`/`.h264` + `exportAsynchronously`.
- `AVMutableMetadataItem` cleared (empty metadata array) → strip.
- Thumbnail via `AVAssetImageGenerator`.
- Returns same `CompressResult` shape.

### 3.6 Metadata stripping policy (decided)
- **Video:** stripping is **implicit** as a side effect of re-encode (`-map_metadata -1` / fresh mux / cleared `AVMutableMetadataItem`). No separate pass.
- **Images that are re-encoded** (all browser video thumbnails, and any image run through ffmpeg): stripped by re-encode.
- **Images that would be passthrough** (future lossless path): add an explicit strip step (re-save via canvas/ffmpeg copy-without-meta). Documented as a guard so no EXIF ever leaves the device.

---

## 4. Per-File Pipelined Send Flow (overlapping compress/encrypt/upload)

Replace the single `onSendMedia` with a fan-out over selected files:

`packages/frontend/src/app/rooms/[roomId]/page.tsx` (new `onSendMedia`)
```ts
async function pipelineOne(file: File, caption?: string) {
  const roomKey = await getRoomKeyVersion(roomId, currentKeyVersion);
  const { blob, width, height, mimeType, durationMs, thumbnailBlob } =
    await compressMedia(file, { kind: isVideo(file) ? "video" : "image", onProgress });

  // thumbnail first (parallel-safe, independent object)
  let thumb = undefined;
  if (thumbnailBlob) {
    const tEnc = await encryptMedia(await thumbnailBlob.arrayBuffer(), roomKey);
    const tUrl = await requestUploadUrl(roomId, "image/webp", tEnc.encrypted.byteLength);
    await uploadEncryptedBlob(tUrl.uploadUrl, new Blob([tEnc.encrypted]));
    thumb = { thumbnailKey: tUrl.objectKey, thumbnailIv: tEnc.iv };
  }

  const enc = await encryptMedia(await blob.arrayBuffer(), roomKey);
  const url = await requestUploadUrl(roomId, mimeType, enc.encrypted.byteLength);
  await uploadEncryptedBlob(url.uploadUrl, new Blob([enc.encrypted]));

  const meta: MediaMetadata = {
    type: isVideo(file) ? "video" : "image",
    objectKey: url.objectKey, mimeType, width, height,
    size: enc.encrypted.byteLength, iv: enc.iv,
    duration: durationMs, caption, ...thumb,
  };
  const enc2 = await encryptMessage(JSON.stringify(meta), roomKey);
  await sendEncryptedMessage({ roomId, clientMessageId: crypto.randomUUID(),
    ...enc2, roomKeyVersion, messageType: meta.type, replyTo });
}

// Fire all, don't await sequentially — each pipelines independently
files.map(f => pipelineOne(f, caption).catch(report));
```

- Each file proceeds compress → encrypt → upload the **moment it finishes compression**, regardless of siblings. CPU transcoding of file N+1 overlaps network upload of file N.
- UI shows per-file progress (from `onProgress`) inside the preview dialog until all resolve.

---

## 5. Progressive (Incremental) Video Playback

Current `useMediaLoader` fetches the whole encrypted object. New design streams + decrypts via Range + MSE.

`packages/frontend/src/lib/media-storage.ts` (extend `useMediaLoader`)
- Detect video + browser `MediaSource.isTypeSupported`.
- **Step 1 — probe:** `HEAD`/`GET` with `Range: bytes=0-0` to read `Content-Range` / `Content-Length` → total encrypted size. (R2 supports Range on objects.)
- **Step 2 — chunked fetch:** loop requesting `Range: bytes=start-end` (e.g., 1–2 MB segments). For each segment: `arrayBuffer()` → `decryptMedia(chunk, roomKey, iv)` (GCM needs contiguous IV chaining; see note) → append decrypted bytes to a `SourceBuffer`.
- **Step 3 — MSE:** `const ms = new MediaSource(); video.src = URL.createObjectURL(ms); ms.addEventListener('sourceopen', …)` → `ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')` → `sourceBuffer.appendBuffer(decryptedChunk)`; gate with `updateend`.
- Play starts as soon as the init segment + first chunk are buffered; later chunks stream in.

**AES-GCM chunking note (important):** standard AES-GCM IV must be unique per (key, message) and is not natively reseekable per chunk. Two clean options, both preserving E2EE:
1. **Per-chunk IV (recommended):** store/derive a per-chunk IV (`iv_base` + counter) and encrypt each uploaded segment with its own IV; metadata carries the base + segment map. Simplest for random-access Range.
2. **Sequential IV counter:** encrypt the whole file as one GCM stream with a 96-bit IV + 32-bit counter increment per 16-byte block; client recomputes the counter for the chunk offset. No extra metadata, but requires deterministic counter math.

Plan specifies **Option 1 (per-chunk IV)** for clarity and true random-access; document Option 2 as an optimization. Either way the *room key* is unchanged and bytes never traverse WS.

- **Native (Capacitor):** same MSE approach works; or use native `<VideoView>` with the decrypted local file path from the plugin (even simpler — plugin can persist decrypted temp file). Documented as native enhancement.

---

## 6. Caption + Preview UI (minimalist, on-theme)

### 6.1 New component: `MediaPreviewDialog`
`packages/frontend/src/components/chat/media-preview-dialog.tsx`
- Triggered by `chat-input.tsx` file selection **instead of** immediate `onSendMedia`.
- Layout (classic/minimal, follows existing theme tokens used by `chat-input`/`message-list`):
  - Centered modal/card over the chat.
  - **Image:** `<img>` (object-fit: contain) at natural aspect, constrained max-height.
  - **Video:** `<video controls>` poster = generated thumbnail; loops muted preview optional.
  - **Caption input:** single-line (grows to ≤3 lines) `<textarea>` / styled `<input>` matching the existing draft textarea styling (rounded, same bg/border tokens).
  - **Send button:** reuse the existing white `ArrowUp` send affordance styling from `chat-input.tsx`.
  - Per-file progress bar (from `onProgress`) when multiple files / while compressing.
- On Send → calls `onSendMedia(files, caption)` (new signature) and closes.

### 6.2 Schema change (decided: caption on metadata)
`packages/frontend/src/lib/models.ts`
```ts
interface ImageMetadata { type:"image"; objectKey; mimeType; width; height; size; iv; caption?: string }
interface VideoMetadata { type:"video"; objectKey; mimeType; width; height; size; thumbnailKey; thumbnailIv; duration?; iv; caption?: string }
```
- Caption is part of the metadata JSON, encrypted by `encryptMessage` → travels over WS like today. No new message type.
- **Render:** `MediaMessage` (`packages/frontend/src/components/chat/media-message.tsx`) already renders below the bubble; add: if `meta.caption`, render it in the same `<p>`/text style as a normal text message, directly under the image/video bubble.

### 6.3 `chat-input.tsx` changes
- `handleImageSelect`/`handleVideoSelect` → open `MediaPreviewDialog` with the picked `File`(s) instead of calling `onSendMedia` directly.
- `onSendMedia` prop signature → `onSendMedia(files: File[], caption?: string)`.
- Remove the instant-send behavior; keep the `+` menu, GIF button, reply strip, edit mode untouched.

---

## 7. Crypto & R2 Integration (unchanged contract)

- **Room key:** unchanged — AES-256-GCM `CryptoKey` per version in IndexedDB, shared via RSA-OAEP wrapping.
- **Encrypt:** `encryptMedia` for blobs, `encryptMessage` for metadata JSON (now includes `caption`). No new crypto primitives.
- **Upload:** same presigned PUT URL + `uploadEncryptedBlob`. Limits (image ≤10MB, video ≤100MB) still enforced server-side; reconsider raising the video cap given compressed sizes (~15MB) — recommend lifting to e.g. 250MB to allow larger source before compress, or compress-then-validate. Documented as a config decision.
- **WS payload:** unchanged `OutboundEncryptedMessage` shape; `messageType` stays `"image"|"video"`. Caption rides inside ciphertext.

---

## 8. File-by-File Change List

| File | Change |
|---|---|
| `lib/media/compressor.ts` | **New** — `MediaCompressor` interface, `CompressOptions`, `CompressResult`. |
| `lib/media/index.ts` | **New** — `getMediaCompressor()`, `compressMedia()` re-export, runtime selection. |
| `lib/media/browser-compressor.ts` | **New** — `@ffmpeg/ffmpeg` v0.12 MT backend, self-hosted core, video/image/thumb cmds, `-map_metadata -1`. |
| `lib/media/android-compressor.ts` | **New (bridge)** — calls Capacitor `MediaCompressor` plugin; implements `MediaCompressor`. |
| `lib/media/ios-compressor.ts` | **New (bridge)** — calls Capacitor `MediaCompressor` plugin; implements `MediaCompressor`. |
| `lib/media-optimizer.ts` | Refactor: image path delegates to `compressMedia`; keep thumbnail helper or move into browser backend. |
| `lib/media-storage.ts` | Extend `useMediaLoader` with Range+MSE progressive video; add per-chunk IV decrypt helper. |
| `lib/media-crypto.ts` | Add per-chunk IV encrypt/decrypt helpers (Option 1) — no room-key change. |
| `lib/models.ts` | Add `caption?` to `ImageMetadata`/`VideoMetadata`. |
| `components/chat/media-preview-dialog.tsx` | **New** — minimalist preview + caption + send. |
| `components/chat/chat-input.tsx` | Open preview dialog; change `onSendMedia` signature. |
| `components/chat/media-message.tsx` | Render `caption` below bubble like normal message. |
| `app/rooms/[roomId]/page.tsx` | Replace `onSendMedia` with per-file pipelined `pipelineOne`. |
| `next.config.js` / route headers | Add COOP/COEP for `SharedArrayBuffer` (ffmpeg MT). |
| `public/ffmpeg/*` | Self-hosted `@ffmpeg/core-mt` assets. |
| `capacitor-plugins/android/.../MediaCompressorPlugin.kt` | **New (when Capacitor added)** — MediaCodec/Extractor/Muxer. |
| `capacitor-plugins/ios/.../MediaCompressorPlugin.swift` | **New (when Capacitor added)** — AVFoundation. |

---

## 9. Phased Implementation (recommended order)

1. **Phase A — Schema + abstraction skeleton.** Add `caption?` to models; create `compressor.ts` interface + `index.ts` selector returning a no-op/Browser stub. Wire `chat-input` → `MediaPreviewDialog` → `onSendMedia(files, caption)` (UI works, compression still old path).
2. **Phase B — Browser backend.** Implement `browser-compressor.ts` with ffmpeg v0.12 MT, self-host core, COOP/COEP, video/image/thumb commands with `-map_metadata -1`. Replace old `optimizeImage` usage.
3. **Phase C — Pipelined send.** `pipelineOne` per-file compress→encrypt→upload; per-file progress UI.
4. **Phase D — Progressive playback.** Range + MSE + per-chunk IV decrypt in `useMediaLoader`; caption render in `MediaMessage`.
5. **Phase E — Native plugins (when Capacitor scaffolded).** Kotlin/Swift plugins implementing `MediaCompressor`; bridge files; verify backend selection via `Capacitor.isNativePlatform()`.
6. **Phase F — WebCodecs readiness.** Add `BrowserWebCodecsCompressor` behind detection flag (no UI change).

---

## 10. Risks & Decisions Log

- **SharedArrayBuffer / COOP-COEP:** required for ffmpeg MT; may affect other cross-origin assets. Mitigation: scope headers to media routes or use single-thread core if conflicts arise (slower).
- **Video size limit:** compressed ~15MB is fine; but source before compress may exceed 100MB. Recommend compressing client-side *before* the server size check, or raise the limit for the presign request that precedes compression. Decide at Phase C.
- **AES-GCM random-access:** per-chunk IV (Option 1) adds a small metadata segment map; chosen for clean Range support.
- **Native plugins are stubbed** in this plan (repo has no Capacitor yet). When added, the bridge files already exist; only plugin internals need writing.
- **H.264 MP4** chosen as universal target (web `<video>` + native playback). HEVC considered but rejected for web compatibility.
- **EXIF stripping** is implicit via re-encode; an explicit guard remains for any future passthrough image path.

---

## 11. Open Questions Resolved (from planning)

- Capacitor: **add later** — design native plugins as documented interfaces/bridges now; real Kotlin/Swift only when Capacitor scaffolded.
- Video target: **H.264 MP4**.
- Progressive playback: **R2 Range + MSE**, per-chunk IV decrypt.
- ffmpeg: **@ffmpeg/ffmpeg v0.12 + @ffmpeg/util + @ffmpeg/core-mt**, self-hosted.
- Caption: **optional field on `ImageMetadata`/`VideoMetadata`**, encrypted in metadata JSON.
- Metadata strip: **implicit via re-encode**; explicit guard for passthrough images.
- Doc depth: **comprehensive design** (this file).
