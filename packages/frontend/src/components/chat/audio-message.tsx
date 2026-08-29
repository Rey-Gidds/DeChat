"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, AlertTriangle } from "lucide-react";
import { useMediaLoader } from "@/lib/media-storage";
import type { ProgressiveAudioParams } from "@/lib/media-storage";

// ── Module-level singleton: only one audio plays at a time across all instances ──
let activeAudio: HTMLAudioElement | null = null;

function claimPlayback(audio: HTMLAudioElement) {
  if (activeAudio && activeAudio !== audio && !activeAudio.paused) {
    activeAudio.pause();
  }
  activeAudio = audio;
}

interface AudioMessageProps {
  objectKey: string;
  roomKey: CryptoKey;
  mimeType: string;
  iv?: string;           // Single-block IV (new recordings)
  chunkIvMap?: string[]; // Legacy chunked IVs (backward compat)
  chunkSize?: number;    // Legacy chunked size (backward compat)
  duration?: number;
  isOwn?: boolean;
  localUrl?: string;
  progress?: number;
  progressStage?: "compressing" | "uploading" | "failed";
  status?: "pending" | "retrying" | "failed";
  onRetry?: () => void;
}

export function AudioMessage({
  objectKey,
  roomKey,
  mimeType,
  iv,
  chunkIvMap,
  chunkSize,
  duration,
  isOwn,
  localUrl,
  progress,
  progressStage,
  status,
  onRetry,
}: AudioMessageProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(duration || 0);

  // Sync state duration when prop updates
  useEffect(() => {
    if (duration) {
      setPlaybackDuration(duration);
    }
  }, [duration]);

  // Backward-compat: old messages used chunked encryption, new ones use single-block.
  // If we only have chunkIvMap (no top-level iv), pass them as progressiveAudioParams
  // so fetchAndDecryptMedia can still decrypt them correctly.
  const progressiveParams: ProgressiveAudioParams | undefined =
    !iv && chunkIvMap && chunkSize
      ? { chunkIvMap, chunkSize }
      : undefined;

  const { blobUrl, loading, error, retry } = useMediaLoader(
    localUrl ? "" : objectKey,
    roomKey,
    localUrl ? undefined : (iv || chunkIvMap?.[0]), // pass iv directly
    mimeType,
    undefined,
    undefined,
    undefined, // progressiveVideoParams
    progressiveParams // only set for legacy chunked messages
  );

  const effectiveUrl = localUrl || blobUrl;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleLoadedMetadata = () => {
      if (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) {
        setPlaybackDuration(audio.duration);
      }
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);

    // Initial check in case it loaded instantly
    if (audio.duration && audio.duration !== Infinity && !isNaN(audio.duration)) {
      setPlaybackDuration(audio.duration);
    }

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, [effectiveUrl]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      claimPlayback(audio); // pause any other currently playing audio
      audio.play().catch((err) => console.warn("[AudioMessage] play() failed:", err));
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const value = parseFloat(e.target.value);
    audio.currentTime = value;
    setCurrentTime(value);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs === Infinity) return "0:00";
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // Generate dynamic premium looking waveform bars
  const totalBars = 20;
  const simulatedWaveform = [30, 45, 60, 25, 40, 75, 55, 30, 45, 65, 80, 50, 25, 40, 60, 45, 35, 50, 40, 30];

  const renderWaveform = () => {
    return (
      <div className="flex items-center space-x-[2px] h-6 px-1 flex-1">
        {simulatedWaveform.map((height, i) => {
          const progressPercent = playbackDuration > 0 ? (currentTime / playbackDuration) * 100 : 0;
          const barPercent = (i / totalBars) * 100;
          const isActive = barPercent <= progressPercent;

          return (
            <div
              key={i}
              className={`w-[3px] rounded-full transition-all duration-150 ${
                isActive
                  ? isOwn
                    ? "bg-neutral-800" // Visible dark grey played part on sender's white bubble
                    : "bg-emerald-500" // Emerald played part on receiver's dark bubble
                  : isOwn
                    ? "bg-neutral-300" // Muted light grey unplayed part on sender's white bubble
                    : "bg-neutral-600" // Dark grey unplayed part on receiver's dark bubble
              }`}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>
    );
  };

  if (status === "failed") {
    return (
      <div className="flex items-center space-x-3 bg-neutral-900 border border-red-500/30 rounded-lg p-3 max-w-[280px]">
        <AlertTriangle className="text-red-500 shrink-0" size={20} />
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-xs font-semibold text-neutral-200">Failed to send voice message</span>
          <button
            onClick={onRetry}
            className="text-[10px] font-bold text-red-400 hover:text-red-300 text-left transition-colors"
          >
            Retry Upload
          </button>
        </div>
      </div>
    );
  }

  if (error && !localUrl) {
    return (
      <div className="flex items-center space-x-3 bg-neutral-900 border border-neutral-800 rounded-lg p-3 max-w-[280px] cursor-pointer" onClick={retry}>
        <AlertTriangle className="text-neutral-500 shrink-0 animate-pulse" size={20} />
        <span className="text-xs text-neutral-400">Failed to load audio. Tap to retry.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center space-x-3 w-[240px] transition-all duration-200">
      {effectiveUrl && (
        <audio ref={audioRef} src={effectiveUrl} preload="auto" />
      )}

      {/* Play/Pause Trigger */}
      <button
        onClick={togglePlay}
        disabled={(!localUrl && loading) || progressStage === "uploading" || progressStage === "compressing"}
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 shrink-0 ${
          isOwn
            ? "bg-neutral-800 text-white hover:bg-neutral-700"
            : "bg-emerald-600 text-white hover:bg-emerald-500"
        }`}
      >
        {(!localUrl && loading) || progressStage === "uploading" || progressStage === "compressing" ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : isPlaying ? (
          <Pause size={14} fill="currentColor" />
        ) : (
          <Play size={14} className="ml-0.5" fill="currentColor" />
        )}
      </button>

      {/* Waveform / Slider Container */}
      <div className="flex flex-col flex-1 min-w-0 space-y-1 relative">
        {!localUrl && loading ? (
          <span className={`text-[10px] font-semibold animate-pulse ${isOwn ? "text-neutral-500" : "text-neutral-400"}`}>Loading audio...</span>
        ) : progressStage === "compressing" ? (
          <span className={`text-[10px] font-semibold ${isOwn ? "text-neutral-500" : "text-neutral-400"}`}>Encrypting...</span>
        ) : progressStage === "uploading" ? (
          <span className={`text-[10px] font-semibold ${isOwn ? "text-neutral-500" : "text-neutral-400"}`}>Uploading {progress}%...</span>
        ) : (
          <>
            <div className="relative flex items-center flex-1 h-6">
              {renderWaveform()}
              {/* Invisible range input overlaid for dragging timeline */}
              <input
                type="range"
                min="0"
                max={playbackDuration || 0.1}
                value={currentTime}
                onChange={handleSliderChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
            </div>
            <div className={`flex justify-between text-[9px] font-medium ${isOwn ? "text-neutral-500" : "text-neutral-400"}`}>
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(playbackDuration)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
