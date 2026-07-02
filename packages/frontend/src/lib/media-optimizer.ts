/**
 * Client-side media optimization — runs entirely in the browser.
 * Images: resize → WebP conversion → compress
 * Videos: thumbnail from first frame (raw video is uploaded as-is for MVP)
 */

export interface OptimizedImage {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string; // "image/webp"
}

export interface VideoThumbnail {
  blob: Blob;
  width: number;
  height: number;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
}

const IMAGE_MAX_DIMENSION = 1920;
const IMAGE_QUALITY = 0.8;
const THUMBNAIL_MAX_DIMENSION = 640;
const THUMBNAIL_QUALITY = 0.7;

/**
 * Optimize an image file: resize to max 1920px on the longest side,
 * convert to WebP at quality 0.8.
 */
export async function optimizeImage(file: File): Promise<OptimizedImage> {
  const bitmap = await createImageBitmap(file);

  try {
    const { width, height } = calculateDimensions(
      bitmap.width,
      bitmap.height,
      IMAGE_MAX_DIMENSION
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: IMAGE_QUALITY,
    });

    return { blob, width, height, mimeType: "image/webp" };
  } finally {
    bitmap.close();
  }
}

/**
 * Generate a video thumbnail from the first frame (or 10% in).
 */
export async function generateVideoThumbnail(
  file: File
): Promise<{ thumbnail: VideoThumbnail; metadata: VideoMetadata }> {
  const url = URL.createObjectURL(file);

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    // Wait for enough metadata to seek
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Failed to load video")), { once: true });
    });

    // Seek to 10% of duration (or 0 if very short / NaN)
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = duration > 1 ? duration * 0.1 : 0;

    await new Promise<void>((resolve, reject) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Failed to seek video")), { once: true });
    });

    const { width, height } = calculateDimensions(
      video.videoWidth,
      video.videoHeight,
      THUMBNAIL_MAX_DIMENSION
    );

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: THUMBNAIL_QUALITY,
    });

    return {
      thumbnail: { blob, width, height },
      metadata: {
        duration: Math.round(duration),
        width: video.videoWidth,
        height: video.videoHeight,
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Calculate new dimensions maintaining aspect ratio.
 * If both dimensions are within the max, the original size is kept
 * (no upscaling). Minimum dimension floor is 200px.
 */
function calculateDimensions(
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { width: Math.max(width, 200), height: Math.max(height, 200) };
  }

  const ratio = width / height;
  if (width > height) {
    return {
      width: maxDimension,
      height: Math.round(maxDimension / ratio),
    };
  }
  return {
    width: Math.round(maxDimension * ratio),
    height: maxDimension,
  };
}

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/bmp"];

/**
 * Validate that a file is a supported image type.
 */
export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type);
}

const SUPPORTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];

export function isSupportedVideo(file: File): boolean {
  return SUPPORTED_VIDEO_TYPES.includes(file.type);
}
