/**
 * Media storage layer: presigned URL request, R2 upload, CDN fetch,
 * in-memory cache, in-flight request deduplication, useMediaLoader hook,
 * and progressive Range+MSE video streaming (Phase D).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decryptMedia,
  deriveChunkIV,
  decryptChunk,
  getRangeForPlaintextRange,
} from "./media-crypto";

// ─── Types ────────────────────────────────────────────────────────

export interface DecryptedMediaResult {
  blob: Blob;
  mimeType: string;
}

interface CacheEntry {
  blob: Blob;
  mimeType: string;
  timestamp: number;
}

// ─── In-Flight Request Deduplication ──────────────────────────────

const inflightRequests = new Map<string, Promise<DecryptedMediaResult>>();

// ─── In-Memory Cache ──────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 50;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class InMemoryMediaCache {
  private cache = new Map<string, CacheEntry>();

  get(objectKey: string): DecryptedMediaResult | null {
    const entry = this.cache.get(objectKey);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(objectKey);
      return null;
    }

    return { blob: entry.blob, mimeType: entry.mimeType };
  }

  set(objectKey: string, result: DecryptedMediaResult): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(objectKey, {
      blob: result.blob,
      mimeType: result.mimeType,
      timestamp: Date.now(),
    });
  }

  delete(objectKey: string): void {
    this.cache.delete(objectKey);
  }

  clear(): void {
    this.cache.clear();
    inflightRequests.clear();
  }
}

const globalCache = new InMemoryMediaCache();

// ─── CDN Base URL ─────────────────────────────────────────────────

function getCdnBaseUrl(): string {
  return process.env.NEXT_PUBLIC_R2_PUBLIC_URL || "";
}

// ─── Fetch + Decrypt (full download) ──────────────────────────────

/**
 * Fetch an encrypted blob from the CDN and decrypt it with the room key.
 * The IV is passed in from the decrypted message metadata.
 */
export async function fetchAndDecryptMedia(
  objectKey: string,
  roomKey: CryptoKey,
  ivBase64: string,
  expectedMimeType: string
): Promise<DecryptedMediaResult> {
  const cdnBase = getCdnBaseUrl();
  if (!cdnBase) {
    throw new Error("R2 public URL not configured");
  }

  const url = `${cdnBase}/${objectKey}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch media (${response.status})`);
  }

  const encrypted = await response.arrayBuffer();
  const decrypted = await decryptMedia(encrypted, roomKey, ivBase64);

  // Determine MIME type from decrypted data or fall back to expected
  const blob = new Blob([decrypted], { type: expectedMimeType });
  return { blob, mimeType: expectedMimeType };
}

// ─── Range Fetch (progressive streaming) ──────────────────────────

/**
 * Fetch a byte range of an encrypted object from the CDN.
 * R2 supports HTTP Range requests on objects.
 */
