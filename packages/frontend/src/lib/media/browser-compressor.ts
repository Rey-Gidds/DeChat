/**
 * BrowserMediaCompressor — real ffmpeg.wasm v0.12 backend.
 *
 * Phase B implementation: transcodes video to H.264 MP4, converts images to WebP,
 * generates video thumbnails, and strips all EXIF/metadata via -map_metadata -1.
 *
 * Uses @ffmpeg/core (single-threaded) self-hosted from /ffmpeg/ to avoid
 * SharedArrayBuffer / COOP-COEP requirements and cross-origin CDN dependencies.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type {
  CompressorBackend,
  CompressImageResult,
  CompressVideoResult,
  ThumbnailResult,
} from "./compressor";

export interface CompressOptions {
  /** Max longest-edge for images (px). Default 1920. */
  maxEdge?: number;
  /** Target video height (px). Default 720. */
  targetHeight?: number;
  /** 0–1 quality / CRF (backend-specific mapping). Default 0.8 for images, 28 CRF for video. */
  quality?: number;
  /** Optional progress callback (0–1). */
  onProgress?: (p: number) => void;
}

const CORE_BASE = "/ffmpeg";

/**
 * Create a singleton promise for loading the FFmpeg instance.
 * Uses toBlobURL to fetch self-hosted core files as blob URLs,
 * matching @ffmpeg/ffmpeg's documented self-hosting pattern.
 */
let _ffmpegInstance: FFmpeg | null = null;
let _ffmpegLoadPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (_ffmpegInstance) return _ffmpegInstance;

  if (!_ffmpegLoadPromise) {
    _ffmpegLoadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const [coreBlobUrl, wasmBlobUrl] = await Promise.all([
        toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      ]);
      await ffmpeg.load({ coreURL: coreBlobUrl, wasmURL: wasmBlobUrl });
      _ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }

  return _ffmpegLoadPromise;
}

/**
 * Remove temp files from the ffmpeg virtual filesystem between operations
 * so successive runs don't collide.
 */
async function cleanTempFiles(ffmpeg: FFmpeg, names: string[]) {
  for (const name of names) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      // file may not exist — that's fine
    }
  }
}

export class BrowserMediaCompressor implements CompressorBackend {
  readonly platform = "browser" as const;

  isAvailable(): boolean {
    return typeof WebAssembly !== "undefined";
  }

  async compressImage(
    file: File,
    opts?: CompressOptions
  ): Promise<CompressImageResult> {
    const maxEdge = opts?.maxEdge ?? 1920;
    const quality = Math.round((opts?.quality ?? 0.8) * 100);

    const ffmpeg = await getFFmpeg();
    const inputName = `input_${crypto.randomUUID()}`;
    const outputName = "output.webp";

    await cleanTempFiles(ffmpeg, [inputName, outputName]);
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Progress listener — scoped to this operation
    const onProgress = opts?.onProgress;
    const progressHandler = onProgress
      ? ({ progress }: { progress: number }) => onProgress(progress)
      : undefined;
    if (progressHandler) ffmpeg.on("progress", progressHandler);

    try {
      await ffmpeg.exec([
        "-i",
        inputName,
        "-vf",
        `scale='min(${maxEdge},iw)':-2`,
        "-map_metadata",
        "-1",
        "-quality",
        String(quality),
        "-y",
        outputName,
      ]);

      const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
      const blob = new Blob([data], { type: "image/webp" });

      // Probe dimensions from first frame via ffprobe-like approach or ffmpeg
      const { width, height } = await probeImageDimensions(ffmpeg, outputName);

      return { blob, width, height, mimeType: "image/webp" };
    } finally {
      if (progressHandler) ffmpeg.off("progress", progressHandler);
      await cleanTempFiles(ffmpeg, [inputName, outputName]);
    }
  }

  async compressVideo(
    file: File,
    opts?: CompressOptions
  ): Promise<CompressVideoResult> {
    const targetHeight = opts?.targetHeight ?? 720;
    const crf = Math.round(opts?.quality ?? 28);

    const ffmpeg = await getFFmpeg();
    const inputName = `input_${crypto.randomUUID()}`;
    const outputName = "output.mp4";

    await cleanTempFiles(ffmpeg, [inputName, outputName]);
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Determine input duration for progress mapping
    const duration = await probeVideoDuration(ffmpeg, inputName);

    const onProgress = opts?.onProgress;
    const progressHandler = onProgress
      ? ({ progress }: { progress: number }) => onProgress(progress)
      : undefined;
    if (progressHandler) ffmpeg.on("progress", progressHandler);

    try {
      await ffmpeg.exec([
        "-i",
        inputName,
        "-vf",
        `scale='min(${targetHeight * 16 / 9},iw)':-2`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(crf),
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-y",
        outputName,
      ]);

      const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
      const blob = new Blob([data], { type: "video/mp4" });

      // Probe output dimensions
      const { width, height } = await probeVideoDimensions(ffmpeg, outputName);

      return {
        compressedBlob: blob,
        width,
        height,
        duration: Math.round(duration),
      };
    } finally {
      if (progressHandler) ffmpeg.off("progress", progressHandler);
      await cleanTempFiles(ffmpeg, [inputName, outputName]);
    }
  }

