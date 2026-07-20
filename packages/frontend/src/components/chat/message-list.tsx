"use client";

import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaMetadata, GifMetadata, ReplyToInfo } from "@/lib/models";
import { MediaMessage } from "./media-message";
import { decryptReplyPreview } from "@/lib/quoted-message";
import { getRoomKeyVersion } from "@/lib/crypto";

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
  progress?: number;
  progressStage?: "compressing" | "uploading" | "failed";
}

interface MessageBubbleProps {
  message: UiMessage;
  showSender?: boolean;
  roomKey?: CryptoKey;
  roomId?: string;
  onReply?: (message: UiMessage) => void;
  onEdit?: (message: UiMessage) => void;
  onDelete?: (message: UiMessage) => void;
  onQuoteClick?: (messageId: string) => void;
  onShowMenu?: (message: UiMessage, x: number, y: number) => void;
  onImageClick?: (message: UiMessage) => void;
  highlighted?: boolean;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const SWIPE_THRESHOLD = 60;
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;
const SWIPE_LOCK_ANGLE = 30; // degrees — must be mostly horizontal

// Detect touch-capable device once
const isTouchDevice = typeof window !== "undefined" && "ontouchstart" in window;

export function MessageBubble({
  message,
  showSender,
  roomKey,
  roomId,
  onReply,
  onEdit,
  onDelete,
  onQuoteClick,
  onShowMenu,
  onImageClick,
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
    fired: false,       // long-press fired
    swiping: false,     // locked into swipe gesture
    scrolling: false,   // locked into scroll gesture
  });
  const bubbleRef = useRef<HTMLDivElement>(null);
  // We attach touch listeners imperatively so we can use { passive: false }
  const touchRootRef = useRef<HTMLDivElement>(null);

  // Decrypt reply preview once
  const [replyPreview, setReplyPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!message.replyTo) return;

    let cancelled = false;
    let keyPromise: Promise<CryptoKey | null>;

    // If the preview was encrypted with a specific key version, look it up.
    // Otherwise fall back to the current roomKey (backward compat with old messages).
    if (message.replyTo.previewKeyVersion != null && roomId) {
      keyPromise = getRoomKeyVersion(roomId, message.replyTo.previewKeyVersion);
    } else if (roomKey) {
      keyPromise = Promise.resolve(roomKey);
    } else {
      setReplyPreview("message unavailable");
      return;
    }

    keyPromise.then((key) => {
      if (cancelled || !key) {
        if (!cancelled) setReplyPreview("message unavailable");
        return;
      }
      return decryptReplyPreview(message.replyTo!, key);
    }).then((preview) => {
      if (!cancelled && preview) setReplyPreview(preview);
    }).catch(() => {
      if (!cancelled) setReplyPreview("message unavailable");
    });