export async function fetchMediaRange(
  objectKey: string,
  start: number,
  end: number
): Promise<ArrayBuffer> {
  const cdnBase = getCdnBaseUrl();
  if (!cdnBase) {
    throw new Error("R2 public URL not configured");
  }

  const url = `${cdnBase}/${objectKey}`;
  const response = await fetch(url, {
    headers: {
      Range: `bytes=${start}-${end - 1}`,
    },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch media range (${response.status})`);
  }

  return response.arrayBuffer();
}

/**
 * Probe the total encrypted file size via a HEAD request with Range.
 * R2 returns Content-Range on a 206 response for Range: bytes=0-0.
 */
export async function probeEncryptedSize(
  objectKey: string
): Promise<number> {
  const cdnBase = getCdnBaseUrl();
  if (!cdnBase) {
    throw new Error("R2 public URL not configured");
  }

  const url = `${cdnBase}/${objectKey}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
  });

  if (response.status === 206) {
    // Content-Range: bytes 0-0/{total}
    const cr = response.headers.get("Content-Range");
    if (cr) {
      const match = cr.match(/\/(\d+)$/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  // Fallback: try full GET (expensive but reliable)
  const fullResponse = await fetch(url, { method: "HEAD" });
  if (fullResponse.ok) {
    const len = fullResponse.headers.get("Content-Length");
    if (len) return parseInt(len, 10);
  }

  throw new Error("Could not determine encrypted file size");
}

// ─── Load Media (with cache + dedup) ──────────────────────────────

/**
 * Core media loading function with cache check, in-flight deduplication,
 * CDN fetch, and decrypt.
 */
export async function loadMedia(
  objectKey: string,
  roomKey: CryptoKey,
  ivBase64: string,
  mimeType: string
): Promise<DecryptedMediaResult> {
  // 1. Check in-memory cache
  const cached = globalCache.get(objectKey);
  if (cached) return cached;

  // 2. Check in-flight dedup
  const inflight = inflightRequests.get(objectKey);
  if (inflight) return inflight;

  // 3. Fetch and decrypt
  const promise = fetchAndDecryptMedia(objectKey, roomKey, ivBase64, mimeType)
    .then((result) => {
      // Store in cache
      globalCache.set(objectKey, result);
      return result;
    })
    .finally(() => {
      inflightRequests.delete(objectKey);
    });

  inflightRequests.set(objectKey, promise);
  return promise;
}

// ─── Upload ───────────────────────────────────────────────────────

export interface UploadMediaResult {
  objectKey: string;
  thumbnailKey?: string;
  thumbnailIv?: string;
  iv: string;
}

/**
 * Upload encrypted media to R2 via a presigned URL.
 * Retries with exponential backoff on failure.
 */
async function uploadToR2(
  encryptedBlob: Blob,
  retries = 3
): Promise<{ uploadUrl: string; objectKey: string }> {
  // Request presigned URL
  const res = await fetch("/api/media/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      mimeType: encryptedBlob.type || "application/octet-stream",
      size: encryptedBlob.size,
      roomId: "", // filled in by caller
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Failed to get upload URL");
  }

  const { uploadUrl, objectKey } = await res.json();

  // Upload directly to R2
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      // Get a new presigned URL for retry
      const newRes = await fetch("/api/media/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          mimeType: encryptedBlob.type || "application/octet-stream",
          size: encryptedBlob.size,
          roomId: "",
        }),
      });
      if (!newRes.ok) {
        lastError = new Error("Failed to get new upload URL for retry");
        continue;
      }
      const data = await newRes.json();
      // Use the new URL and objectKey
      const uploadResponse = await fetch(data.uploadUrl, {
        method: "PUT",
        body: encryptedBlob,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (uploadResponse.ok) {
        return { uploadUrl: data.uploadUrl, objectKey: data.objectKey };
      }
      lastError = new Error(`Upload failed (attempt ${attempt + 1})`);
      continue;
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: encryptedBlob,
      headers: { "Content-Type": "application/octet-stream" },
    });

    if (uploadResponse.ok) {
      return { uploadUrl, objectKey };
    }

    lastError = new Error(`Upload failed (HTTP ${uploadResponse.status})`);
  }

  throw lastError || new Error("Upload failed after retries");
}

/**
 * Request a presigned URL from the server. The roomId is passed so the
 * server can validate membership. Returns the URL and object key.
 */
export async function requestUploadUrl(
  roomId: string,
  mimeType: string,
  size: number
): Promise<{ uploadUrl: string; objectKey: string }> {
  const res = await fetch("/api/media/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mimeType, size, roomId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Failed to get upload URL");
  }

  return res.json();
}

/**
 * Upload an encrypted blob directly to R2 using the presigned URL.
 */
export async function uploadEncryptedBlob(
  uploadUrl: string,
  encryptedBlob: Blob
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: encryptedBlob,
    headers: { "Content-Type": "application/octet-stream" },
  });

  if (!response.ok) {
    throw new Error(`Upload failed (HTTP ${response.status})`);
  }
}

// ─── Progressive Video Streaming (MSE + Range) ───────────────────

const FETCH_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB per fetch request
const MSE_APPEND_TIMEOUT = 10_000; // 10s timeout for sourceBuffer updateend

