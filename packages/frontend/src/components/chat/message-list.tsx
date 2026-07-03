"use client";

import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaMetadata, GifMetadata, ReplyToInfo } from "@/lib/models";
import { MediaMessage } from "./media-message";
import { decryptReplyPreview } from "@/lib/quoted-message";

export interface UiMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  isOwn?: boolean;
  senderName?: string | null;
  senderUserIndex?: number | null;
  messageType?: "text" | "image" | "video" | "gif";
  mediaMetadata?: MediaMetadata;
  gifMetadata?: GifMetadata;
  // ── Reply / Edit ──────────────────────────────────────────────────
  replyTo?: ReplyToInfo | null;
  editedAt?: string | null;
  // ── Outbox / Optimistic State ─────────────────────────────────────
  status?: "pending" | "retrying" | "failed";
  clientMessageId?: string;
  onRetry?: () => void;
}

interface MessageBubbleProps {
  message: UiMessage;
  showSender?: boolean;
  roomKey?: CryptoKey;
  onReply?: (message: UiMessage) => void;
  onEdit?: (message: UiMessage) => void;
  onDelete?: (message: UiMessage) => void;
  onQuoteClick?: (messageId: string) => void;
  onShowMenu?: (message: UiMessage, x: number, y: number) => void;
  highlighted?: boolean;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const SWIPE_THRESHOLD = 60;
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

// Detect touch-capable device once
const isTouchDevice = typeof window !== "undefined" && "ontouchstart" in window;

export function MessageBubble({
  message,
  showSender,
  roomKey,
  onReply,
  onEdit,
  onDelete,
  onQuoteClick,
  onShowMenu,
  highlighted,
}: MessageBubbleProps) {
  const isOwn = message.isOwn;
  const isMedia = message.messageType === "image" || message.messageType === "video";
  const isGif = message.messageType === "gif";
  const meta = message.mediaMetadata;
  const gifMeta = message.gifMetadata;
  const [swipeDelta, setSwipeDelta] = useState(0);
  const [showInfoBtn, setShowInfoBtn] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureRef = useRef({
    startX: 0,
    startY: 0,
    fired: false,
  });
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Decrypt reply preview once
  const [replyPreview, setReplyPreview] = useState<string | null>(null);
  const replyDecoded = useRef(false);

  if (message.replyTo && !replyDecoded.current) {
    replyDecoded.current = true;
    if (roomKey) {
      decryptReplyPreview(message.replyTo, roomKey).then(setReplyPreview);
    } else {
      setReplyPreview("message unavailable");
    }
  }

  // Show info button briefly on hover (desktop only, via CSS already)
  // On mobile we show it when long-press fires or as fallback

  // ── Gesture handlers ──────────────────────────────────────────────

  // Only attach swipe/long-press on touch devices
  const enableGestures = isTouchDevice;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enableGestures) return;
      // Ignore non-primary mouse buttons
      if (e.pointerType === "mouse" && e.button !== 0) return;

      const g = gestureRef.current;
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.fired = false;

