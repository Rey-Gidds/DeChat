"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  Loader2,
  SendHorizonal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { UiMessage } from "./message-list";
import { useMediaLoader } from "@/lib/media-storage";

type ViewerMode = "view" | "send";

interface ImageViewerProps {
  mode: ViewerMode;
  open: boolean;
  onClose: () => void;

  // ── View mode (received message) ──
  message?: UiMessage | null;
  roomKey?: CryptoKey;

  // ── Send mode (local file before upload) ──
  file?: File | null;
  sending?: boolean;
  onSend?: (file: File, caption: string) => void;

  // ── View mode only: reply ──
  onReply?: (messageId: string, replyText?: string) => void;
}

const ZOOM_LEVELS = [1, 2, 3] as const;

export function ImageViewer({
  mode,
  open,
  onClose,
  message,
  roomKey,
  file,
  sending,
  onSend,
  onReply,
}: ImageViewerProps) {
  // -- View-mode state --
  const meta = message?.mediaMetadata;
  const { blobUrl: remoteBlobUrl, loading, error, retry } = useMediaLoader(
    mode === "view" && open && meta?.objectKey ? meta.objectKey : undefined,
    mode === "view" && open ? roomKey : undefined,
    mode === "view" && open && meta?.iv ? meta.iv : undefined,
    mode === "view" && open && meta?.mimeType ? meta.mimeType : undefined,
  );

  // -- Send-mode state (local preview) --
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const captionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode !== "send" || !file) {
      setLocalPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPreviewUrl(url);
    setCaption("");
    return () => URL.revokeObjectURL(url);
  }, [mode, file]);

  // Auto-focus reply/caption input
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (mode === "send") {
          captionRef.current?.focus();
          setTimeout(() => {
            captionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }, 150);
        }
      }, 200);
    }
  }, [open, mode]);

  // Keyboard avoidance — track visualViewport gap
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      const layoutH = window.innerHeight;
      const visualH = vv!.height;
      const offsetTop = vv!.offsetTop;
      const gap = Math.max(0, layoutH - visualH - offsetTop);
      setKeyboardOffset(gap);
    }
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [open]);

  // -- Shared state --
  const [scaleIndex, setScaleIndex] = useState(0);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const replyInputRef = useRef<HTMLInputElement>(null);

  // Reset zoom / text when content changes
  useEffect(() => {
    setScaleIndex(0);
    setReplyText("");
    setSendingReply(false);
  }, [message?.id, file?.name]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // -- Handlers --
  const handleDownload = useCallback(() => {
    if (!remoteBlobUrl || !meta) return;
    const ext = (meta.mimeType.split("/")[1] || "png").replace("webp", "webp");
    const a = document.createElement("a");
    a.href = remoteBlobUrl;
    a.download = `image.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [remoteBlobUrl, meta]);

  const handleDoubleTap = useCallback(() => {
    setScaleIndex((prev) => (prev + 1) % ZOOM_LEVELS.length);
  }, []);

  const zoomIn = useCallback(() => {
    setScaleIndex((prev) => Math.min(prev + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const zoomOut = useCallback(() => {
    setScaleIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleReplySend = useCallback(() => {
    if (!replyText.trim() || !message || sendingReply) return;
    const textToSend = replyText.trim();
    setSendingReply(true);
    onReply?.(message.id, textToSend);
    setReplyText("");
    setSendingReply(false);
    onClose();
  }, [replyText, message, sendingReply, onReply, onClose]);

  const handleReplyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleReplySend();
      }
    },
    [handleReplySend]
  );

  const handleSendClick = useCallback(() => {
    if (!file || sending || !onSend) return;
    onSend(file, caption.trim());
  }, [file, sending, caption, onSend]);

  const handleSendKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendClick();
      }
    },
    [handleSendClick]
  );

  // -- Guards --
  if (!open) return null;
  if (mode === "view" && (!message || meta?.type !== "image")) return null;
  if (mode === "send" && !file) return null;

  const isVideo =
    mode === "send" && file
      ? file.type.startsWith("video/")
      : false;

  const currentScale = ZOOM_LEVELS[scaleIndex];
  const imgUrl = mode === "send" ? localPreviewUrl : remoteBlobUrl;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={mode === "send" ? "Send media preview" : "Image viewer"}
    >
      {/* ── Top bar ── */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={mode === "send" && sending}
          className="flex h-10 w-10 items-center justify-center text-neutral-400 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Close"
        >
          <X size={22} />
        </button>

        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <button
            type="button"
            onClick={zoomOut}
            disabled={scaleIndex === 0}
            className="flex h-9 w-9 items-center justify-center text-neutral-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Zoom out"
          >
            <ZoomOut size={18} />
          </button>
          <span className="min-w-[3ch] text-center text-xs text-neutral-500 tabular-nums">
            {currentScale}×
          </span>
          <button
            type="button"
            onClick={zoomIn}
            disabled={scaleIndex >= ZOOM_LEVELS.length - 1}
            className="flex h-9 w-9 items-center justify-center text-neutral-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Zoom in"
          >
            <ZoomIn size={18} />
          </button>

          {/* Download — view mode only */}
          {mode === "view" && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={!remoteBlobUrl}
              className="flex h-9 w-9 items-center justify-center text-neutral-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Download image"
            >
              <Download size={18} />
            </button>
          )}
        </div>
      </div>

      {/* ── Image / Video area ── */}
      <div className="flex flex-1 items-center justify-center overflow-auto px-4">
        {/* Loading state (view mode only) */}
        {mode === "view" && loading && (
          <div className="flex flex-col items-center gap-3 text-neutral-500">
            <Loader2 size={28} className="animate-spin" />
            <span className="text-xs uppercase tracking-wider">Loading...</span>
          </div>
        )}

        {/* Error state (view mode only) */}
        {mode === "view" && error && (
          <div className="flex flex-col items-center gap-3 text-neutral-500">
            <span className="text-sm">Failed to load image</span>
            <button
              type="button"
              onClick={retry}
              className="border border-neutral-700 px-4 py-1.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:border-neutral-500 hover:text-white transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Image — loading state only applies in view mode */}
        {(mode === "send" || !loading) && imgUrl && !isVideo && (
          <img
            src={imgUrl}
            alt="Preview"
            onDoubleClick={handleDoubleTap}
            className="max-h-[calc(100vh-200px)] max-w-full select-none transition-transform duration-200 ease-out"
            style={{
              transform: `scale(${currentScale})`,
              cursor: currentScale > 1 ? "grab" : "zoom-in",
            }}
            draggable={false}
          />
        )}

        {/* Video (send mode only — received videos use native <video>) */}
        {(mode === "send" || !loading) && isVideo && localPreviewUrl && (
          <video
            src={localPreviewUrl}
            controls
            className="max-h-[calc(100vh-200px)] max-w-full rounded-sm"
          />
        )}
      </div>

      {/* ── Bottom bar ── */}
      <div
        className="shrink-0 border-t border-neutral-800 bg-black px-4 py-3"
        style={{ paddingBottom: `calc(12px + ${keyboardOffset}px)` }}
      >
        {mode === "view" ? (
          /* View mode: reply input */
          <div className="flex items-center gap-2">
            <div className="flex min-h-[44px] flex-1 items-center border border-neutral-700 bg-neutral-900 px-3 py-2 transition-colors focus-within:border-white">
              <input
                ref={replyInputRef}
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                placeholder={`Reply to ${message?.senderName || "Anonymous"}...`}
                maxLength={500}
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
              />
            </div>

            <button
              type="button"
              onClick={handleReplySend}
              disabled={!replyText.trim() || sendingReply}
              className="flex h-11 w-11 shrink-0 items-center justify-center bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send reply"
            >
              <SendHorizonal size={20} />
            </button>
          </div>
        ) : (
          /* Send mode: caption input + send button */
          <div className="flex items-end gap-2">
            <div
              className="flex min-h-[44px] flex-1 items-end border border-neutral-700 bg-neutral-900 px-3 py-2 transition-colors focus-within:border-white"
              style={{ alignSelf: "flex-end" }}
            >
              <textarea
                ref={captionRef}
                rows={1}
                value={caption}
                onChange={(e) => {
                  setCaption(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
                }}
                onKeyDown={handleSendKeyDown}
                disabled={sending}
                placeholder="Add a caption..."
                maxLength={200}
                style={{ resize: "none", overflowY: "hidden", minHeight: "24px", maxHeight: "80px" }}
                className="min-h-[24px] w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-500"
              />
            </div>

            <button
              type="button"
              onClick={handleSendClick}
              disabled={!file || sending}
              style={{ alignSelf: "flex-end" }}
              className="flex h-11 w-11 shrink-0 items-center justify-center bg-white text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send media"
            >
              {sending ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <ArrowUp size={20} />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
