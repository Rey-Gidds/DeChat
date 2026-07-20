"use client";

import { AlertTriangle } from "lucide-react";
import { useMediaLoader } from "@/lib/media-storage";
import type { ProgressiveVideoParams } from "@/lib/media-storage";

interface MediaMessageProps {
  objectKey: string;
  roomKey: CryptoKey;
  iv: string;
  mimeType: string;
  type: "image" | "video";
  width: number;
  height: number;
  thumbnailKey?: string;
  thumbnailIv?: string;
  isOwn?: boolean;
  /** Per-chunk IV base for progressive video streaming (Phase D). */
  ivBase?: string;
  /** Plaintext chunk size in bytes for progressive streaming. */
  chunkSize?: number;
  /** Called when the image is clicked (opens the image viewer). Video click is unused. */
  onImageClick?: () => void;
  localUrl?: string;
  progress?: number;
  progressStage?: "compressing" | "uploading" | "failed";
  status?: "pending" | "retrying" | "failed";
  onRetry?: () => void;
}

export function MediaMessage({
  objectKey,
  roomKey,
  iv,
  mimeType,
  type,
  width,
  height,
  thumbnailKey,
  thumbnailIv,
  ivBase,
  chunkSize,
  onImageClick,
  localUrl,
  progress,
  progressStage,
  status,
  onRetry,
}: MediaMessageProps) {
  // Build progressive params for videos that have per-chunk IV metadata
  const progressiveParams: ProgressiveVideoParams | undefined =
    type === "video" && ivBase && chunkSize
      ? { ivBase, chunkSize }
      : undefined;

  const { blobUrl, thumbnailBlobUrl, loading, error, retry } = useMediaLoader(
    localUrl ? "" : objectKey,
    roomKey,
    iv,
    mimeType,
    thumbnailKey,
    thumbnailIv,
    progressiveParams,
  );

  const effectiveUrl = localUrl || blobUrl;

  const renderOverlay = () => {
    if (!localUrl) return null;

    if (status === "failed") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 backdrop-blur-[2px]">
          <div className="flex flex-col items-center space-y-1.5 px-4 text-center">
            <AlertTriangle size={20} className="text-red-500 animate-pulse" />
            <span className="text-[11px] font-medium text-neutral-200">Failed to send</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.();
              }}
              className="rounded bg-white px-2.5 py-0.5 text-[10px] font-semibold text-black hover:bg-neutral-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    if (progressStage === "compressing" && progress !== undefined && progress < 100) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] transition-opacity duration-300">
          <div className="w-2/3 max-w-[150px] space-y-2">
            <div className="flex justify-between text-[11px] font-medium text-neutral-300">
              <span>Optimizing...</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-white transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      );
    }

    if (progressStage === "uploading") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] transition-opacity duration-300">
          <div className="flex items-center space-x-2">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-400 border-t-white" />
            <span className="text-[11px] font-medium text-neutral-300">Uploading...</span>
          </div>
        </div>
      );
    }

    return null;
  };

  if (error && !localUrl) {
    return (
      <div className="flex flex-col items-center">
        <div className="flex aspect-video cursor-pointer items-center justify-center border border-neutral-800 bg-neutral-950 rounded-sm" onClick={retry}>
          <AlertTriangle size={16} className="text-neutral-600" />
          <span className="ml-1.5 text-[10px] text-neutral-600">Failed to load media</span>
        </div>
      </div>
    );
  }

  if (loading && !localUrl) {
    return (
      <div className="flex flex-col items-center">
        <div
          className="animate-pulse bg-neutral-800 rounded-sm"
          style={{ aspectRatio: `${width} / ${height}`, maxHeight: 384 }}
        />
      </div>
    );
  }

  if (!effectiveUrl) return null;

  if (type === "image") {
    return (
      <div className="flex flex-col items-start">
        <div className="relative overflow-hidden">
          <img
            src={effectiveUrl}
            alt="Shared image"
            className="max-h-96 w-full cursor-pointer rounded-sm object-contain"
            style={{ aspectRatio: `${width} / ${height}` }}
            loading="lazy"
            onClick={onImageClick}
          />
          {renderOverlay()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start">
      <div className="relative overflow-hidden">
        <video
          src={effectiveUrl}
          poster={thumbnailBlobUrl ?? undefined}
          controls={!localUrl} // Disable controls during local background upload
          preload="metadata"
          className="max-h-96 w-full rounded-sm"
          style={{ aspectRatio: `${width} / ${height}` }}
        >
          Your browser does not support video playback.
        </video>
        {renderOverlay()}
      </div>
    </div>
  );
}
