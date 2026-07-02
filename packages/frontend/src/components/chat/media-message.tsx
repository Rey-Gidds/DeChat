"use client";

import { AlertTriangle } from "lucide-react";
import { useMediaLoader } from "@/lib/media-storage";

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
}: MediaMessageProps) {
  const { blobUrl, thumbnailBlobUrl, loading, error, retry } = useMediaLoader(
    objectKey,
    roomKey,
    iv,
    mimeType,
    thumbnailKey,
    thumbnailIv
  );

  if (error) {
    return (
      <div className="flex aspect-video cursor-pointer items-center justify-center border border-neutral-800 bg-neutral-950 rounded-sm" onClick={retry}>
        <AlertTriangle size={16} className="text-neutral-600" />
        <span className="ml-1.5 text-[10px] text-neutral-600">Failed to load media</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="animate-pulse bg-neutral-800 rounded-sm"
        style={{ aspectRatio: `${width} / ${height}`, maxHeight: 384 }}
      />
    );
  }

  if (!blobUrl) return null;

  if (type === "image") {
    return (
      <div className="relative overflow-hidden">
        <img
          src={blobUrl}
          alt="Shared image"
          className="max-h-96 w-full rounded-sm object-contain"
          style={{ aspectRatio: `${width} / ${height}` }}
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden">
      <video
        src={blobUrl}
        poster={thumbnailBlobUrl ?? undefined}
        controls
        preload="metadata"
        className="max-h-96 w-full rounded-sm"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        Your browser does not support video playback.
      </video>
    </div>
  );
}