      // Long-press timer
      longPressTimerRef.current = setTimeout(() => {
        g.fired = true;
        setShowInfoBtn(true);
        // Open context menu at the bubble's position
        const rect = e.currentTarget.getBoundingClientRect();
        onShowMenu?.(
          message,
          isOwn ? rect.left + rect.width : rect.left,
          rect.top
        );
      }, LONG_PRESS_MS);
    },
    [enableGestures, isOwn, message, onShowMenu]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enableGestures) return;
      const g = gestureRef.current;
      if (g.fired) return;

      const deltaX = e.clientX - g.startX;
      const deltaY = e.clientY - g.startY;

      // Cancel long press if moved too much
      if (Math.hypot(deltaX, deltaY) > MOVE_TOLERANCE) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }

      // Swipe-to-reply: only if horizontal movement dominates
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > MOVE_TOLERANCE) {
        const direction = isOwn ? "left" : "right";
        const effectiveDelta = direction === "right" ? deltaX : -deltaX;

        if (effectiveDelta > 0) {
          // Clamp the swipe to the bubble's own width so it never leaves the chat box
          const bubbleEl = bubbleRef.current;
          const maxSwipe = bubbleEl ? bubbleEl.offsetWidth * 0.5 : 120;
          setSwipeDelta(Math.min(effectiveDelta, maxSwipe));
        }
      }
    },
    [enableGestures, isOwn]
  );

  const handlePointerUp = useCallback(() => {
    if (!enableGestures) return;

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    const g = gestureRef.current;
    if (g.fired) {
      g.fired = false;
      return;
    }

    // Check if swipe crossed threshold by recomputing delta
    // Since we don't have the final pointer coords here,
    // we check the last known swipeDelta
    if (swipeDelta >= SWIPE_THRESHOLD) {
      onReply?.(message);
    }

    // Spring back — CSS transition handles the animation
    setSwipeDelta(0);
  }, [enableGestures, swipeDelta, onReply, message]);

  const handleContextMenuEvent = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onShowMenu?.(
        message,
        isOwn ? rect.left + rect.width : rect.left,
        rect.top
      );
    },
    [isOwn, message, onShowMenu]
  );

  // Additional pointer up handler on window to catch up events outside the bubble
  useEffect(() => {
    if (!enableGestures) return;
    const handleWindowUp = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      const g = gestureRef.current;
      if (g.fired) {
        g.fired = false;
        return;
      }
      if (swipeDelta >= SWIPE_THRESHOLD) {
        onReply?.(message);
      }
      setSwipeDelta(0);
    };
    window.addEventListener("pointerup", handleWindowUp);
    return () => window.removeEventListener("pointerup", handleWindowUp);
  }, [enableGestures, swipeDelta, onReply, message]);

  return (
    <div id={`msg-${message.id}`} className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] sm:max-w-[70%] ${
          isOwn ? "items-end" : "items-start"
        } flex flex-col gap-0.5`}
      >
        {showSender && !isOwn && (
          <span className="px-1 text-[10px] uppercase tracking-wider text-neutral-500">
            {message.senderName || "Anonymous"}
            {message.senderUserIndex != null ? `#${message.senderUserIndex}` : ""}
          </span>
        )}

        {/* Message row: bubble + info button side by side */}
        <div data-bubble-row className="flex items-end gap-1.5">
          {/* Info button on the left for own messages */}
          {isOwn && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const rect = bubbleRef.current?.getBoundingClientRect();
                if (rect) {
                  onShowMenu?.(message, rect.left, rect.top);
                }
              }}
              onMouseEnter={() => setShowInfoBtn(true)}
              onMouseLeave={() => setShowInfoBtn(false)}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-all duration-150 ${
                showInfoBtn ? "opacity-100" : "opacity-0"
              }`}
              aria-label="Message actions"
            >
              <MoreHorizontal size={14} />
            </button>
          )}

          {/* The actual bubble */}
          <div
            ref={bubbleRef}
            data-bubble-body
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => {
              if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
              }
            }}
            onContextMenu={handleContextMenuEvent}
            className={`relative text-sm leading-relaxed transition-transform duration-200 ease-out ${
              isOwn
                ? "bg-white text-black"
                : "border border-neutral-700 bg-neutral-900 text-neutral-100"
            } ${isMedia || isGif ? "p-0 overflow-hidden" : "px-3 py-2"} ${
              highlighted ? "shadow-[-3px_0_0_0_rgba(96,165,250,0.4)]" : ""
            }`}
            style={{
              transform:
                swipeDelta > 0
                  ? isOwn
                    ? `translateX(${-swipeDelta}px)`
                    : `translateX(${swipeDelta}px)`
                  : undefined,
            }}
          >
            {/* ── Reply strip ── */}
            {message.replyTo && (
              <button
                onClick={() => onQuoteClick?.(message.replyTo!.messageId)}
                className="mb-1.5 flex w-full cursor-pointer border-l-2 border-neutral-700 bg-neutral-800/50 pl-2 pr-1 pt-1 pb-0.5 text-left hover:bg-neutral-800 transition-colors"
              >
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-neutral-300">
                    {message.replyTo.senderName}
                    {message.replyTo.senderUserIndex != null
                      ? ` #${message.replyTo.senderUserIndex}`
                      : ""}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {replyPreview ?? "..."}
                  </span>
                </div>
              </button>
            )}

            {/* ── Media / GIF / Text body ── */}
            {isMedia && meta && roomKey ? (
              <MediaMessage
                objectKey={meta.objectKey}
                roomKey={roomKey}
                iv={meta.iv}
                mimeType={meta.mimeType}
                type={meta.type}
                width={meta.width}
                height={meta.height}
                thumbnailKey={"thumbnailKey" in meta ? meta.thumbnailKey : undefined}
                thumbnailIv={"thumbnailIv" in meta ? meta.thumbnailIv : undefined}
                isOwn={isOwn}
              />
            ) : isGif && gifMeta ? (
              <div className="relative overflow-hidden rounded-sm">
                <video
                  src={gifMeta.gifUrl}
                  poster={gifMeta.previewUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="max-h-80 w-full object-contain"
                  onError={(e) => {
                    (e.target as HTMLVideoElement).src = gifMeta.fallbackUrl;
                  }}
                />
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            )}

            {/* ── Timestamp + status + edited tag ── */}
            <span
              className={`mt-1 flex items-center gap-1 text-right text-[10px] ${
                isOwn ? "text-neutral-600" : "text-neutral-500"
              } ${isMedia || isGif ? "px-3 pb-2" : ""}`}
            >
              {formatTime(message.createdAt)}

              {message.editedAt && (
                <span className="text-[9px] italic text-neutral-500">edited</span>
              )}

              {/* Outbox status indicators (isOwn only) */}
              {message.isOwn && message.status === "pending" && (
                <span className="inline-block text-[9px] text-neutral-500 animate-pulse">●</span>
              )}
              {message.isOwn && message.status === "retrying" && (
                <span className="inline-block text-[9px] text-amber-500 animate-pulse">Sending…</span>
              )}
              {message.isOwn && message.status === "failed" && (
                <button
                  onClick={message.onRetry}
                  className="inline-flex items-center gap-1 text-[9px] text-red-500 hover:text-red-400 transition-colors"
                >
                  ⚠ Failed · Retry
                </button>
              )}

              {isGif && (
                <span className="text-[10px] uppercase text-neutral-500">GIF</span>
              )}
            </span>
          </div>

          {/* Info button on the right for received messages */}
          {!isOwn && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const rect = bubbleRef.current?.getBoundingClientRect();
                if (rect) {
                  onShowMenu?.(message, rect.left + rect.width, rect.top);
                }
              }}
              onMouseEnter={() => setShowInfoBtn(true)}
              onMouseLeave={() => setShowInfoBtn(false)}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-all duration-150 ${
                showInfoBtn ? "opacity-100" : "opacity-0"
              }`}
              aria-label="Message actions"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: UiMessage[];
  loadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  loadingNewer?: boolean;
  hasNewer?: boolean;
  onLoadNewer?: () => void;
  listRef: React.Ref<HTMLDivElement>;
  onScroll: () => void;
  roomKey?: CryptoKey;
  onReply?: (message: UiMessage) => void;
  onEdit?: (message: UiMessage) => void;
  onDelete?: (message: UiMessage) => void;
  onQuoteClick?: (messageId: string) => void;
  onShowMenu?: (message: UiMessage, x: number, y: number) => void;
  jumpTargetId?: string | null;
}

export function MessageList({
  messages,
  loadingOlder,
  hasMore,
  onLoadOlder,
  loadingNewer,
  hasNewer,
  onLoadNewer,
  listRef,
  onScroll,
  roomKey,
  onReply,
  onEdit,
  onDelete,
  onQuoteClick,
  onShowMenu,
  jumpTargetId,
}: MessageListProps) {
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // ── IntersectionObserver for infinite scroll ──
  useEffect(() => {
    const topEl = topSentinelRef.current;
    const bottomEl = bottomSentinelRef.current;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topEl && !loadingOlder && hasMore) {
            onLoadOlder();
          }
          if (entry.target === bottomEl && !loadingNewer && hasNewer) {
            onLoadNewer?.();
          }
        }
      },
      { rootMargin: "200px 0px" }
    );

    if (topEl) observer.observe(topEl);
    if (bottomEl) observer.observe(bottomEl);

    return () => observer.disconnect();
  }, [loadingOlder, hasMore, onLoadOlder, loadingNewer, hasNewer, onLoadNewer]);

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto bg-grid-blueprint px-3 py-4 sm:px-4"
    >
      {/* ── Top sentinel: triggers infinite scroll upward ── */}
      <div ref={topSentinelRef} className="h-px" />
      {loadingOlder && (
        <div className="mb-3 flex justify-center">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-500 border-t-transparent" />
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              Loading...
            </span>
          </div>
        </div>
      )}

      {messages.length === 0 ? (
        <div className="flex h-full min-h-[200px] items-center justify-center">
          <p className="text-xs text-neutral-500">No messages yet. Say hello.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              showSender
              roomKey={roomKey}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onQuoteClick={onQuoteClick}
              onShowMenu={onShowMenu}
              highlighted={jumpTargetId === message.id}
            />
          ))}
        </div>
      )}

      {/* ── Bottom sentinel: triggers infinite scroll downward (after quote jump) ── */}
      <div ref={bottomSentinelRef} className="h-px" />
      {loadingNewer && (
        <div className="mt-3 flex justify-center">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 animate-spin rounded-full border border-neutral-500 border-t-transparent" />
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              Loading...
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
