"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  connectToRoom,
  disconnectSocket,
  emitTypingStart,
  emitTypingStop,
  getSocket,
  onSocketReconnect,
  sendEncryptedMessage,
  syncSince,
  editEncryptedMessage,
  deleteEncryptedMessage,
  type RealtimeRoomMessage,
  type TypingEventPayload,
} from "@/lib/socket-client";
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
import { encryptMedia } from "@/lib/media-crypto";
import {
  optimizeImage,
  generateVideoThumbnail,
  isSupportedImage,
  isSupportedVideo,
} from "@/lib/media-optimizer";
import { requestUploadUrl, uploadEncryptedBlob, clearMediaCache } from "@/lib/media-storage";
import {
  fetchMessageHistory,
  syncMessagesSince,
  fetchMessagesAround,
} from "@/lib/messages-client";
import { ChatInput } from "@/components/chat/chat-input";
import { GifPicker, type GifSelection } from "@/components/chat/gif-picker";
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
  };
  memberCount: number;
  membership: { status: string; role: string } | null;
};

type RoomMember = {
  userId: string;
  role: string;
  isOnline?: boolean;
  user: { name?: string; email?: string } | null;
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
        replyTo,
        editedAt: record.editedAt ?? null,
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

  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [mediaSending, setMediaSending] = useState(false);
  const [status, setStatus] = useState("Connecting...");
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
  const [downArrowLoading, setDownArrowLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);

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

  const roomKeyRef = useRef<CryptoKey | null>(null);
  const [roomKeyRotation, setRoomKeyRotation] = useState<RoomKeyRotationState>({
    pendingKeyRotation: false,
    lastKeyVersion: 0,
    currentKeyVersion: 0,
  });
  const [isRotating, setIsRotating] = useState(false);
  const rotationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workerRef = useRef<OutboxRetryWorker | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    (listRef as any).current = el;
    if (el) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
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
    if (!roomId || !roomKeyRef.current) return;
    const anchor = lastMessageRef.current;
    if (!anchor) return;

    try {
      const ws = await syncSince(roomId, anchor.createdAt, anchor.id).catch(() => null);
      if (ws?.ok && ws.messages?.length) {
        await appendDecrypted(ws.messages);
        return;
      }

      const rest = await syncMessagesSince(roomId, anchor.createdAt, anchor.id);
      await appendDecrypted(rest.messages);
    } catch {
      // Sync failures are non-fatal; live socket may still deliver messages.
    }
  }, [roomId, appendDecrypted]);

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

        // If the target message was deleted, show an alert
        if (!response.messages.length) {
          setQuoteLoading(false);
          alert("The quoted message does not exist");
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
        alert("The quoted message does not exist");
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
        const [metaRes, membershipRes] = await Promise.all([
          fetch(`/api/rooms/${roomId}`, { credentials: "include" }),
          fetch(`/api/rooms/${roomId}/membership`, { credentials: "include" }),
        ]);

        const metaData = (await metaRes.json()) as RoomMeta & { error?: string };
        if (!metaRes.ok) throw new Error(metaData.error || "Failed to load room");
        if (!mounted) return;
        setRoomMeta(metaData);

        setRoomDisabled(Boolean(metaData.room?.isDisabled));

        let membershipStatus = metaData.membership?.status;
        if (!membershipStatus) {
          setStatus("Not a member of this room");
          return;
        }

        if (membershipStatus !== "APPROVED") {
          if (membershipStatus === "PENDING") {
            setStatus("Request pending");
            return;
          }
          if (membershipStatus === "REJECTED") {
            setStatus("Your request was declined");
            return;
          }
          setStatus("Not a member of this room");
          return;
        }

        const membershipData = (await membershipRes.json()) as MembershipResponse;
        if (!membershipRes.ok || !membershipData.membership) {
          throw new Error(membershipData.error || "Failed to load membership");
        }

        const membership = membershipData.membership;

        if (membership.status === "REJECTED") {
          setStatus("Admin rejected your request");
          return;
        }

        if (!membership.userId) {
          throw new Error("Missing user id");
        }

        setCurrentUserId(membership.userId);

        // Fetch all room key distributions
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

        const history = await fetchMessageHistory(roomId, { limit: 40 });

        const decrypted = await decryptBatch(history.messages, membership.userId, roomId);

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

        // Load outbox entries
        const optimistic = await loadOptimisticMessages(roomId, membership.userId);
        setMessages(mergeMessages(decrypted, optimistic));
        setHistoryCursor(history.nextCursor);

        if (decrypted.length > 0) {
          lastMessageRef.current = {
            createdAt: decrypted[decrypted.length - 1].createdAt,
            id: decrypted[decrypted.length - 1].id,
          };
        }

        // Connect to room
        await connectToRoom(roomId);
        if (!mounted) return;
        setStatus("Connected");

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

        // Fetch members
        void fetch(`/api/rooms/${roomId}/members`, { credentials: "include" })
          .then((r) => r.json())
          .then((data) => {
            if (!mounted) return;
            const m = (data.members ?? []) as RoomMember[];
            setMembers(m);
            setOnlineUserIds(new Set(m.filter((mm: any) => mm.isOnline).map((mm: any) => mm.userId)));
          })
          .catch(() => undefined);

        setTimeout(() => {
          if (mounted && shouldStickToBottomRef.current) {
            scrollToBottom("auto");
          }
        }, 100);

        const socket = getSocket();
        if (!socket) return;

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
          setOnlineUserIds((prev) => {
            const next = new Set(prev);
            if (payload.isOnline) next.add(payload.userId);
            else next.delete(payload.userId);
            return next;
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
      } catch (err) {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : "Unable to join room";
        if (msg.includes("Private key not found")) {
          setShowRecoveryPrompt(true);
          setStatus("Private key missing. Restore your identity to decrypt messages.");
        } else {
          setStatus(msg);
        }
      }
    };

    void bootstrap();

    const offReconnect = onSocketReconnect(() => {
      void runSync();
      void workerRef.current?.flushImmediate();
    });

    return () => {
      mounted = false;
      offReconnect();
      workerRef.current?.stop();
      workerRef.current = null;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (rotationTimeoutRef.current) clearTimeout(rotationTimeoutRef.current);
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      disconnectSocket();
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
      // We determine this from the current room key version — the original
      // message's version is latent in the encrypted record. For simplicity
      // we use the current room key version; in practice the client should
      // retrieve the exact V_orig from the persisted message.
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

      // The message_edited socket event will update the local state
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to edit message");
    }
  }

  // ── Delete message ──
  async function handleConfirmDelete() {
    if (!roomId || !pendingDeleteId) return;
    const messageId = pendingDeleteId;
    setPendingDeleteId(null);

    // Optimistically remove
    setMessages((prev) => prev.filter((m) => m.id !== messageId));

    try {
      const response = await deleteEncryptedMessage({ roomId, messageId });
      if (!response.ok) throw new Error(response.error || "Delete failed");
    } catch (err) {
      // Re-add message on failure — the socket event would handle it anyway
      setStatus(err instanceof Error ? err.message : "Failed to delete message");
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
  const canChat = (status === "Connected" || status === "Updating security..." || isRotating)

  async function onSendMedia(file: File) {
    if (!roomId || mediaSending) return;
    if (roomDisabled) return;

    const isImage = isSupportedImage(file);
    const isVideo = isSupportedVideo(file);

    if (!isImage && !isVideo) {
      alert("Unsupported file type. Only images and videos are allowed.");
      return;
    }

    setMediaSending(true);

    try {
      const roomKey = await getRoomKeyVersion(roomId, roomKeyRotation.currentKeyVersion);
      if (!roomKey) throw new Error("Room key not available");

      let optimizedBlob: Blob;
      let mimeType: string;
      let width: number;
      let height: number;
      let mediaMetadata: Record<string, unknown>;
      let thumbnailKey: string | undefined;
      let thumbnailIv: string | undefined;
      let videoDuration: number | undefined;

      if (isImage) {
        const optimized = await optimizeImage(file);
        optimizedBlob = optimized.blob;
        mimeType = optimized.mimeType;
        width = optimized.width;
        height = optimized.height;
      } else {
        const { thumbnail: thumbResult, metadata: videoInfo } = await generateVideoThumbnail(file);
        optimizedBlob = file;
        mimeType = file.type;
        width = videoInfo.width;
        height = videoInfo.height;
        videoDuration = videoInfo.duration;

        const thumbEncrypted = await encryptMedia(await thumbResult.blob.arrayBuffer(), roomKey);
        const thumbUpload = await requestUploadUrl(roomId, "image/webp", thumbEncrypted.encrypted.byteLength);
        await uploadEncryptedBlob(thumbUpload.uploadUrl, new Blob([thumbEncrypted.encrypted]));
        thumbnailKey = thumbUpload.objectKey;
        thumbnailIv = thumbEncrypted.iv;
      }

      const plaintext = await (isImage ? optimizedBlob : file).arrayBuffer();
      const encrypted = await encryptMedia(plaintext, roomKey);

      const upload = await requestUploadUrl(roomId, isImage ? mimeType : file.type, encrypted.encrypted.byteLength);
      await uploadEncryptedBlob(upload.uploadUrl, new Blob([encrypted.encrypted]));

      if (isImage) {
        mediaMetadata = {
          type: "image",
          objectKey: upload.objectKey,
          mimeType,
          width,
          height,
          size: file.size,
          iv: encrypted.iv,
        } satisfies ImageMetadata;
      } else {
        mediaMetadata = {
          type: "video",
          objectKey: upload.objectKey,
          mimeType: file.type,
          width,
          height,
          size: file.size,
          thumbnailKey: thumbnailKey!,
          thumbnailIv: thumbnailIv!,
          duration: videoDuration!,
          iv: encrypted.iv,
        } satisfies VideoMetadata;
      }

      const encryptedMessage = await encryptMessage(JSON.stringify(mediaMetadata), roomKey);
      const response = await sendEncryptedMessage({
        roomId,
        clientMessageId: crypto.randomUUID(),
        ...encryptedMessage,
        roomKeyVersion: roomKeyRotation.currentKeyVersion,
        messageType: isImage ? "image" : "video",
      });

      if (response.message) await appendDecrypted([response.message]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send media";
      setStatus(msg);
    } finally {
      setMediaSending(false);
    }
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
      setStatus(err instanceof Error ? err.message : "Failed to send GIF");
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
        setOnlineUserIds(new Set(m.filter((mm: any) => mm.isOnline).map((mm: any) => mm.userId)));
      })
      .catch(() => undefined);
  }, [roomId]);

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
    <div className="flex h-[100dvh] flex-col bg-black overflow-hidden">
      <div className="flex min-h-0 h-full flex-1 flex-col sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:mx-auto sm:my-4 sm:max-w-[480px] sm:border sm:border-neutral-800 sm:bg-black sm:shadow-2xl overflow-hidden">
        <RoomHeader
          roomName={roomMeta?.room.name ?? "Room"}
          memberCount={roomMeta?.memberCount ?? 0}
          status={status}
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
            {!canChat && !isPending && status !== "Connecting..." && (
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

            {canChat && (
              <div className="relative flex flex-1 flex-col min-h-0 overflow-hidden">
                <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
                  {quoteLoading && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40">
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
                    onReply={handleReply}
                    onEdit={handleEditMessage}
                    onDelete={handleDeleteMessage}
                    onQuoteClick={handleQuoteClick}
                    onShowMenu={handleContextMenu}
                    jumpTargetId={jumpTargetId}
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
                  onSendMedia={(file) => void onSendMedia(file)}
                  onGifClick={() => setGifPickerOpen(true)}
                  disabled={!canChat || roomDisabled}
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

            {status === "Connecting..." && !isPending && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs uppercase tracking-wider text-neutral-500">Connecting...</p>
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

      {/* Context Menu */}
      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenu.message.isOwn ?? false}
          canEdit={
            (contextMenu.message.isOwn ?? false) &&
            !contextMenu.message.editedAt &&
            (() => {
              const msgTime = new Date(contextMenu.message.createdAt).getTime();
              return Number.isFinite(msgTime) && Date.now() - msgTime < 15 * 60 * 1000;
            })() &&
            contextMenu.message.messageType === "text"
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
    </div>
  );
}