  async generateThumbnail(
    file: File,
    opts?: CompressOptions
  ): Promise<ThumbnailResult> {
    const maxEdge = opts?.maxEdge ?? 640;
    const quality = Math.round((opts?.quality ?? 0.7) * 100);

    const ffmpeg = await getFFmpeg();
    const inputName = `input_${crypto.randomUUID()}`;
    const outputName = "thumb.webp";

    await cleanTempFiles(ffmpeg, [inputName, outputName]);
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    try {
      // Seek to 10% of duration for a representative frame
      await ffmpeg.exec([
        "-ss",
        "10%",
        "-i",
        inputName,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${maxEdge},iw)':-2`,
        "-map_metadata",
        "-1",
        "-quality",
        String(quality),
        "-y",
        outputName,
      ]);

      const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
      const blob = new Blob([data], { type: "image/webp" });
      const { width, height } = await probeImageDimensions(ffmpeg, outputName);

      return { blob, width, height };
    } finally {
      await cleanTempFiles(ffmpeg, [inputName, outputName]);
    }
  }
}

// ─── Probing helpers ──────────────────────────────────────────────

/**
 * Probe the dimensions of an image output by running ffmpeg with ffprobe-style
 * log output. We use `ffmpeg -i` on the output file and parse the stream info.
 */
async function probeImageDimensions(
  ffmpeg: FFmpeg,
  outputName: string
): Promise<{ width: number; height: number }> {
  try {
    // Use a temporary copy to probe without modifying the original output
    const probeName = `probe_${crypto.randomUUID()}`;
    await ffmpeg.writeFile(probeName, await ffmpeg.readFile(outputName));

    // We can use a simple command to get resolution: fftools aren't available,
    // so read from the ffmpeg stderr log instead. The cleanest approach in
    // ffmpeg.wasm is to check the output size via mediainfo-style log parsing.
    // Alternative: use `ffmpeg -i probe -f null -` which prints stream info.
    // For images, we'll decode and measure in JS as a fallback.
    try {
      await ffmpeg.exec(["-i", probeName, "-f", "null", "-"]);
    } catch {
      // ffmpeg always exits with 1 when -i is used without output — expected.
    }

    await cleanTempFiles(ffmpeg, [probeName]);

    // Parse log for resolution pattern: "Stream #0:0: ... 1920x1080"
    const log = (ffmpeg as any).log ?? "";
    const match = log.match(/(\d+)x(\d+)/);
    if (match) {
      return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      };
    }
  } catch {
    // Fall through to default
  }

  // Fallback: decode the image via createImageBitmap (expensive but reliable)
  try {
    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    const blob = new Blob([data]);
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Probe output video dimensions by parsing ffmpeg log or using fallback.
 */
async function probeVideoDimensions(
  ffmpeg: FFmpeg,
  outputName: string
): Promise<{ width: number; height: number }> {
  try {
    await ffmpeg.exec(["-i", outputName, "-f", "null", "-"]);
  } catch {
    // Expected exit code 1 for probe-only
  }

  const log = (ffmpeg as any).log ?? "";
  const match = log.match(/(\d+)x(\d+)/);
  if (match) {
    return {
      width: parseInt(match[1], 10),
      height: parseInt(match[2], 10),
    };
  }

  // Fallback: decode first frame
  try {
    const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
    const blob = new Blob([data], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject();
    });
    URL.revokeObjectURL(url);

    return {
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Probe input video duration.
 */
async function probeVideoDuration(
  ffmpeg: FFmpeg,
  inputName: string
): Promise<number> {
  try {
    await ffmpeg.exec(["-i", inputName, "-f", "null", "-"]);
  } catch {
    // Expected exit code 1
  }

  const log = (ffmpeg as any).log ?? "";
  // Match "Duration: 00:01:23.45" and convert to seconds
  const match = log.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const centiseconds = parseInt(match[4], 10);
    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
  }

  return 0;
}