interface ProgressiveVideoState {
  blobUrl: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Internal hook that drives progressive video playback via MediaSource Extensions.
 *
 * Flow:
 * 1. HEAD/range-0 probe → total encrypted size
 * 2. Create MediaSource → get object URL
 * 3. On sourceopen: add SourceBuffer, start chunked Range fetches
 * 4. Each chunk: fetch range → derive chunk IV → decrypt → append to SourceBuffer
 * 5. Signal endOfStream when all chunks have been appended
 */
function useProgressiveVideo(
  objectKey: string,
  roomKey: CryptoKey,
  ivBase: string,
  chunkSize: number,
  mimeType: string
): ProgressiveVideoState {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const abortRef = useRef(false);

  // Derive the MP4 codec string from the mimeType
  const codec =
    mimeType === "video/mp4" ? 'avc1.42E01E, mp4a.40.2' : undefined;

  const startPlayback = useCallback(() => {
    if (!objectKey || !roomKey || !ivBase || !chunkSize) return;

    setLoading(true);
    setError(null);
    abortRef.current = false;

    const cdnBase = getCdnBaseUrl();
    if (!cdnBase) return;

    const ms = new MediaSource();
    mediaSourceRef.current = ms;
    const url = URL.createObjectURL(ms);
    setBlobUrl(url);

    let totalEncryptedSize = 0;
    let currentChunkIndex = 0;
    let chunksAppended = 0;
    let totalChunks = 0;

    ms.addEventListener("sourceopen", () => {
      if (abortRef.current) return;

      const sb = (ms as any).addSourceBuffer(
        codec ? `video/mp4; codecs="${codec}"` : mimeType
      );
      sourceBufferRef.current = sb;

      // Step 1: Probe total encrypted size
      probeEncryptedSize(objectKey)
        .then((size) => {
          if (abortRef.current) return;
          totalEncryptedSize = size;

          // Each encrypted chunk = chunkSize + 16 (GCM tag)
          const encryptedChunkSize = chunkSize + 16;
          totalChunks = Math.ceil(size / encryptedChunkSize);

          // Step 2: Start fetching chunks
          fetchNextChunks();
        })
        .catch((err) => {
          if (!abortRef.current) {
            setError(err instanceof Error ? err.message : "Failed to probe video size");
            setLoading(false);
          }
        });

      async function fetchNextChunks() {
        if (abortRef.current) return;

        while (currentChunkIndex < totalChunks) {
          if (abortRef.current) return;

          // Calculate ciphertext range for this batch of chunks
          const encryptedChunkSize = chunkSize + 16;
          const rangeStart = currentChunkIndex * encryptedChunkSize;
          const rangeEnd = Math.min(
            (currentChunkIndex + 1) * encryptedChunkSize,
            totalEncryptedSize
          );

          try {
            const encryptedChunk = await fetchMediaRange(
              objectKey,
              rangeStart,
              rangeEnd
            );

            if (abortRef.current) return;

            // Derive IV for this chunk
            const iv = deriveChunkIV(ivBase, currentChunkIndex);

            // Decrypt the chunk
            const decryptedChunk = await decryptChunk(
              encryptedChunk,
              roomKey,
              iv
            );

            if (abortRef.current) return;

            // Wait for sourceBuffer to be ready
            if (sb.updating) {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  reject(new Error("SourceBuffer updateend timeout"));
                }, MSE_APPEND_TIMEOUT);
                sb.addEventListener(
                  "updateend",
                  () => {
                    clearTimeout(timeout);
                    resolve();
                  },
                  { once: true }
                );
              });
            }

            if (abortRef.current) return;

            // Append decrypted chunk to SourceBuffer
            sb.appendBuffer(decryptedChunk);
            currentChunkIndex++;
            chunksAppended++;

            // Update loading state after first chunk
            if (chunksAppended === 1) {
              setLoading(false);
            }
          } catch (err) {
            if (!abortRef.current) {
              setError(
                err instanceof Error ? err.message : "Failed to stream video chunk"
              );
              setLoading(false);
              return;
            }
          }
        }

        // All chunks fetched and appended
        if (ms.readyState === "open") {
          try {
            ms.endOfStream();
          } catch {
            // Ignore — may already be ended by browser
          }
        }
        setLoading(false);
      }
    });
  }, [objectKey, roomKey, ivBase, chunkSize, mimeType, codec]);

  useEffect(() => {
    mountedRef.current = true;

    startPlayback();

    return () => {
      mountedRef.current = false;
      abortRef.current = true;

      // Clean up MSE
      if (mediaSourceRef.current?.readyState === "open") {
        try {
          mediaSourceRef.current.endOfStream();
        } catch {
          // ignore
        }
      }
      sourceBufferRef.current = null;
      mediaSourceRef.current = null;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey, roomKey, ivBase, chunkSize, mimeType]);

  const retry = useCallback(() => {
    retryCountRef.current += 1;
    startPlayback();
  }, [startPlayback]);

  return { blobUrl, loading, error, retry };
}

