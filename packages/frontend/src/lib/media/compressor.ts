/**
 * MediaCompressor abstraction layer.
 *
 * Phase A (done): skeleton that delegates to the existing media-optimizer functions.
 * Phase B (done): real ffmpeg.wasm browser backend replaces the skeleton.
 * Phase C: per-file pipelined send with progress.
 * Phase D: per-chunk IV for progressive streaming.
 */

import { optimizeImage, generateVideoThumbnail } from "../media-optimizer";
import { BrowserMediaCompressor } from "./browser-compressor";
import type { CompressOptions } from "./browser-compressor";

export type { CompressOptions };

export interface CompressImageResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

export interface CompressVideoResult {
  compressedBlob: Blob;
  width: number;
  height: number;
  duration: number;
}

export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
}

export interface CompressorBackend {
  readonly platform: "browser" | "android" | "ios";
  isAvailable(): boolean;
  compressImage(file: File, opts?: CompressOptions): Promise<CompressImageResult>;
  compressVideo(file: File, opts?: CompressOptions): Promise<CompressVideoResult>;
  generateThumbnail(file: File, opts?: CompressOptions): Promise<ThumbnailResult>;
}

/**
 * Phase A legacy skeleton — wraps the existing browser-only optimizer.
 * Kept as a fallback when WebAssembly is unavailable.
 */
class LegacyBrowserCompressor implements CompressorBackend {
  readonly platform = "browser" as const;

  isAvailable(): boolean {
    return typeof OffscreenCanvas !== "undefined";
  }

  async compressImage(file: File, _opts?: CompressOptions): Promise<CompressImageResult> {
    const result = await optimizeImage(file);
    return {
      blob: result.blob,
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
    };
  }

  async compressVideo(file: File, _opts?: CompressOptions): Promise<CompressVideoResult> {
    const meta = await getVideoMeta(file);
    return {
      compressedBlob: file,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
    };
  }

  async generateThumbnail(file: File, _opts?: CompressOptions): Promise<ThumbnailResult> {
    const { thumbnail } = await generateVideoThumbnail(file);
    return thumbnail;
  }
}

async function getVideoMeta(file: File): Promise<{
  width: number;
  height: number;
  duration: number;
}> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = blobUrl;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video metadata"));
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration || 0,
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

let _instance: CompressorBackend | null = null;

export function getMediaCompressor(): CompressorBackend {
  if (!_instance) {
    // Prefer the WASM-based ffmpeg compressor if available
    const wasm = new BrowserMediaCompressor();
    _instance = wasm.isAvailable() ? wasm : new LegacyBrowserCompressor();
  }
  return _instance;
}

export async function compressMedia(
  file: File,
  kind: "image" | "video",
  opts?: CompressOptions
): Promise<CompressImageResult | CompressVideoResult> {
  const compressor = getMediaCompressor();

  if (kind === "image") {
    return compressor.compressImage(file, opts);
  }
  return compressor.compressVideo(file, opts);
}
