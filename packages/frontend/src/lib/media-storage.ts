/**
 * Media storage layer: presigned URL request, R2 upload, CDN fetch,
 * in-memory cache, in-flight request deduplication, and the useMediaLoader hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { decryptMedia } from "./media-crypto";

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

// ─── Fetch + Decrypt ──────────────────────────────────────────────

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

// ─── useMediaLoader Hook ──────────────────────────────────────────

interface UseMediaLoaderResult {
  blobUrl: string | null;
  thumbnailBlobUrl: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * React hook that loads and caches encrypted media from CDN.
 * - Checks in-memory cache first
 * - Deduplicates in-flight requests
 * - Fetches from CDN and decrypts with room key
 * - Returns a blob URL for rendering
 * - Cleans up object URLs on unmount
 */
export function useMediaLoader(
  objectKey: string | undefined,
  roomKey: CryptoKey | undefined,
  ivBase64: string | undefined,
  mimeType: string | undefined,
  thumbnailObjectKey?: string,
  thumbnailIv?: string
): UseMediaLoaderResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [thumbnailBlobUrl, setThumbnailBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(() => {
    if (!objectKey || !roomKey || !ivBase64 || !mimeType) return;

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

    // Load thumbnail if present
    if (thumbnailObjectKey && thumbnailIv && roomKey) {
      loadMedia(thumbnailObjectKey, roomKey, thumbnailIv, "image/webp")
        .then((result) => {
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(result.blob);
          setThumbnailBlobUrl(url);
        })
        .catch(() => {
          // Thumbnail failure is non-fatal
        });
    }
  }, [objectKey, roomKey, ivBase64, mimeType, thumbnailObjectKey, thumbnailIv]);

  useEffect(() => {
    mountedRef.current = true;
    load();

    return () => {
      mountedRef.current = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (thumbnailBlobUrl) URL.revokeObjectURL(thumbnailBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey, roomKey, ivBase64, mimeType, thumbnailObjectKey, thumbnailIv]);

  const retry = useCallback(() => {
    retryCountRef.current += 1;
    load();
  }, [load]);

  return { blobUrl, thumbnailBlobUrl, loading, error, retry };
}

// ─── Utility ──────────────────────────────────────────────────────

/**
 * Clear the entire media cache. Call when user leaves a room.
 */
export function clearMediaCache(): void {
  globalCache.clear();
}