// ─── useMediaLoader Hook ──────────────────────────────────────────

interface UseMediaLoaderResult {
  blobUrl: string | null;
  thumbnailBlobUrl: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export interface ProgressiveVideoParams {
  ivBase: string;
  chunkSize: number;
}

/**
 * React hook that loads and caches encrypted media from CDN.
 *
 * For images (and videos without progressive params):
 *   - Checks in-memory cache first, deduplicates in-flight requests,
 *     fetches from CDN, decrypts with room key, returns a blob URL.
 *
 * For videos with progressive params (ivBase + chunkSize):
 *   - Uses MediaSource Extensions + HTTP Range requests to stream
 *     and decrypt chunks progressively.
 */
export function useMediaLoader(
  objectKey: string | undefined,
  roomKey: CryptoKey | undefined,
  ivBase64: string | undefined,
  mimeType: string | undefined,
  thumbnailObjectKey?: string,
  thumbnailIv?: string,
  progressiveParams?: ProgressiveVideoParams
): UseMediaLoaderResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [thumbnailBlobUrl, setThumbnailBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);

  // Determine whether to use progressive streaming for this video
  const isProgressiveVideo =
    mimeType?.startsWith("video/") &&
    progressiveParams?.ivBase != null &&
    progressiveParams?.chunkSize != null &&
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(mimeType);

  // Always call useProgressiveVideo (hooks rules: unconditional).
  // When not a progressive video, pass empty/invalid args and ignore the result.
  const progressiveResult = useProgressiveVideo(
    isProgressiveVideo ? objectKey! : "",
    isProgressiveVideo ? roomKey! : null as unknown as CryptoKey,
    progressiveParams?.ivBase ?? "",
    progressiveParams?.chunkSize ?? 0,
    mimeType ?? ""
  );

  // ── Thumbnail loading (unconditional effect — shared by both paths) ──
  useEffect(() => {
    if (!thumbnailObjectKey || !thumbnailIv || !roomKey) return;
    let cancelled = false;

    loadMedia(thumbnailObjectKey, roomKey, thumbnailIv, "image/webp")
      .then((result) => {
        if (!cancelled) {
          const url = URL.createObjectURL(result.blob);
          setThumbnailBlobUrl(url);
        }
      })
      .catch(() => {
        // Thumbnail failure is non-fatal
      });

    return () => {
      cancelled = true;
    };
  }, [thumbnailObjectKey, thumbnailIv, roomKey]);

  // ── Full-download path (for images and non-progressive videos) ──
  const fullLoad = useCallback(() => {
    if (!objectKey || !roomKey || !ivBase64 || !mimeType) return;
    if (isProgressiveVideo) return; // Don't full-download when progressive is active

    setLoading(true);
    setError(null);

    loadMedia(objectKey, roomKey, ivBase64, mimeType)
      .then((result) => {
        if (!mountedRef.current) return;
        const url = URL.createObjectURL(result.blob);
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load media");
        setLoading(false);
      });
  }, [objectKey, roomKey, ivBase64, mimeType, isProgressiveVideo]);

  const fullRetry = useCallback(() => {
    retryCountRef.current += 1;
    fullLoad();
  }, [fullLoad]);

  // ── Progressive mode: use progressiveResult, ignore fullLoad ──
  // ── Non-progressive mode: ignore progressiveResult, use fullLoad ──
  useEffect(() => {
    mountedRef.current = true;

    if (!isProgressiveVideo) {
      fullLoad();
    }

    return () => {
      mountedRef.current = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (thumbnailBlobUrl) URL.revokeObjectURL(thumbnailBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey, roomKey, ivBase64, mimeType, isProgressiveVideo]);

  // Derive final return value based on mode
  if (isProgressiveVideo) {
    return {
      blobUrl: progressiveResult.blobUrl,
      thumbnailBlobUrl,
      loading: progressiveResult.loading,
      error: progressiveResult.error,
      retry: progressiveResult.retry,
    };
  }

  return { blobUrl, thumbnailBlobUrl, loading, error, retry: fullRetry };
}

// ─── Utility ──────────────────────────────────────────────────────

/**
 * Clear the entire media cache. Call when user leaves a room.
 */
export function clearMediaCache(): void {
  globalCache.clear();
}