    return () => { cancelled = true; };
  }, [message.replyTo, roomKey, roomId]);

  // ── Gesture handlers (touch events, imperative, passive:false) ──────

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

  // Imperative touch listeners attached with { passive: false } so we can
  // call preventDefault() to suppress browser text-selection and the
  // native "copy" callout on long-press.
  useEffect(() => {
    if (!isTouchDevice) return;
    const el = touchRootRef.current;
    if (!el) return;

    const g = gestureRef.current;

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      g.startX = touch.clientX;
      g.startY = touch.clientY;
      g.fired = false;
      g.swiping = false;
      g.scrolling = false;

      // NOTE: We do NOT call e.preventDefault() here because that would block
      // click events on buttons inside the bubble (e.g. reply-to strip, retry).
      // Instead, CSS user-select:none on the bubble prevents text selection,
      // and we suppress the native "copy" callout by not using pointer events.

      longPressTimerRef.current = setTimeout(() => {
        if (g.swiping || g.scrolling) return;
        g.fired = true;
        setShowInfoBtn(true);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        onShowMenu?.(
          message,
          isOwn ? rect.left + rect.width : rect.left,
          rect.top
        );
      }, LONG_PRESS_MS);
    }

    function onTouchMove(e: TouchEvent) {
      const touch = e.touches[0];
      const dx = touch.clientX - g.startX;
      const dy = touch.clientY - g.startY;
      const dist = Math.hypot(dx, dy);

      // Once locked into scrolling, let the list scroll freely
      if (g.scrolling) return;

      // Determine gesture direction lock after moving past tolerance
      if (!g.swiping && dist > MOVE_TOLERANCE) {
        const angleRad = Math.abs(Math.atan2(dy, dx));
        const angleDeg = angleRad * (180 / Math.PI);
        // Horizontal if angle < SWIPE_LOCK_ANGLE or > 180 - SWIPE_LOCK_ANGLE
        const isHorizontal = angleDeg < SWIPE_LOCK_ANGLE || angleDeg > 180 - SWIPE_LOCK_ANGLE;

        if (isHorizontal) {
          g.swiping = true;
        } else {
          g.scrolling = true;
          // Cancel long-press when user is clearly scrolling
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
          return;
        }
      }

      // Cancel long-press if we moved significantly
      if (dist > MOVE_TOLERANCE && longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (g.swiping && el) {
        // Prevent the page from scrolling while swiping a bubble
        e.preventDefault();

        // Own messages swipe left (negative dx), others swipe right (positive dx)
        const effectiveDelta = isOwn ? -dx : dx;
        if (effectiveDelta > 0) {
          const maxSwipe = el.offsetWidth * 0.45;
          // Rubber-band effect: resistance increases past threshold
          const clamped = Math.min(effectiveDelta, maxSwipe);
          setSwipeDelta(clamped);
        } else {
          setSwipeDelta(0);
        }
      }
    }

    function onTouchEnd() {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (!g.fired && g.swiping) {
        // Read state via a ref snapshot to avoid stale closure
        setSwipeDelta((prev) => {
          if (prev >= SWIPE_THRESHOLD) {
            // Trigger reply after state flush
            setTimeout(() => onReply?.(message), 0);
          }
          return 0;
        });
      } else {
        g.fired = false;
        setSwipeDelta(0);
      }

      g.swiping = false;
      g.scrolling = false;
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    // Suppress the native OS context menu (long-press copy callout on iOS/Android).
    // We check that no mouse button was pressed to distinguish a touch long-press
    // from a desktop right-click (which should still reach our React handler).
    const onNativeContextMenu = (e: MouseEvent) => {
      // e.button === -1 indicates the event was NOT triggered by a mouse button,
      // i.e. it was triggered by a touch long-press.
      if (e.button === -1 || e.buttons === 0) {
        e.preventDefault();
      }
    };
    el.addEventListener("contextmenu", onNativeContextMenu);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("contextmenu", onNativeContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwn, message, onShowMenu, onReply]);

  return (
    <div
      id={`msg-${message.id}`}
      ref={touchRootRef}
      className={`flex select-none ${isOwn ? "justify-end" : "justify-start"}`}
    >
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
            onContextMenu={handleContextMenuEvent}
            className={`relative text-sm leading-relaxed ${
              swipeDelta > 0 ? "transition-none" : "transition-transform duration-200 ease-out"
            } ${
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
              userSelect: "none",
              WebkitUserSelect: "none",
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
                ivBase={"ivBase" in meta ? meta.ivBase : undefined}
                chunkSize={"chunkSize" in meta ? meta.chunkSize : undefined}
                isOwn={isOwn}
                onImageClick={onImageClick ? () => onImageClick(message) : undefined}
                localUrl={meta.localUrl}
                progress={message.progress}
                progressStage={message.progressStage}
                status={message.status}
                onRetry={message.onRetry}
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

            {/* ── Caption (from media metadata) ── */}
            {isMedia && meta && "caption" in meta && meta.caption && (
              <p className="whitespace-pre-wrap break-words px-3 pt-1 text-sm leading-relaxed">
                {meta.caption}
              </p>
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
  roomId?: string;
  onReply?: (message: UiMessage) => void;
  onEdit?: (message: UiMessage) => void;
  onDelete?: (message: UiMessage) => void;
  onQuoteClick?: (messageId: string) => void;
  onShowMenu?: (message: UiMessage, x: number, y: number) => void;
  onImageClick?: (message: UiMessage) => void;
  jumpTargetId?: string | null;
  /** When true, suppresses the empty-state placeholder (e.g. during bootstrapping). */
  hideEmpty?: boolean;
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
  roomId,
  onReply,
  onEdit,
  onDelete,
  onQuoteClick,
  onShowMenu,
  onImageClick,
  jumpTargetId,
  hideEmpty,
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
      style={{ touchAction: "pan-y", overscrollBehavior: "contain" }}
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
        hideEmpty ? null : (
          <div className="flex h-full min-h-[200px] items-center justify-center">
            <p className="text-xs text-neutral-500">No messages yet. Say hello.</p>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              showSender
              roomKey={roomKey}
              roomId={roomId}
              onReply={onReply}
              onImageClick={onImageClick}
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
