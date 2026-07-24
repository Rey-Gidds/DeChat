"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  connectToRoom,
  disconnectSocket,
  emitTypingStart,
  emitTypingStop,
  getSocket,
  sendEncryptedMessage,
  syncSince,
  editEncryptedMessage,
  deleteEncryptedMessage,
  startHeartbeat,
  stopHeartbeat,
  type RealtimeRoomMessage,
  type TypingEventPayload,
} from "@/lib/socket-client";
import { ReconnectionManager } from "@/lib/reconnection-manager";
import { AppLifecycle } from "@/lib/lifecycle";
import {
  decryptMessage,
  encryptMessage,
  getRoomKeyVersion,
  unwrapRoomKey,
  storeRoomKeyVersion,
  getPrivateKey,
  generateRoomKey,
  wrapRoomKeyForPublicKey,
  importPublicKey,
} from "@/lib/crypto";
import { encryptMedia, encryptMediaChunked } from "@/lib/media-crypto";
import { isSupportedImage, isSupportedVideo } from "@/lib/media-optimizer";
import { requestUploadUrl, uploadEncryptedBlob, clearMediaCache } from "@/lib/media-storage";
import { compressMedia } from "@/lib/media";
import type { CompressImageResult, CompressVideoResult } from "@/lib/media";
import {
  fetchMessageHistory,
  syncMessagesSince,
  fetchMessagesAround,
  resumeSync,
} from "@/lib/messages-client";
import {
  getCachedMessages,
  getRoomCacheMeta,
  appendToCache,
  replaceCache,
  evictLRURooms,
  removeFromCache,
  updateInCache,
  CACHE_WINDOW_SIZE,
  MAX_CACHED_ROOMS,
} from "@/lib/message-cache";
import { ChatInput } from "@/components/chat/chat-input";
import { GifPicker, type GifSelection } from "@/components/chat/gif-picker";
import { ImageViewer } from "@/components/chat/image-viewer";
import { MessageList, type UiMessage } from "@/components/chat/message-list";
import { MessageContextMenu } from "@/components/chat/message-context-menu";
import { DeleteConfirmDialog } from "@/components/chat/delete-confirm-dialog";
import { DownArrowButton } from "@/components/chat/down-arrow-button";
import { RoomHeader } from "@/components/chat/room-header";
import {
  RoomOptionsPage,
  LeaveConfirmDialog,
  SuccessionDialog,
  type RoomMemberEntry,
  type ViewerRole,
  type SuccessionMember,
} from "@/components/chat/room-settings";
import { useKeyHealth } from "@/components/key-recovery/provider";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import type { GifMetadata, ImageMetadata, VideoMetadata, ReplyToInfo } from "@/lib/models";
import { encryptMessagePreview } from "@/lib/quoted-message";
import Link from "next/link";
import {
  claimRotationLock,
  completeRotation,
  fetchMyKeyDistributions,
  syncKeyVersion,
  type RoomKeyRotationState,
} from "@/lib/key-rotation";
import {
  addOutboxEntry,
  deleteOutboxEntry,
  updateOutboxEntry,
  getOutboxEntriesByRoom,
  clearAllOutboxEntries,
  type OutboxEntry,
} from "@/lib/outbox-db";
import {
  buildOptimisticUiMessage,
  reconcileOptimisticMessage,
  findOutboxEntryByCipherprint,
  loadOptimisticMessages,
} from "@/lib/outbox-reconcile";
import { OutboxRetryWorker, flushRotationQueue } from "@/lib/outbox-worker";

type MembershipResponse = {
  membership?: {
    userId?: string;
    status?: string;
    isBlocked?: boolean;
  };
  error?: string;
};

type RoomMeta = {
  room: {
    id: string;
    name: string;
    roomLink: string;
    maxMembers: number;
    isDisabled?: boolean;
    joinPolicy?: string;
  };
  memberCount: number;
  membership: { status: string; role: string } | null;
};

type RoomMember = {
  userId: string;
  role: string;
  isOnline?: boolean;
  user: { name?: string; email?: string; pfp?: string | null } | null;
};

function mergeMessages(existing: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const msg of incoming) {
    if (msg.clientMessageId) {
      const optId = `optimistic:${msg.clientMessageId}`;
      if (map.has(optId)) {
        map.delete(optId);
      }
    }
    map.set(msg.id, msg);
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function probeLocalMediaDimensions(file: File, isImage: boolean): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    if (isImage) {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        resolve({ width: 640, height: 480 });
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } else {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        URL.revokeObjectURL(url);
      };
      video.onerror = () => {
        resolve({ width: 640, height: 360 });
        URL.revokeObjectURL(url);
      };
      video.src = url;
    }
  });
}

async function decryptBatch(
  records: RealtimeRoomMessage[],
  currentUserId: string,
  roomId: string
): Promise<UiMessage[]> {
  const results: UiMessage[] = [];
  const keyCache = new Map<number, CryptoKey>();

  for (const record of records) {
    try {
      const keyVersion = record.roomKeyVersion ?? 0;
      let roomKey = keyCache.get(keyVersion);

      if (!roomKey) {
        const fetchedKey = await getRoomKeyVersion(roomId, keyVersion);
        if (!fetchedKey) {
          console.warn(`Missing key version ${keyVersion} for room ${roomId}`);
          continue;
        }
        keyCache.set(keyVersion, fetchedKey);
        roomKey = fetchedKey;
      }

      const body = await decryptMessage(record, roomKey);

      // Map replyTo to the shape expected by UiMessage
      const replyTo: ReplyToInfo | null = record.replyTo
        ? {
            messageId: record.replyTo.messageId,
            senderId: record.replyTo.senderId,
            senderName: record.replyTo.senderName,
            senderUserIndex: record.replyTo.senderUserIndex ?? null,
            messageType: record.replyTo.messageType,
            previewIv: record.replyTo.previewIv ?? null,
            previewCiphertext: record.replyTo.previewCiphertext ?? null,
            previewAuthTag: record.replyTo.previewAuthTag ?? null,
          }
        : null;

      const base = {
        id: record.id,
        senderId: record.senderId,
        createdAt: record.createdAt,
        isOwn: record.senderId === currentUserId,
        senderName: record.senderName ?? null,
        senderUserIndex: record.senderUserIndex ?? null,
        senderPfp: record.senderPfp ?? null,
        replyTo,
        editedAt: record.editedAt ?? null,
        editCount: record.editCount ?? 0,
        clientMessageId: record.clientMessageId,
      };

      // Media messages have JSON metadata in the body
      if (record.messageType === "image" || record.messageType === "video") {
        let mediaMetadata: ImageMetadata | VideoMetadata;
        try {
          mediaMetadata = JSON.parse(body) as ImageMetadata | VideoMetadata;
        } catch {
          results.push({
            ...base,
            body,
            messageType: record.messageType,
          });
          continue;
        }

        results.push({
          ...base,
          body: record.messageType === "image" ? "📷 Image" : "🎬 Video",
          messageType: record.messageType,
          mediaMetadata,
        });
      } else if (record.messageType === "gif") {
        let gifMetadata: GifMetadata;
        try {
          gifMetadata = JSON.parse(body) as GifMetadata;
        } catch {
          results.push({
            ...base,
            body,
            messageType: record.messageType,
          });
          continue;
        }

        results.push({
          ...base,
          body: "📹 GIF",
          messageType: "gif",
          gifMetadata,
        });
      } else {
        results.push({
          ...base,
          body,
          messageType: "text",
        });
      }
    } catch {
      // Skip undecryptable messages
    }
  }
  return results;
}

const MAX_LOADED_MESSAGES = 500;

