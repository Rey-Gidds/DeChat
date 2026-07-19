/**
 * Media compression abstraction — barrel export.
 *
 * Phase A (done): skeleton that delegates to the existing browser-only optimizer.
 * Phase B (done): ffmpeg.wasm browser backend replaces the skeleton.
 * Phases C–D: per-file pipeline with progress + per-chunk IV streaming.
 */

export {
  getMediaCompressor,
  compressMedia,
} from "./compressor";

export type {
  CompressorBackend,
  CompressImageResult,
  CompressVideoResult,
  ThumbnailResult,
  CompressOptions,
} from "./compressor";