export default function RoomChatPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params?.roomId;
  const { openRecovery, hasPrivateKey } = useKeyHealth();
  const { data: session } = useSession();
  // Cached userId from better-auth session — available instantly on SPA navigations.
  const sessionUserId = session?.user?.id ?? null;

  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [mediaSending, setMediaSending] = useState(false);
  const [status, setStatus] = useState("");
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [cacheServed, setCacheServed] = useState(false);
  const [roomMeta, setRoomMeta] = useState<RoomMeta | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [successionDialogOpen, setSuccessionDialogOpen] = useState(false);
  const [successionMembers, setSuccessionMembers] = useState<SuccessionMember[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [currentUserId, setCurrentUserId] = useState("");
  const [roomDisabled, setRoomDisabled] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [pendingMediaFile, setPendingMediaFile] = useState<File | null>(null);
  const [viewerMessageId, setViewerMessageId] = useState<string | null>(null);
  const [downArrowLoading, setDownArrowLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  // Dismissable inline toast for non-blocking errors (quoted message deleted, etc.)
  const [toast, setToast] = useState<string | null>(null);

  // ── Reply / Edit / Delete state ──
  const [replyContext, setReplyContext] = useState<{
    messageId: string;
    senderId: string;
    senderName: string;
    messageType: "text" | "image" | "video" | "gif";
    preview: string;
  } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    message: UiMessage;
  } | null>(null);

  // ── Jump/quoted navigation state ──
  const [jumpTargetId, setJumpTargetId] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [newMessagesCount, setNewMessagesCount] = useState(0);
  const [hasNewer, setHasNewer] = useState(false);

  // ── Visual Viewport / keyboard avoidance (mobile) ────────────────────
  // On iOS Safari and Android Chrome, the software keyboard shrinks the
  // visualViewport but NOT the layout viewport. We track this gap and push
  // the whole shell up so the input box stays visible above the keyboard.
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      // The keyboard height is the difference between the layout viewport
      // and the visual viewport, minus any page scroll offset.
      const layoutH = window.innerHeight;
      const visualH = vv!.height;
      const offsetTop = vv!.offsetTop;
      // On iOS the visual viewport also shifts down; account for both.
      const gap = Math.max(0, layoutH - visualH - offsetTop);
      setKeyboardOffset(gap);
    }

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // When the keyboard opens (keyboardOffset > 0), scroll the message list
  // to the bottom so the latest messages stay visible above the input box.
  // This matches WhatsApp/Telegram behavior — the viewport shrinks but the
  // messages stay pinned to the bottom.
  useEffect(() => {
    if (keyboardOffset > 0 && shouldStickToBottomRef.current) {
      const el = listRef.current;
      if (!el) return;
      // Use requestAnimationFrame so the layout has settled before scrolling
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
      });
    }
  }, [keyboardOffset]);

  const roomKeyRef = useRef<CryptoKey | null>(null);
  const [roomKeyRotation, setRoomKeyRotation] = useState<RoomKeyRotationState>({
    pendingKeyRotation: false,
    lastKeyVersion: 0,
    currentKeyVersion: 0,
  });
  const [isRotating, setIsRotating] = useState(false);
  const rotationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workerRef = useRef<OutboxRetryWorker | null>(null);
  const reconnectionRef = useRef<ReconnectionManager | null>(null);
  const lifecycleRef = useRef<AppLifecycle | null>(null);
  const refreshMembersRef = useRef<() => void>(() => {});
  const backgroundFilesRef = useRef<Map<string, { file: File; caption?: string }>>(new Map());
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    (listRef as any).current = el;
    // Don't scroll here — the container is empty at mount.
    // Scroll is handled by the bootstrap timeout after messages render,
    // and by appendDecrypted for incoming/sent messages.
  }, []);
  const shouldStickToBottomRef = useRef(true);
  const lastMessageRef = useRef<{ createdAt: string; id: string } | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const typingSummary =
    typingUsers.length === 0
      ? ""
      : typingUsers.length === 1
        ? "Someone is typing..."
        : `${typingUsers.length} people are typing...`;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Scroll to bottom when options page is closed
  useEffect(() => {
    if (!showOptions && canChat && shouldStickToBottomRef.current) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        scrollToBottom("auto");
      });
    }
  }, [showOptions, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 80;
    const atBottom = distanceFromBottom < 100;
    setIsAtBottom(atBottom);
    if (atBottom) {
      setNewMessagesCount(0);
    }
  }, []);

  const appendDecrypted = useCallback(
    async (records: RealtimeRoomMessage[], stick = true) => {
      if (records.length === 0) return;
      const decrypted = await decryptBatch(records, currentUserId, roomId);
      if (decrypted.length === 0) return;

      setMessages((prev) => {
        const merged = mergeMessages(prev, decrypted);
        // Memory cap: trim from the opposite end if exceeding MAX_LOADED_MESSAGES
        if (merged.length > MAX_LOADED_MESSAGES) {
          return merged.slice(merged.length - MAX_LOADED_MESSAGES);
        }
        return merged;
      });

      const last = decrypted[decrypted.length - 1];
      lastMessageRef.current = { createdAt: last.createdAt, id: last.id };

      if (stick && shouldStickToBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom());
      }
    },
    [currentUserId, scrollToBottom, roomId]
  );

  const runSync = useCallback(async () => {
    if (!roomId) return;

    try {
      const meta = await getRoomCacheMeta(roomId);
      const resume = await resumeSync(
        roomId,
        meta?.newestCachedMessageId,
        meta?.newestCachedCreatedAt
      );

      if (resume.strategy === "UP_TO_DATE" || resume.messages.length === 0) return;

      const decrypted = await decryptBatch(resume.messages, currentUserId, roomId);

      if (resume.strategy === "DELTA") {
        setMessages((prev) => mergeMessages(prev, decrypted));
        await appendToCache(roomId, resume.messages, CACHE_WINDOW_SIZE);
      } else {
        const optimistic = await loadOptimisticMessages(roomId, currentUserId);
        setMessages(mergeMessages(decrypted, optimistic));
        await replaceCache(roomId, resume.messages);
      }
      await evictLRURooms(MAX_CACHED_ROOMS);
    } catch {
      // Sync failures are non-fatal; live socket may still deliver messages.
    }
  }, [roomId, currentUserId]);

  const loadOlder = useCallback(async () => {
    if (!roomId || !historyCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { messages: older, nextCursor } = await fetchMessageHistory(roomId, {
        cursor: historyCursor,
        limit: 30,
      });
      const decrypted = await decryptBatch(older, currentUserId, roomId);
      const el = listRef.current;
      const prevHeight = el?.scrollHeight ?? 0;

      setMessages((prev) => mergeMessages(decrypted, prev));
      setHistoryCursor(nextCursor);

      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [roomId, historyCursor, loadingOlder, currentUserId]);

  // ── Load newer (downward scrollback from a jumped position) ──
  const loadNewer = useCallback(async () => {
    if (!roomId || !newerCursor || !hasNewer) return;
    try {
      const { messages: newer, nextCursor } = await fetchMessageHistory(roomId, {
        cursor: newerCursor,
        limit: 30,
        direction: "newer",
      });
      const decrypted = await decryptBatch(newer, currentUserId, roomId);
      setMessages((prev) => mergeMessages(prev, decrypted));
      setNewerCursor(nextCursor);
      setHasNewer(Boolean(nextCursor));
    } catch {
      // silently fail
    }
  }, [roomId, newerCursor, hasNewer, currentUserId]);

  // ── Load newer sentinel (wraps loadNewer with loading guard) ──
  const loadNewerSentinel = useCallback(() => {
    if (!roomId || !newerCursor || !hasNewer || loadingNewer) return;
    setLoadingNewer(true);
    loadNewer().finally(() => setLoadingNewer(false));
  }, [roomId, newerCursor, hasNewer, loadingNewer, loadNewer]);

  // ── Handle click on a quoted message ──
  const handleQuoteClick = useCallback(
    async (messageId: string) => {
      if (!roomId || quoteLoading) return;
      setQuoteLoading(true);
      try {
        const response = await fetchMessagesAround(roomId, messageId, 25);

        // If the quoted message is from before the user joined, silently do nothing
        if (response.reason === "before_join") {
          setQuoteLoading(false);
          return;
        }

        // If the target message was deleted, show a dismissable toast
        if (!response.messages.length) {
          setQuoteLoading(false);
          setToast("The quoted message no longer exists.");
          return;
        }

        const decrypted = await decryptBatch(response.messages, currentUserId, roomId);

        // Clear highlight timeout from any previous quote jump
        if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);

        // Batch all state updates together before the scroll
        setMessages(decrypted);
        setHistoryCursor(response.olderCursor);
        setNewerCursor(response.newerCursor);
        setHasNewer(response.hasNewer);
        setJumpTargetId(response.targetMessageId);
        setIsAtBottom(false);
        setNewMessagesCount(0);
        setQuoteLoading(false);

        // Auto-clear highlight after 3 seconds
        highlightTimeoutRef.current = setTimeout(() => {
          setJumpTargetId(null);
        }, 3000);

        // Scroll to the target message after React commits the DOM
        requestAnimationFrame(() => {
          const el = document.getElementById(`msg-${response.targetMessageId}`);
          if (el) {
            el.scrollIntoView({ block: "center" });
          }
        });
      } catch {
        setQuoteLoading(false);
        setToast("The quoted message could not be loaded.");
      }
    },
    [roomId, currentUserId, quoteLoading]
  );

  // ── Scroll to bottom (down-arrow click) ──
  const handleScrollToBottom = useCallback(async () => {
    if (!roomId || downArrowLoading) return;
    setDownArrowLoading(true);

    try {
      // In quote-jump mode: batch-load ALL newer pages, set state once, then jump
      if (hasNewer && newerCursor) {
        let cursor: string | null = newerCursor;
        const allRaw: RealtimeRoomMessage[] = [];
        while (cursor) {
          const { messages: page, nextCursor } = await fetchMessageHistory(roomId, {
            cursor,
            limit: 30,
            direction: "newer",
          });
          allRaw.push(...page);
          cursor = nextCursor;
        }

        if (allRaw.length > 0) {
          const decrypted = await decryptBatch(allRaw, currentUserId, roomId);
          setMessages((prev) => mergeMessages(prev, decrypted));
        }
        setNewerCursor(null);
        setHasNewer(false);
      }

      // Single instant jump to the live tail after loading is done
      setIsAtBottom(true);
      setNewMessagesCount(0);
      requestAnimationFrame(() => scrollToBottom("auto"));
    } catch {
      // silently fail — user can try again
    } finally {
      setDownArrowLoading(false);
    }
  }, [roomId, downArrowLoading, hasNewer, newerCursor, currentUserId, scrollToBottom]);

  useEffect(() => {
    if (!roomId) return;

    let mounted = true;

    const bootstrap = async () => {
      try {
        // Phase 0: Instant render from IndexedDB cache
        const cached = await getCachedMessages(roomId);
        const isColdStart = cached.length === 0;

        // Pre-load room keys from IndexedDB so media and reply previews decrypt instantly.
        // Scan cached messages for unique key versions and load the highest one available.
        if (!isColdStart) {
          const keyVersions = new Set<number>();
          for (const msg of cached) {
            if (msg.roomKeyVersion != null) keyVersions.add(msg.roomKeyVersion);
          }
          const sorted = [...keyVersions].sort((a, b) => b - a);
          for (const version of sorted) {
            const cachedKey = await getRoomKeyVersion(roomId, version);
            if (cachedKey) {
              roomKeyRef.current = cachedKey;
              setRoomKeyRotation((prev) => ({
                ...prev,
                lastKeyVersion: version,
                currentKeyVersion: version,
              }));
              break;
            }
          }
        }

        // Use cached userId from session if available so isOwn is correct from the start.
        const phase0UserId = sessionUserId ?? "";
        const decryptedCache = await decryptBatch(cached, phase0UserId, roomId);
        const optimistic = await loadOptimisticMessages(roomId, phase0UserId);
        const usedCorrectUserId = sessionUserId != null;

        if (mounted) {
          setMessages(mergeMessages(decryptedCache, optimistic));
          // If we already know the userId (session cached), dismiss the overlay immediately
          // so the user sees the working set without waiting for network calls.
          if (usedCorrectUserId && !isColdStart) {
            scrollToBottom("auto");
            requestAnimationFrame(() => {
              setCacheServed(true);
              setIsBootstrapping(false);
            });
          }
          if (isColdStart) {
            setIsBootstrapping(true);
          }
        }

        // Phase 1: Parallel async fetches (excluding socket connect to load cached data fast)
        const cacheMeta = await getRoomCacheMeta(roomId);
        const newestCachedMessageId = cacheMeta?.newestCachedMessageId || undefined;
        const newestCachedCreatedAt = cacheMeta?.newestCachedCreatedAt || undefined;

        let resumeFetchFailed = false;
        const [metaRes, membershipRes, resumeRes] = await Promise.all([
          fetch(`/api/rooms/${roomId}`, { credentials: "include" }),
          fetch(`/api/rooms/${roomId}/membership`, { credentials: "include" }),
          resumeSync(roomId, newestCachedMessageId, newestCachedCreatedAt).catch(() => {
            resumeFetchFailed = true;
            return { strategy: "REPLACE" as const, messages: [] };
          }),
        ]);

        const metaData = (await metaRes.json()) as RoomMeta & { error?: string };
        if (!metaRes.ok) throw new Error(metaData.error || "Failed to load room");
        if (!mounted) return;
        setRoomMeta(metaData);

        setRoomDisabled(Boolean(metaData.room?.isDisabled));

        let membershipStatus = metaData.membership?.status;
        if (!membershipStatus) {
          setStatus("Not a member of this room");
          setIsBootstrapping(false);
          return;
        }

        if (membershipStatus !== "APPROVED") {
          if (membershipStatus === "PENDING") {
            setStatus("Request pending");
          } else if (membershipStatus === "REJECTED") {
            setStatus("Your request was declined");
          } else {
            setStatus("Not a member of this room");
          }
          setIsBootstrapping(false);
          return;
        }

        const membershipData = (await membershipRes.json()) as MembershipResponse;
        if (!membershipRes.ok || !membershipData.membership) {
          throw new Error(membershipData.error || "Failed to load membership");
        }

        const membership = membershipData.membership;

        if (membership.status === "REJECTED") {
          setStatus("Admin rejected your request");
          setIsBootstrapping(false);
          return;
        }

        if (!membership.userId) {
          throw new Error("Missing user id");
        }

        setCurrentUserId(membership.userId);

        // Phase 2: Process Keys
        let latestKeyVersion = 0;
        try {
          const distributions = await fetchMyKeyDistributions(roomId);
          const privateKey = await getPrivateKey(membership.userId);
          if (privateKey) {
            for (const dist of distributions) {
              const aesKey = await unwrapRoomKey(dist.encryptedKey, privateKey);
              await storeRoomKeyVersion(roomId, dist.keyVersion, aesKey);
            }
          }
          if (distributions.length > 0) {
            latestKeyVersion = distributions[distributions.length - 1].keyVersion;
            setRoomKeyRotation((prev) => ({
              ...prev,
              lastKeyVersion: latestKeyVersion,
              currentKeyVersion: latestKeyVersion,
            }));
          }
        } catch (err) {
          console.warn("Failed to fetch key distributions:", err);
        }

        roomKeyRef.current = await getRoomKeyVersion(roomId, latestKeyVersion);

        // Phase 3: Apply Resume Result
        // If resumeFetchFailed (network error), skip all cache writes and fall back to
        // the existing warm cache — we never wipe good cached data on a transient failure.
        const resume = resumeRes;
        const decrypted = resumeFetchFailed
          ? []
          : await decryptBatch(resume.messages, membership.userId, roomId);

        if (resumeFetchFailed) {
          // Network failure — re-decrypt only if Phase 0 didn't have the correct userId.
          // Otherwise Phase 0 already rendered the correct messages.
          if (!usedCorrectUserId) {
            const updatedCache = await decryptBatch(cached, membership.userId, roomId);
            const currentOptimistic = await loadOptimisticMessages(roomId, membership.userId);
            setMessages(mergeMessages(updatedCache, currentOptimistic));
          }
          // Do NOT touch IndexedDB cache — preserve whatever was there.
        } else if (resume.strategy === "UP_TO_DATE") {
          // No new messages — re-decrypt only if Phase 0 didn't have the correct userId.
          if (!usedCorrectUserId) {
            const updatedCache = await decryptBatch(cached, membership.userId, roomId);
            const currentOptimistic = await loadOptimisticMessages(roomId, membership.userId);
            setMessages(mergeMessages(updatedCache, currentOptimistic));
          }
        } else if (resume.strategy === "DELTA") {
          // Has new messages — always merge deltas even if Phase 0 was correct.
          const currentOptimistic = await loadOptimisticMessages(roomId, membership.userId);
          if (!usedCorrectUserId) {
            const updatedCache = await decryptBatch(cached, membership.userId, roomId);
            setMessages(mergeMessages(mergeMessages(updatedCache, decrypted), currentOptimistic));
          } else {
            setMessages(mergeMessages(mergeMessages(decryptedCache, decrypted), currentOptimistic));
          }
          await appendToCache(roomId, resume.messages, CACHE_WINDOW_SIZE);
          await evictLRURooms(MAX_CACHED_ROOMS);
        } else {
          // REPLACE — genuine server-driven replacement (cold start or large gap).
          const currentOptimistic = await loadOptimisticMessages(roomId, membership.userId);
          setMessages(mergeMessages(decrypted, currentOptimistic));
          await replaceCache(roomId, resume.messages);
          await evictLRURooms(MAX_CACHED_ROOMS);
        }

        if (decrypted.length > 0) {
          const last = decrypted[decrypted.length - 1];
          lastMessageRef.current = { createdAt: last.createdAt, id: last.id };
        } else if (cached.length > 0) {
          const last = cached[cached.length - 1];
          lastMessageRef.current = { createdAt: last.createdAt, id: last.id };
        }

        if (resume.messages.length > 0) {
          setHistoryCursor(resume.messages[0].id);
        } else if (cached.length > 0) {
          setHistoryCursor(cached[0].id);
        }

        // If Phase 0 already dismissed the overlay (correct userId + warm cache),
        // skip the scroll-and-dismiss timeout to avoid scroll jump.
        if (!isColdStart && !usedCorrectUserId && mounted) {
          setTimeout(() => {
            if (mounted) {
              scrollToBottom("auto");
              requestAnimationFrame(() => {
                setCacheServed(true);
                setIsBootstrapping(false);
              });
            }
          }, 50);
        } else if (isColdStart && mounted) {
          setTimeout(() => {
            if (mounted && shouldStickToBottomRef.current) {
              scrollToBottom("auto");
            }
            requestAnimationFrame(() => {
              setCacheServed(true);
              setIsBootstrapping(false);
            });
          }, 100);
        }

        // Check for pending key rotation
        if (roomKeyRotation.pendingKeyRotation) {
          setIsRotating(true);
          setStatus("Updating security...");

          try {
            const versions = await fetch(`/api/rooms/${roomId}/key-versions`, {
              credentials: "include",
            }).then((r) => r.json());

            const pendingVersion = versions.versions.find(
              (v: any) => v.status === "GENERATING"
            );

            if (pendingVersion) {
              const lockAcquired = await claimRotationLock(roomId, pendingVersion.version);

              if (lockAcquired) {
                const newVersion = pendingVersion.version;

                const membersRes = await fetch(`/api/rooms/${roomId}/members`, {
                  credentials: "include",
                });
                if (!membersRes.ok) {
                  throw new Error("Failed to fetch room members for key distribution");
                }
                const membersData = await membersRes.json();
                const remainingMembers = membersData.members ?? [];

                const newKey = await generateRoomKey();
                const distributions = [];

                for (const member of remainingMembers) {
                  if (member.user?.publicKey) {
                    const memberPublicKey = await importPublicKey(member.user.publicKey);
                    const encryptedKey = await wrapRoomKeyForPublicKey(newKey, memberPublicKey);
                    distributions.push({
                      userId: member.userId.toString(),
                      encryptedKey,
                    });
                  }
                }

                await storeRoomKeyVersion(roomId, newVersion, newKey);

                await completeRotation(roomId, newVersion, distributions);

                await syncKeyVersion(roomId, newVersion);
                setRoomKeyRotation({
                  pendingKeyRotation: false,
                  lastKeyVersion: newVersion,
                  currentKeyVersion: newVersion,
                });
                roomKeyRef.current = await getRoomKeyVersion(roomId, newVersion);
                setStatus("Connected");
                setIsRotating(false);

                await flushRotationQueue(roomId, newVersion, encryptMessage, getRoomKeyVersion);
              } else {
                setStatus("Waiting for key rotation...");
                const checkRotation = setInterval(async () => {
                  try {
                    const res = await fetch(`/api/rooms/${roomId}`, {
                      credentials: "include",
                    });
                    const data = await res.json();
                    if (data.room) {
                      setRoomKeyRotation({
                        pendingKeyRotation: data.room.pendingKeyRotation,
                        lastKeyVersion: data.room.lastKeyVersion ?? 0,
                        currentKeyVersion: data.room.lastKeyVersion ?? 0,
                      });

                      if (!data.room.pendingKeyRotation) {
                        clearInterval(checkRotation);
                        setIsRotating(false);
                        setStatus("Connected");

                        const distributions = await fetchMyKeyDistributions(roomId);
                        for (const dist of distributions) {
                          const privateKey = await getPrivateKey(membership.userId!);
                          if (privateKey) {
                            const aesKey = await unwrapRoomKey(dist.encryptedKey, privateKey);
                            await storeRoomKeyVersion(roomId, dist.keyVersion, aesKey);
                          }
                        }

                        roomKeyRef.current = await getRoomKeyVersion(roomId, data.room.lastKeyVersion ?? 0);
                        await flushRotationQueue(roomId, data.room.lastKeyVersion ?? 0, encryptMessage, getRoomKeyVersion);
                      }
                    }
                  } catch {
                    // Continue checking
                  }
                }, 2000);

                rotationTimeoutRef.current = setTimeout(() => {
                  clearInterval(checkRotation);
                  setIsRotating(false);
                  setStatus("Connected");
                }, 30000);
              }
            } else {
              setIsRotating(false);
              setStatus("Connected");
            }
          } catch (err) {
            setIsRotating(false);
            setStatus(err instanceof Error ? err.message : "Failed to rotate key");
          }
        } else {
          setStatus("Connected");
        }

        if (!mounted) return;

        // Set isAtBottom initially
        setIsAtBottom(true);

        // Phase 4: Live WebSocket connection & retry worker
        // Perform connection asynchronously in the background so it never blocks the UI or input activation.
        const rm = new ReconnectionManager(roomId, async () => {
          await runSync();
          void workerRef.current?.flushImmediate();
          refreshMembersRef.current();
        });
        const lifecycle = new AppLifecycle(() => rm.forceReconnect());
        reconnectionRef.current = rm;
        lifecycleRef.current = lifecycle;

        connectToRoom(roomId).then(async (socket) => {
          if (!mounted) return;

          rm.start(socket);
          lifecycle.start();

          // Start heartbeat to keep presence accurate
          startHeartbeat();

          // Start outbox retry worker
          const transmit = async (entry: OutboxEntry): Promise<"sent" | "failed" | "retry"> => {
            try {
              const roomKey = await getRoomKeyVersion(roomId, entry.roomKeyVersion);
              if (!roomKey) return "retry";
              const res = await sendEncryptedMessage({
                roomId,
                clientMessageId: entry.clientMessageId,
                ciphertext: entry.ciphertext,
                iv: entry.iv,
                authTag: entry.authTag,
                roomKeyVersion: entry.roomKeyVersion,
                messageType: entry.messageType,
                replyTo: entry.replyTo ?? undefined,
              });
              if (res.ok) {
                if (res.message) {
                  const decryptedBody = await decryptMessage(res.message, roomKey);
                  reconcileOptimisticMessage(
                    entry.clientMessageId,
                    res.message,
                    decryptedBody,
                    membership.userId!,
                    setMessages
                  );
                }
                return "sent";
              }
              if (entry.retryCount < entry.maxRetries) return "retry";
              return "failed";
            } catch {
              return "retry";
            }
          };
          const worker = new OutboxRetryWorker(roomId, transmit);
          worker.start();
          workerRef.current = worker;

          socket.on("room_message", async (incoming: RealtimeRoomMessage) => {
            if (incoming.roomId !== roomId) return;

            // Reconcile optimistic
            if (incoming.senderId === membership.userId) {
              const clientMsgId = incoming.clientMessageId;
              if (clientMsgId) {
                await deleteOutboxEntry(clientMsgId);
                const roomKey = roomKeyRef.current;
                let decryptedBody = "";
                if (roomKey) {
                  try {
                    decryptedBody = await decryptMessage(incoming, roomKey);
                  } catch {
                    // fallback
                  }
                }
                reconcileOptimisticMessage(
                  clientMsgId,
                  incoming,
                  decryptedBody,
                  membership.userId,
                  setMessages
                );
              } else {
                const matched = await findOutboxEntryByCipherprint(roomId, incoming.ciphertext, incoming.iv);
                if (matched) {
                  const roomKey = roomKeyRef.current;
                  let decryptedBody = matched.displayBody;
                  if (roomKey) {
                    try {
                      decryptedBody = await decryptMessage(incoming, roomKey);
                    } catch {
                      // fallback
                    }
                  }
                  await deleteOutboxEntry(matched.clientMessageId);
                  reconcileOptimisticMessage(
                    matched.clientMessageId,
                    incoming,
                    decryptedBody,
                    membership.userId,
                    setMessages
                  );
                }
              }
            }

            // Never auto-scroll on received messages; always use the down-arrow count.
            setNewMessagesCount((prev) => prev + 1);

            await appendDecrypted([incoming], false);

            // Update IndexedDB sliding cache
            await appendToCache(roomId, [incoming], CACHE_WINDOW_SIZE);
          });

          socket.on("message_edited", async (incoming: RealtimeRoomMessage) => {
            if (incoming.roomId !== roomId) return;
            try {
              const keyVersion = incoming.roomKeyVersion ?? 0;
              const roomKey = await getRoomKeyVersion(roomId, keyVersion);
              let body = "";
              if (roomKey) {
                try {
                  body = await decryptMessage(incoming, roomKey);
                } catch {
                  // fallback
                }
              }

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === incoming.id
                    ? {
                        ...m,
                        body: body || m.body,
                        editedAt: incoming.editedAt ?? null,
                        editCount: incoming.editCount ?? 0,
                        ciphertext: incoming.ciphertext,
                      }
                    : m
                )
              );
            } catch {
              // silently ignore
            }
          });

          socket.on("message_deleted", (payload: { roomId: string; messageId: string }) => {
            if (payload.roomId !== roomId) return;
            setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
            // Also purge from persisted cache so the deleted message never
            // reappears when the user rejoins the room.
            void removeFromCache(roomId, payload.messageId);
          });

          socket.on("typing_started", (payload: TypingEventPayload) => {
            if (payload.roomId !== roomId) return;
            setTypingUsers((prev) =>
              prev.includes(payload.userId) ? prev : [...prev, payload.userId]
            );
          });

          socket.on("typing_stopped", (payload: TypingEventPayload) => {
            if (payload.roomId !== roomId) return;
            setTypingUsers((prev) => prev.filter((id) => id !== payload.userId));
          });

          socket.on("PRESENCE_UPDATED", (payload: { roomId: string; userId: string; isOnline: boolean }) => {
            if (payload.roomId !== roomId) return;
            const targetUserId = String(payload.userId);
            setOnlineUserIds((prev) => {
              const next = new Set(prev);
              if (payload.isOnline) next.add(targetUserId);
              else next.delete(targetUserId);
              return next;
            });
            setMembers((prev) => {
              const exists = prev.some((m) => String(m.userId) === targetUserId);
              if (!exists && payload.isOnline) {
                refreshMembersRef.current();
                return prev;
              }
              return prev.map((m) =>
                String(m.userId) === targetUserId ? { ...m, isOnline: payload.isOnline } : m
              );
            });
          });

          socket.on("PENDING_KEY_ROTATION", (payload: { roomId: string; version: number }) => {
            if (payload.roomId !== roomId) return;
            setRoomKeyRotation((prev) => ({
              ...prev,
              pendingKeyRotation: true,
              lastKeyVersion: payload.version - 1,
            }));
            setStatus("Updating security...");
            setIsRotating(true);
          });

          socket.on("KEY_ROTATION_COMPLETE", async (payload: { roomId: string; version: number }) => {
            if (payload.roomId !== roomId) return;
            setRoomKeyRotation((prev) => ({
              ...prev,
              pendingKeyRotation: false,
              lastKeyVersion: payload.version,
              currentKeyVersion: payload.version,
            }));
            setStatus("Connected");
            setIsRotating(false);

            await flushRotationQueue(roomId, payload.version, encryptMessage, getRoomKeyVersion);
          });

          socket.on("KEY_ROTATION_FAILED", (payload: { roomId: string; version: number; error: string }) => {
            if (payload.roomId !== roomId) return;
            setStatus("Key rotation failed: " + payload.error);
            setIsRotating(false);
          });
        }).catch((err) => {
          console.warn("Failed to connect socket in background:", err);
        });

        // Fetch members
        void fetch(`/api/rooms/${roomId}/members`, { credentials: "include" })
          .then((r) => r.json())
          .then((data) => {
            if (!mounted) return;
            const m = (data.members ?? []) as RoomMember[];
            setMembers(m);
            setOnlineUserIds(new Set(m.filter((mm: any) => mm.isOnline).map((mm: any) => String(mm.userId))));
          })
          .catch(() => undefined);

        // Skip if Phase 0 already dismissed the overlay (warm cache + correct userId).
        if (!usedCorrectUserId || isColdStart) {
          setTimeout(() => {
            if (mounted && shouldStickToBottomRef.current) {
              scrollToBottom("auto");
            }
            requestAnimationFrame(() => {
              if (mounted) {
                setCacheServed(true);
                setIsBootstrapping(false);
              }
            });
          }, 100);
        }
      } catch (err) {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : "Unable to join room";
        if (msg.includes("Private key not found")) {
          setShowRecoveryPrompt(true);
          setStatus("Private key missing. Restore your identity to decrypt messages.");
        } else {
          setStatus(msg);
        }
        setIsBootstrapping(false);
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
      reconnectionRef.current?.stop();
      reconnectionRef.current = null;
      lifecycleRef.current?.stop();
      lifecycleRef.current = null;
      workerRef.current?.stop();
      workerRef.current = null;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (rotationTimeoutRef.current) clearTimeout(rotationTimeoutRef.current);
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      stopHeartbeat();
      disconnectSocket();
      setCacheServed(false);
      setIsBootstrapping(true);
    };
  }, [roomId, appendDecrypted, runSync, scrollToBottom, roomKeyRotation.pendingKeyRotation]);

  useEffect(() => {
    if (showRecoveryPrompt) openRecovery();
  }, [showRecoveryPrompt, openRecovery]);

  const [wasPrompted, setWasPrompted] = useState(false);
  useEffect(() => {
    if (showRecoveryPrompt) setWasPrompted(true);
  }, [showRecoveryPrompt]);
  useEffect(() => {
    if (wasPrompted && hasPrivateKey) window.location.reload();
  }, [wasPrompted, hasPrivateKey]);

  // ── Send message (reply-aware) ──
  async function onSend() {
    if (!roomId || !draft.trim()) return;
    if (roomDisabled) return;

    const clientMessageId = crypto.randomUUID();
    const displayBody = draft.trim();
    let entryWritten = false;

    if (isRotating) {
      const entry: OutboxEntry = {
        clientMessageId,
        roomId,
        ciphertext: "",
        iv: "",
        authTag: "",
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        isRotationQueued: true,
        plaintextBody: displayBody,
        messageType: "text",
        displayBody,
        senderId: currentUserId,
        status: "PENDING",
        retryCount: 0,
        nextRetryAt: Number.MAX_SAFE_INTEGER,
        maxRetries: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        replyTo: replyContext ? {
          messageId: replyContext.messageId,
          senderId: replyContext.senderId,
          senderName: replyContext.senderName,
          senderUserIndex: null,
          messageType: replyContext.messageType,
          previewIv: null,
          previewCiphertext: null,
          previewAuthTag: null,
        } : null,
        replyToPlaintextPreview: replyContext?.preview,
      };
      await addOutboxEntry(entry);
      setMessages((prev) => [...prev, buildOptimisticUiMessage(entry, currentUserId)]);
      setDraft("");
      // Always scroll to bottom when sending
      setIsAtBottom(true);
      setNewMessagesCount(0);
      setNewerCursor(null);
      setHasNewer(false);
      requestAnimationFrame(() => scrollToBottom("smooth"));
      return;
    }

    try {
      const roomKey = await getRoomKeyVersion(roomId, roomKeyRotation.currentKeyVersion);
      if (!roomKey) throw new Error("Room key not available");

      const encrypted = await encryptMessage(displayBody, roomKey);

      // If replying, encrypt the preview
      let replyPayload: any = undefined;
      if (replyContext) {
        const roomKeyForPreview = roomKey;
        const previewEncrypted = await encryptMessagePreview(
          replyContext.preview,
          replyContext.messageType,
          roomKeyForPreview
        );
        replyPayload = {
          messageId: replyContext.messageId,
          senderId: replyContext.senderId,
          senderName: replyContext.senderName,
          senderUserIndex: null,
          messageType: replyContext.messageType,
          previewIv: previewEncrypted.previewIv,
          previewCiphertext: previewEncrypted.previewCiphertext,
          previewAuthTag: previewEncrypted.previewAuthTag,
          previewKeyVersion: roomKeyRotation.currentKeyVersion,
        };
      }

      const entry: OutboxEntry = {
        clientMessageId,
        roomId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        isRotationQueued: false,
        messageType: "text",
        displayBody,
        senderId: currentUserId,
        status: "PENDING",
        retryCount: 0,
        nextRetryAt: Date.now() + 10_000,
        maxRetries: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        replyTo: replyPayload,
      };
      await addOutboxEntry(entry);
      entryWritten = true;

      setDraft("");
      setReplyContext(null);

      setMessages((prev) => [...prev, buildOptimisticUiMessage(entry, currentUserId)]);

      // Always scroll to bottom when sending
      setIsAtBottom(true);
      setNewMessagesCount(0);
      setNewerCursor(null);
      setHasNewer(false);
      requestAnimationFrame(() => scrollToBottom("smooth"));

      const response = await sendEncryptedMessage({
        roomId,
        clientMessageId,
        ...encrypted,
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        messageType: "text",
        replyTo: replyPayload,
      });

      if (!response.ok) throw new Error(response.error || "Failed to send message");

      await emitTypingStop(roomId).catch(() => undefined);
      if (response.message) {
        const decryptedBody = await decryptMessage(response.message, roomKey);
        await deleteOutboxEntry(clientMessageId);
        reconcileOptimisticMessage(clientMessageId, response.message, decryptedBody, currentUserId, setMessages);
      } else {
        await deleteOutboxEntry(clientMessageId);
      }
    } catch (err) {
      if (entryWritten) {
        await updateOutboxEntry(clientMessageId, {
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt: Date.now() + 5_000,
          updatedAt: Date.now(),
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === `optimistic:${clientMessageId}` ? { ...m, status: "retrying" } : m
          )
        );
      }
    }
  }

  // ── Edit message ──
  async function handleSaveEdit() {
    if (!roomId || !editingMessageId || !editingDraft.trim()) return;
    const newBody = editingDraft.trim();
    setEditingMessageId(null);
    setEditingDraft("");
    setDraft("");

    try {
      // Find the original message to get its roomKeyVersion
      const originalMsg = messages.find((m) => m.id === editingMessageId);
      if (!originalMsg) return;

      // Get the key version used when the original was encrypted (V_orig)
      const roomKey = await getRoomKeyVersion(roomId, roomKeyRotation.currentKeyVersion);
      if (!roomKey) throw new Error("Room key not available");

      const encrypted = await encryptMessage(newBody, roomKey);

      const response = await editEncryptedMessage({
        roomId,
        messageId: editingMessageId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      });

      if (!response.ok) throw new Error(response.error || "Edit failed");

      // Update working set cache immediately with ACK data
      if (response.message) {
        const editedAt = response.message.editedAt ?? new Date().toISOString();
        void updateInCache(roomId, editingMessageId, {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          editedAt,
        });
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to edit message");
    }
  }

  // ── Delete message ──
  async function handleConfirmDelete() {
    if (!roomId || !pendingDeleteId) return;
    const messageId = pendingDeleteId;
    setPendingDeleteId(null);

    // Optimistically remove from UI
    setMessages((prev) => prev.filter((m) => m.id !== messageId));

    // Optimistic messages exist only in the local outbox — clean up there
    if (messageId.startsWith("optimistic:")) {
      const clientMessageId = messageId.replace("optimistic:", "");
      await deleteOutboxEntry(clientMessageId).catch(() => undefined);
      return;
    }

    try {
      const response = await deleteEncryptedMessage({ roomId, messageId });
      if (!response.ok) throw new Error(response.error || "Delete failed");
      void removeFromCache(roomId, messageId);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to delete message");
    }
  }

  async function onDraftChange(value: string) {
    if (value.length > 500) return;
    setDraft(value);
    if (!roomId || status !== "Connected") return;
    if (roomDisabled) return;

    if (value.trim().length > 0) {
      await emitTypingStart(roomId, value.slice(0, 40)).catch(() => undefined);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        emitTypingStop(roomId).catch(() => undefined);
      }, 900);
    } else {
      await emitTypingStop(roomId).catch(() => undefined);
    }
  }

  const isOwner = roomMeta?.membership?.role === "OWNER";
  const isPending = roomMeta?.membership?.status === "PENDING" || status === "Request pending";
  // Enable chat as soon as the room key is available (Phase 2 end), not when isBootstrapping flips.
  const canChat = (roomKeyRef.current != null) && !roomDisabled;
  // showChatShell determines whether the full chat UI is visible for APPROVED members.
  const isErrorStatus = status !== "" && status !== "Connected" && status !== "Updating security..." && status !== "Waiting for key rotation..." && !isBootstrapping && !isRotating;
  const showChatShell = isBootstrapping || canChat || (!isErrorStatus && !isPending);

  /** Validate file and open the preview dialog instead of uploading directly. */
  function handleFileSelected(file: File) {
    if (!roomId || mediaSending) return;
    if (roomDisabled) return;

    const isImage = isSupportedImage(file);
    const isVideo = isSupportedVideo(file);

    if (!isImage && !isVideo) {
      alert("Unsupported file type. Only images and videos are allowed.");
      return;
    }

    setPendingMediaFile(file);
  }

  /**
   * Send a single file through the full pipeline: compress → encrypt → upload → send message.
   * Called by the ImageViewer (send mode) after user adds a caption.
   */
  async function pipelineOne(file: File, caption?: string, existingClientMessageId?: string) {
    const clientMessageId = existingClientMessageId || crypto.randomUUID();

    // Ensure we track in-flight file references for retries
    backgroundFilesRef.current.set(clientMessageId, { file, caption });

    const updateProgress = (
      progress: number,
      stage: "compressing" | "uploading" | "failed",
      error?: string
    ) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.clientMessageId === clientMessageId) {
            return {
              ...m,
              progress,
              progressStage: stage,
              status: stage === "failed" ? "failed" : "pending",
              ...(error ? { error } : {}),
            };
          }
          return m;
        })
      );
    };

    try {
      const roomKey = await getRoomKeyVersion(roomId!, roomKeyRotation.currentKeyVersion);
      if (!roomKey) throw new Error("Room key not available");

      const isImage = isSupportedImage(file);

      let compressedBlob: Blob;
      let mimeType: string;
      let width: number;
      let height: number;
      let mediaMetadata: Record<string, unknown>;
      let thumbnailKey: string | undefined;
      let thumbnailIv: string | undefined;
      let videoDuration: number | undefined;
      let ivBase: string | undefined;
      let chunkSize: number | undefined;

      if (isImage) {
        // ── Image path: compress to WebP, single-chunk encrypt ──
        updateProgress(5, "compressing");
        const optimized = await compressMedia(file, "image", {
          onProgress: (p) => {
            updateProgress(Math.round(p * 90) + 5, "compressing");
          },
        }) as CompressImageResult;

        compressedBlob = optimized.blob;
        mimeType = optimized.mimeType;
        width = optimized.width;
        height = optimized.height;

        updateProgress(100, "uploading");

        const plaintext = await compressedBlob.arrayBuffer();
        const encrypted = await encryptMedia(plaintext, roomKey);
        const upload = await requestUploadUrl(roomId!, mimeType, encrypted.encrypted.byteLength);
        await uploadEncryptedBlob(upload.uploadUrl, new Blob([encrypted.encrypted]));

        mediaMetadata = {
          type: "image",
          objectKey: upload.objectKey,
          mimeType,
          width,
          height,
          size: plaintext.byteLength,
          iv: encrypted.iv,
          ...(caption ? { caption } : {}),
        } satisfies ImageMetadata;
      } else {
        // ── Video path: transcode to H.264, per-chunk IV encrypt, thumbnail ──
        updateProgress(5, "compressing");
        const compressed = await compressMedia(file, "video", {
          targetHeight: 720,
          quality: 28,
          onProgress: (p) => {
            updateProgress(Math.round(p * 80) + 5, "compressing");
          },
        }) as CompressVideoResult;

        compressedBlob = compressed.compressedBlob;
        width = compressed.width;
        height = compressed.height;
        videoDuration = compressed.duration;
        mimeType = "video/mp4";

        updateProgress(90, "compressing");
        // Generate thumbnail from the compressed video using canvas
        const thumbResult = await generateCanvasThumbnail(compressedBlob);
        const thumbEncrypted = await encryptMedia(await thumbResult.blob.arrayBuffer(), roomKey);
        const thumbUpload = await requestUploadUrl(roomId!, "image/webp", thumbEncrypted.encrypted.byteLength);
        await uploadEncryptedBlob(thumbUpload.uploadUrl, new Blob([thumbEncrypted.encrypted]));
        thumbnailKey = thumbUpload.objectKey;
        thumbnailIv = thumbEncrypted.iv;

        updateProgress(100, "uploading");

        // Per-chunk IV encrypt for progressive streaming (1 MiB chunks)
        const plaintext = await compressedBlob.arrayBuffer();
        const chunked = await encryptMediaChunked(plaintext, roomKey, 1024 * 1024);
        ivBase = chunked.ivBase;
        chunkSize = chunked.chunkSize;

        const upload = await requestUploadUrl(roomId!, mimeType, chunked.encrypted.byteLength);
        await uploadEncryptedBlob(upload.uploadUrl, new Blob([chunked.encrypted]));

        mediaMetadata = {
          type: "video",
          objectKey: upload.objectKey,
          mimeType,
          width,
          height,
          size: plaintext.byteLength,
          thumbnailKey: thumbnailKey!,
          thumbnailIv: thumbnailIv!,
          duration: videoDuration,
          iv: chunked.chunkIvMap[0],
          ivBase,
          chunkSize,
          ...(caption ? { caption } : {}),
        } satisfies VideoMetadata;
      }

      const encryptedMessage = await encryptMessage(JSON.stringify(mediaMetadata), roomKey);
      const response = await sendEncryptedMessage({
        roomId: roomId!,
        clientMessageId,
        ...encryptedMessage,
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        messageType: isImage ? "image" : "video",
      });

      if (response.message) {
        backgroundFilesRef.current.delete(clientMessageId);
        const decryptedBody = isImage ? "📷 Image" : "🎬 Video";
        reconcileOptimisticMessage(
          clientMessageId,
          response.message,
          decryptedBody,
          currentUserId,
          setMessages
        );
      } else {
        throw new Error(response.error || "Failed to send message over socket");
      }
    } catch (err) {
      console.error("Media background pipeline failed:", err);
      const errMsg = err instanceof Error ? err.message : "Media processing failed";
      updateProgress(0, "failed", errMsg);
    }
  }

  /** Canvas-based video thumbnail from a compressed blob (lighter than ffmpeg re-run). */
  async function generateCanvasThumbnail(videoBlob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
    const url = URL.createObjectURL(videoBlob);
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = url;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video for thumbnail"));
      });

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 1 ? duration * 0.1 : 0;

      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("Failed to seek video for thumbnail"));
      });

      // Scale to max 640px
      const maxEdge = 640;
      let tw = video.videoWidth;
      let th = video.videoHeight;
      if (tw > maxEdge || th > maxEdge) {
        const ratio = tw / th;
        if (tw > th) { tw = maxEdge; th = Math.round(maxEdge / ratio); }
        else { th = maxEdge; tw = Math.round(maxEdge * ratio); }
      }

      const canvas = new OffscreenCanvas(tw, th);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0, tw, th);

      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.7 });
      return { blob, width: tw, height: th };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Called when user confirms send in the preview dialog. */
  async function handleSendMedia(file: File, caption?: string) {
    if (!roomId) return;
    const clientMessageId = crypto.randomUUID();
    const isImage = isSupportedImage(file);
    const localUrl = URL.createObjectURL(file);

    // Save mapping in-memory for retries
    backgroundFilesRef.current.set(clientMessageId, { file, caption });

    // Close preview modal immediately so UI is not blocked
    setPendingMediaFile(null);

    // Probe dimensions locally & instantly
    const { width, height } = await probeLocalMediaDimensions(file, isImage);

    // Optimistic UI message
    const optimisticMsg: UiMessage = {
      id: `optimistic:${clientMessageId}`,
      clientMessageId,
      senderId: currentUserId,
      body: isImage ? "📷 Image" : "🎬 Video",
      createdAt: new Date().toISOString(),
      isOwn: true,
      messageType: isImage ? "image" : "video",
      status: "pending",
      progress: 0,
      progressStage: "compressing",
      onRetry: () => {
        const saved = backgroundFilesRef.current.get(clientMessageId);
        if (saved) {
          pipelineOne(saved.file, saved.caption, clientMessageId);
        }
      },
      mediaMetadata: {
        type: isImage ? "image" : "video",
        objectKey: `local:${clientMessageId}`,
        mimeType: file.type,
        width,
        height,
        size: file.size,
        iv: "",
        localUrl,
        caption,
      } as any,
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    // Keep feed scrolled to bottom
    setIsAtBottom(true);
    setNewMessagesCount(0);
    setNewerCursor(null);
    setHasNewer(false);
    requestAnimationFrame(() => scrollToBottom("smooth"));

    // Trigger pipeline in background (non-blocking)
    pipelineOne(file, caption, clientMessageId);
  }

  async function handleToggleDisable() {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/disable`, {
        method: "PATCH",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to toggle");
      setRoomDisabled(data.room.isDisabled);
      setRoomMeta((prev) =>
        prev ? { ...prev, room: { ...prev.room, isDisabled: data.room.isDisabled } } : prev
      );
    } catch {
      // silently fail
    }
  }

  async function onSendGif(gif: GifSelection) {
    if (!roomId) return;
    if (roomDisabled) return;

    setGifPickerOpen(false);

    try {
      const roomKey = await getRoomKeyVersion(roomId, roomKeyRotation.currentKeyVersion);
      if (!roomKey) throw new Error("Room key not available");

      const metadata: GifMetadata = {
        type: "gif",
        gifId: gif.id,
        gifUrl: gif.mp4Url,
        previewUrl: gif.tinygifUrl,
        fallbackUrl: gif.fallbackUrl,
        width: gif.width,
        height: gif.height,
        size: gif.size,
        title: gif.title,
      };

      const encrypted = await encryptMessage(JSON.stringify(metadata), roomKey);
      const response = await sendEncryptedMessage({
        roomId,
        clientMessageId: crypto.randomUUID(),
        ...encrypted,
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        messageType: "gif",
      });

      if (!response.ok) throw new Error(response.error || "Failed to send GIF");

      if (response.message) await appendDecrypted([response.message]);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to send GIF");
    }
  }

  // ── Reply / Edit handler ──
  const handleReply = useCallback((message: UiMessage) => {
    const preview = message.body.slice(0, 80);
    setReplyContext({
      messageId: message.id,
      senderId: message.senderId,
      senderName: message.senderName || "Anonymous",
      messageType: message.messageType || "text",
      preview,
    });
  }, []);

  const handleEditMessage = useCallback((message: UiMessage) => {
    setEditingMessageId(message.id);
    setEditingDraft(message.body);
    setDraft(message.body);
  }, []);

  const handleDeleteMessage = useCallback((message: UiMessage) => {
    setPendingDeleteId(message.id);
  }, []);

  const handleContextMenu = useCallback((message: UiMessage, x: number, y: number) => {
    setContextMenu({ x, y, message });
  }, []);

  const refreshMembers = useCallback(() => {
    if (!roomId) return;
    void fetch(`/api/rooms/${roomId}/members`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const m = (data.members ?? []) as RoomMember[];
        setMembers(m);
        setOnlineUserIds(new Set(m.filter((mm: any) => mm.isOnline).map((mm: any) => String(mm.userId))));
      })
      .catch(() => undefined);
  }, [roomId]);

  useEffect(() => {
    refreshMembersRef.current = refreshMembers;
  }, [refreshMembers]);

  // Kick a user out of the room
  const handleKickout = useCallback(async (targetUserId: string) => {
    if (!roomId) return;
    const res = await fetch(`/api/rooms/${roomId}/kickout/${targetUserId}`, {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Kickout failed");
    refreshMembers();
  }, [roomId, refreshMembers]);

  // Change a member's role (promote/demote/transfer ownership)
  const handleRoleChange = useCallback(async (targetUserId: string, role: string) => {
    if (!roomId) return;
    const res = await fetch(`/api/rooms/${roomId}/members/${targetUserId}/role`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Role change failed");
    // Refresh room meta to update current user's role if ownership was transferred
    const metaRes = await fetch(`/api/rooms/${roomId}`, { credentials: "include" });
    if (metaRes.ok) {
      const metaData = await metaRes.json();
      setRoomMeta(metaData);
    }
    refreshMembers();
  }, [roomId, refreshMembers]);

  // Execute the actual leave API call (after confirmation / succession)
  const executeLeave = useCallback(async (promoteToAdmin?: string[]) => {
    if (!roomId) return;
    setLeaveLoading(true);
    try {
      const body = promoteToAdmin ? { promoteToAdmin } : {};
      const res = await fetch(`/api/rooms/${roomId}/leave`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "succession_required" && Array.isArray(data.members)) {
          // Sole admin — show succession dialog
          setSuccessionMembers(
            (data.members as { userId: string; role: string }[]).map((m) => ({
              userId: m.userId,
              role: m.role,
              user: null,
              userIndex: null,
            }))
          );
          // Enrich with local member data
          setSuccessionMembers((prev) =>
            prev.map((sm) => {
              const local = members.find((lm) => lm.userId === sm.userId);
              return local ? { ...sm, user: local.user, userIndex: (local as any).userIndex ?? null } : sm;
            })
          );
          setLeaveDialogOpen(false);
          setSuccessionDialogOpen(true);
          return;
        }
        throw new Error(data.error || "Failed to leave room");
      }
      // Successfully left — navigate away
      router.push("/");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to leave room");
    } finally {
      setLeaveLoading(false);
    }
  }, [roomId, members, router]);

  // Initiate leave — show confirmation dialog
  const handleLeaveRequest = useCallback(() => {
    setShowOptions(false);
    setLeaveDialogOpen(true);
  }, []);

  return (
    <div
      className="flex flex-col bg-black overflow-hidden"
      style={{
        height: `calc(100dvh - ${keyboardOffset}px)`,
        // Fallback for browsers without dvh support
        minHeight: 0,
      }}
    >
      <div className="relative flex min-h-0 h-full flex-1 flex-col sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:mx-auto sm:my-4 sm:max-w-[480px] sm:border sm:border-neutral-800 sm:bg-black sm:shadow-2xl overflow-hidden">
        <RoomHeader
          roomName={roomMeta?.room.name ?? "Room"}
          showOptions={showOptions}
          onToggleOptions={() => setShowOptions((prev) => !prev)}
        />

        {isPending && (
          <div className="border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-center text-xs text-neutral-400 shrink-0">
            Your request is pending. Track updates in{" "}
            <Link href="/pending" className="text-white underline underline-offset-2">
              Pending Requests
            </Link>
            .
          </div>
        )}

        {roomDisabled && (
          <div className="border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-center text-xs text-neutral-400 shrink-0">
            This room has been disabled by its owner.
          </div>
        )}

        {showOptions && roomMeta ? (
          <RoomOptionsPage
            roomId={roomId}
            roomName={roomMeta.room.name}
            roomLink={roomMeta.room.roomLink}
            joinPolicy={roomMeta.room.joinPolicy}
            members={members as RoomMemberEntry[]}
            onlineUserIds={onlineUserIds}
            viewerRole={(roomMeta.membership?.role || "MEMBER") as ViewerRole}
            isDisabled={roomDisabled}
            isAdmin={roomMeta.membership?.role === "OWNER" || roomMeta.membership?.role === "ADMIN"}
            onToggleDisable={isOwner ? handleToggleDisable : undefined}
            onLeaveRequest={handleLeaveRequest}
            onKickout={handleKickout}
            onRoleChange={handleRoleChange}
            onMembersRefresh={refreshMembers}
          />
        ) : (
          <>
            {/* Error / non-member states */}
            {isErrorStatus && !isPending && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                <p className="text-sm text-neutral-400">{status}</p>
                {showRecoveryPrompt ? (
                  <div className="flex gap-3">
                    <Button variant="secondary" className="uppercase tracking-wider" onClick={() => openRecovery()}>
                      Restore Identity
                    </Button>
                    <Link href="/">
                      <Button variant="ghost" className="uppercase tracking-wider">
                        Back
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <Link href="/">
                    <Button variant="secondary" className="uppercase tracking-wider">
                      Back to discovery
                    </Button>
                  </Link>
                )}
              </div>
            )}

            {/* ── Dismissable inline toast for non-blocking errors ── */}
            {toast && (
              <div className="pointer-events-none absolute bottom-24 left-0 right-0 z-50 flex justify-center px-4">
                <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-neutral-700 bg-neutral-900/95 px-4 py-2.5 shadow-xl backdrop-blur-sm">
                  <span className="text-[12px] text-neutral-300">{toast}</span>
                  <button
                    onClick={() => setToast(null)}
                    className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-200"
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* Chat shell — shown immediately for approved members (bootstrapping or live) */}
            {showChatShell && (
              <div className="relative flex flex-1 flex-col min-h-0 overflow-hidden">
                <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
                  {/* Loading overlay — reused for both bootstrap phase and quote-click loading */}
                  {(quoteLoading || !cacheServed) && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black">
                      <div className="flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-5 py-3">
                        <div className="h-4 w-4 animate-spin rounded-full border border-neutral-400 border-t-transparent" />
                        <span className="text-[11px] uppercase tracking-wider text-neutral-400">
                          Loading…
                        </span>
                      </div>
                    </div>
                  )}
                  <MessageList
                    messages={messages}
                    loadingOlder={loadingOlder}
                    hasMore={Boolean(historyCursor)}
                    onLoadOlder={() => void loadOlder()}
                    loadingNewer={loadingNewer}
                    hasNewer={hasNewer}
                    onLoadNewer={() => void loadNewerSentinel()}
                    listRef={setListRef}
                    onScroll={handleScroll}
                    roomKey={roomKeyRef.current ?? undefined}
                    roomId={roomId}
                    onReply={handleReply}
                    onEdit={handleEditMessage}
                    onDelete={handleDeleteMessage}
                    onQuoteClick={handleQuoteClick}
                    onShowMenu={handleContextMenu}
                    onImageClick={(message) => setViewerMessageId(message.id)}
                    jumpTargetId={jumpTargetId}
                    hideEmpty={isBootstrapping}
                  />

                  {/* Down-arrow button when not at bottom */}
                  {!isAtBottom && (
                    <DownArrowButton
                      newMessagesCount={newMessagesCount}
                      onClick={() => void handleScrollToBottom()}
                      loading={downArrowLoading}
                    />
                  )}
                </div>

                {typingSummary && (
                  <p className="shrink-0 px-4 pb-1 text-[11px] text-neutral-500">
                    {typingSummary}
                  </p>
                )}

                <ChatInput
                  draft={editingMessageId ? editingDraft : draft}
                  onChange={(v) => {
                    if (editingMessageId) {
                      setEditingDraft(v);
                    } else {
                      void onDraftChange(v);
                    }
                  }}
                  onSend={() => {
                    if (editingMessageId) {
                      void handleSaveEdit();
                    } else {
                      void onSend();
                    }
                  }}
                  onSendMedia={(file) => handleFileSelected(file)}
                  onGifClick={() => setGifPickerOpen(true)}
                  disabled={roomDisabled}
                  sendDisabled={isBootstrapping || !canChat}
                  mediaSending={mediaSending}
                  replyContext={replyContext}
                  onClearReply={() => setReplyContext(null)}
                  editingMessageId={editingMessageId}
                  onSaveEdit={() => void handleSaveEdit()}
                  onCancelEdit={() => {
                    setEditingMessageId(null);
                    setEditingDraft("");
                    setDraft("");
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <GifPicker
        open={gifPickerOpen}
        onClose={() => setGifPickerOpen(false)}
        onSelect={(gif) => void onSendGif(gif)}
      />

      <ImageViewer
        mode="send"
        file={pendingMediaFile}
        open={Boolean(pendingMediaFile)}
        onClose={() => setPendingMediaFile(null)}
        onSend={(file, caption) => void handleSendMedia(file, caption)}
        sending={mediaSending}
      />

      {/* Context Menu */}
      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenu.message.isOwn ?? false}
          canEdit={
            (contextMenu.message.isOwn ?? false) &&
            (contextMenu.message.editCount ?? 0) < 2 &&
            (() => {
              const msgTime = new Date(contextMenu.message.createdAt).getTime();
              return Number.isFinite(msgTime) && Date.now() - msgTime < 15 * 60 * 1000;
            })() &&
            contextMenu.message.messageType === "text"
          }
          copyText={
            contextMenu.message.messageType === "text"
              ? contextMenu.message.body
              : contextMenu.message.mediaMetadata && "caption" in contextMenu.message.mediaMetadata
                ? contextMenu.message.mediaMetadata.caption
                : undefined
          }
          onReply={() => handleReply(contextMenu.message)}
          onEdit={() => handleEditMessage(contextMenu.message)}
          onDelete={() => handleDeleteMessage(contextMenu.message)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        open={Boolean(pendingDeleteId)}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDeleteId(null)}
      />

      {/* Leave Confirmation Dialog */}
      {leaveDialogOpen && (
        <LeaveConfirmDialog
          loading={leaveLoading}
          onConfirm={() => void executeLeave()}
          onCancel={() => setLeaveDialogOpen(false)}
        />
      )}

      {/* Succession Dialog */}
      {successionDialogOpen && (
        <SuccessionDialog
          loading={leaveLoading}
          members={successionMembers}
          onConfirm={(promoteToAdmin) => void executeLeave(promoteToAdmin)}
          onCancel={() => setSuccessionDialogOpen(false)}
        />
      )}

      {/* Image Viewer */}
      {viewerMessageId && roomKeyRef.current ? (
        <ImageViewer
          mode="view"
          message={messages.find((m) => m.id === viewerMessageId) ?? null}
          roomKey={roomKeyRef.current ?? undefined}
          open={Boolean(viewerMessageId)}
          onClose={() => setViewerMessageId(null)}
          onReply={(messageId) => {
            const msg = messages.find((m) => m.id === messageId);
            if (msg) handleReply(msg);
            setViewerMessageId(null);
          }}
        />
      ) : null}
    </div>
  );
}
