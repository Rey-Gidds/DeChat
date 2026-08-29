import "./load-env";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { verifyWsTicket } from "./ws-ticket";
import {
  fetchMessagesSince,
  isActiveMember,
  isRoomDisabled,
  persistEncryptedMessage,
  updateMessageContent,
  deleteMessage,
  getSenderInfo,
  getDb,
  getRoomsMetadata,
  getApprovedRoomMemberIds,
  incrementMutationVersion,
  fetchMutationPatches,
} from "./db";
import { ObjectId } from "mongodb";
import { InMemoryPresenceStore, type PresenceStore } from "./presence-store";
import { subscriptionManager } from "./subscription-manager";
import { TypingLeaseManager } from "./typing-lease";
import { UnreadCounterManager } from "./unread-counter";
import { sendFCMPushNotification } from "./fcm";
import type { AuthedSocket, MembershipCacheEntry } from "./types";

const app = express();
const allowedOrigin =
  process.env.CORS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const presence: PresenceStore = new InMemoryPresenceStore();

const typingLeases = new TypingLeaseManager((roomId, userId) => {
  io.to(`room:${roomId}`).emit("typing_expired", { roomId, userId });
});

const unreadCounters = new UnreadCounterManager();

app.get("/health", (_req:any, res:any) => {
  res.json({ status: "healthy", service: "websocket-server" });
});

function getInternalSecret(): string | null {
  return process.env.INTERNAL_WS_SECRET || process.env.BETTER_AUTH_SECRET || process.env.WS_TICKET_SECRET || null;
}

// ── Membership cache ──────────────────────────────────────────────────

const MEMBERSHIP_CACHE_TTL = 60_000;

async function checkMembership(socket: AuthedSocket, roomId: string): Promise<boolean> {
  const cached = socket.data.membershipCache.get(roomId);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;
  const valid = await isActiveMember(roomId, socket.data.userId);
  socket.data.membershipCache.set(roomId, { valid, expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL });
  return valid;
}

function invalidateMembershipCache(userSockets: any[], roomId: string): void {
  for (const s of userSockets) {
    (s as any).data?.membershipCache?.delete?.(roomId);
  }
}

// ── Internal REST endpoints ───────────────────────────────────────────

// Extended membership-updated: dual-channel delivery
app.post("/internal/membership-updated", async (req:any, res:any) => {
  const secret = getInternalSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal secret not configured" });
    return;
  }

  const provided = req.header("x-internal-secret");
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { userId, roomId, status, isBlocked, roomName, kickedBy, reason, isDeleted } = req.body ?? {};
  if (!isNonEmptyString(userId) || !isNonEmptyString(roomId)) {
    res.status(400).json({ error: "userId and roomId are required" });
    return;
  }

  const normalized = (status ?? "").toUpperCase();
  const userSockets = await io.in(`user:${userId}`).fetchSockets();

  if (isDeleted) {
    // Room deleted — dual channel
    io.to(`room:${roomId}`).emit("room_deleted", { roomId, roomName: roomName || "" });
    for (const s of userSockets) {
      io.to(`user:${(s as any).data.userId}`).emit("room_deleted", { roomId, roomName: roomName || "" });
    }
    const roomSubs = await io.in(`room:${roomId}`).fetchSockets();
    await subscriptionManager.unsubscribeAllFromRoom(roomSubs as any[], roomId);
    invalidateMembershipCache(userSockets as any[], roomId);
    res.json({ ok: true });
    return;
  }

  if (normalized === "APPROVED") {
    // Dual channel: room broadcast + user channel
    io.to(`room:${roomId}`).emit("room_member_joined", {
      roomId, userId, role: req.body.role, userIndex: req.body.userIndex,
      userName: req.body.userName, userPfp: req.body.userPfp,
    });
    io.to(`user:${userId}`).emit("room_member_joined", {
      roomId, roomName: roomName || "", memberCount: req.body.memberCount ?? 0, status: "APPROVED",
    });
    // Legacy compatibility
    io.to(`user:${userId}`).emit("REQUEST_APPROVED", { userId, roomId, status: normalized });
  } else if (normalized === "LEFT" && !isBlocked) {
    // Dual channel: room broadcast + user channel
    io.to(`room:${roomId}`).emit("room_member_left", {
      roomId, userId, userName: req.body.userName || "",
    });
    io.to(`user:${userId}`).emit("room_member_left", {
      roomId, roomName: roomName || "", reason: "left",
    });
    // Legacy compatibility
    io.to(`user:${userId}`).emit("membership_updated", { userId, roomId, status: normalized });
  } else if (isBlocked || normalized === "KICKED" || normalized === "LEFT") {
    // Kick / block — dual channel + force unsubscribe + clear unread counters
    io.to(`room:${roomId}`).emit("room_member_kicked", {
      roomId, userId, kickedBy: kickedBy || null, reason: reason || "removed",
    });
    io.to(`user:${userId}`).emit("room_member_kicked", {
      roomId, roomName: roomName || "", kickedBy: kickedBy || null, reason: reason || "removed",
    });
    await subscriptionManager.unsubscribeUserFromRoom(userSockets as any[], roomId);
    invalidateMembershipCache(userSockets as any[], roomId);
    // Clean up unread counters
    void unreadCounters.delete(userId, roomId);
    // Legacy compatibility
    io.to(`user:${userId}`).emit("membership_updated", { userId, roomId, status: normalized });
  } else if (normalized === "REJECTED") {
    io.to(`user:${userId}`).emit("REQUEST_REJECTED", { userId, roomId, status: normalized });
  } else {
    io.to(`user:${userId}`).emit("membership_updated", { userId, roomId, status: normalized });
  }

  res.json({ ok: true });
});

app.post("/internal/key-rotation-pending", (req:any, res:any) => {
  const secret = getInternalSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal secret not configured" });
    return;
  }

  const provided = req.header("x-internal-secret");
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { roomId, version, reason, triggerUserId } = req.body ?? {};
  if (!isNonEmptyString(roomId) || typeof version !== "number") {
    res.status(400).json({ error: "roomId and version are required" });
    return;
  }

  io.to(`room:${roomId}`).emit("PENDING_KEY_ROTATION", {
    roomId,
    version,
    reason: reason || "UNKNOWN",
    triggerUserId: triggerUserId || null,
  });
  res.json({ ok: true });
});

app.post("/internal/key-rotation-complete", (req:any, res:any) => {
  const secret = getInternalSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal secret not configured" });
    return;
  }

  const provided = req.header("x-internal-secret");
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { roomId, version } = req.body ?? {};
  if (!isNonEmptyString(roomId) || typeof version !== "number") {
    res.status(400).json({ error: "roomId and version are required" });
    return;
  }

  io.to(`room:${roomId}`).emit("KEY_ROTATION_COMPLETE", {
    roomId,
    version,
  });
  res.json({ ok: true });
});

app.post("/internal/room-metadata-updated", (req:any, res:any) => {
  const secret = getInternalSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal secret not configured" });
    return;
  }
  const provided = req.header("x-internal-secret");
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { roomId, newName, description, isDisabled } = req.body ?? {};
  if (!isNonEmptyString(roomId)) {
    res.status(400).json({ error: "roomId required" });
    return;
  }

  if (isNonEmptyString(newName) || typeof description === "string") {
    io.to(`room:${roomId}`).emit("room_updated", { roomId, name: newName, description });
  }
  if (isNonEmptyString(newName)) {
    io.to(`room:${roomId}`).emit("room_renamed", { roomId, newName });
  }
  if (typeof isDisabled === "boolean") {
    io.to(`room:${roomId}`).emit("room_disabled", { roomId, isDisabled });
  }

  res.json({ ok: true });
});

/**
 * Presence query endpoint — called by the REST API when building
 * the member list so it can merge online state without hitting MongoDB.
 *
 * GET /internal/presence?roomId=xxx
 * Returns: { onlineUserIds: string[] }
 */
app.get("/internal/presence", (req:any, res:any) => {
  const secret = getInternalSecret();
  if (!secret) {
    res.status(500).json({ error: "Internal secret not configured" });
    return;
  }
  const provided = req.header("x-internal-secret");
  if (provided !== secret) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const roomId = req.query.roomId as string | undefined;
  if (!roomId) {
    res.status(400).json({ error: "roomId query parameter required" });
    return;
  }

  const onlineUserIds = Array.from(presence.viewingUsers(roomId));
  res.json({ onlineUserIds });
});


// ── Constants ─────────────────────────────────────────────────────────

const MAX_ENVELOPE_FIELD_SIZE = 8_192;
const MAX_TYPING_PREVIEW_SIZE = 120;
const DB_ACK_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs)),
  ]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Auth Middleware ───────────────────────────────────────────────────

io.use((socket: AuthedSocket, next) => {
  const ticket =
    (socket.handshake.auth?.ticket as string | undefined) ||
    (socket.handshake.query?.ticket as string | undefined);

  if (!ticket) {
    return next(new Error("Authentication ticket required"));
  }

  const payload = verifyWsTicket(ticket);
  if (!payload) {
    return next(new Error("Invalid or expired ticket"));
  }

  socket.data.userId = payload.userId;
  // roomId is set only for room-type tickets (backward compat);
  // user-type tickets leave roomId undefined (global socket).
  socket.data.roomId = payload.roomId;
  next();
});

// ── Connection Handler ────────────────────────────────────────────────

io.on("connection", async (socket: AuthedSocket) => {
  console.log(`Socket connected: ${socket.id} (user ${socket.data.userId}, type=${socket.data.roomId ? "room" : "user"})`);

  // Initialize connection-scoped data
  socket.data.subscribedRooms = new Set();
  socket.data.membershipCache = new Map<string, MembershipCacheEntry>();

  socket.on("error", (err) => {
    console.error(`[socket ${socket.id}] error:`, err);
  });

  // Always join the user's personal channel
  void socket.join(`user:${socket.data.userId}`);

  // ── Global socket: bulk subscribe to all approved rooms ────────────
  const isGlobalSocket = !socket.data.roomId;
  if (isGlobalSocket) {
    try {
      const subCount = await subscriptionManager.initializeSubscriptions(socket);
      console.log(`[socket ${socket.id}] Global socket: subscribed to ${subCount} rooms`);
    } catch (err) {
      console.error(`[socket ${socket.id}] initializeSubscriptions failed:`, err);
    }
  }

  // ── watch_room_membership ─────────────────────────────────────────

  socket.on("watch_room_membership", async (payload: { roomId?: string }, ack) => {
    const roomId = payload?.roomId;
    if (!roomId) {
      ack?.({ ok: false, error: "roomId required" });
      return;
    }
    ack?.({ ok: true });
  });

  // ── subscribe_room (global socket: user joins new room mid-session) ─

  socket.on("subscribe_room", async (payload: { roomId?: string }, ack) => {
    const roomId = payload?.roomId;
    if (!roomId) {
      ack?.({ ok: false, error: "roomId required" });
      return;
    }
    const member = await checkMembership(socket, roomId);
    if (!member) {
      ack?.({ ok: false, error: "Not an active member of this room" });
      return;
    }
    const added = await subscriptionManager.subscribeRoom(socket, roomId);

    // Send typing snapshot for late joiners
    const snapshotTypers = typingLeases.getActiveTypers(roomId);
    if (snapshotTypers.length > 0) {
      socket.emit("typing_snapshot", { roomId, users: snapshotTypers.map((u) => ({ userId: u })) });
    }

    ack?.({ ok: true, subscribed: added });
  });

  // ── join_room ────────────────────────────────────────────────────

  socket.on("join_room", async (payload: { roomId?: string }, ack) => {
    const roomId = payload?.roomId || socket.data.roomId;
    if (!roomId) {
      ack?.({ ok: false, error: "roomId required" });
      return;
    }

    const member = await checkMembership(socket, roomId);
    if (!member) {
      ack?.({ ok: false, error: "Not an active member of this room" });
      return;
    }

    // For per-room sockets: leave previous room
    if (!isGlobalSocket && socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(`room:${socket.data.roomId}`);
    }

    // For global sockets: ensure subscription (may already be subscribed)
    if (isGlobalSocket && !socket.data.subscribedRooms.has(roomId)) {
      await subscriptionManager.subscribeRoom(socket, roomId);
    }

    socket.data.roomId = roomId;
    if (!isGlobalSocket) {
      socket.data.subscribedRooms.add(roomId);
      await socket.join(`room:${roomId}`);
      presence.connect(roomId, socket.data.userId);
      presence.viewingConnect(roomId, socket.data.userId);
      io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
        roomId,
        userId: socket.data.userId,
        isOnline: true,
      });

      // Notify room that user is viewing (new global socket event)
      io.to(`room:${roomId}`).emit("viewing_room_start", {
        roomId,
        userId: socket.data.userId,
      });
    }

    // Send typing snapshot for late joiners
    const joinSnapshotTypers = typingLeases.getActiveTypers(roomId);
    if (joinSnapshotTypers.length > 0) {
      socket.emit("typing_snapshot", { roomId, users: joinSnapshotTypers.map((u) => ({ userId: u })) });
    }

    ack?.({ ok: true, roomId });
  });


  // ── viewing_room_start & viewing_room_stop ────────────────────────
  socket.on("viewing_room_start", async (payload: { roomId?: string }) => {
    const roomId = payload?.roomId;
    if (!roomId) return;

    try {
      const member = await checkMembership(socket, roomId);
      if (!member) return;
    } catch (err) {
      console.error(`[socket ${socket.id}] checkMembership failed in viewing_room_start:`, err);
      return;
    }

    // Ensure the socket is actually joined to the room channel
    if (!socket.data.subscribedRooms.has(roomId)) {
      try {
        await socket.join(`room:${roomId}`);
        socket.data.subscribedRooms.add(roomId);
        console.log(`[socket ${socket.id}] Late-subscribed to room ${roomId} via viewing_room_start`);
      } catch (err) {
        console.error(`[socket ${socket.id}] Failed to join room ${roomId}:`, err);
      }
    }

    socket.data.viewingRoomId = roomId;
    presence.connect(roomId, socket.data.userId);
    presence.viewingConnect(roomId, socket.data.userId);
    io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
      roomId,
      userId: socket.data.userId,
      isOnline: true,
    });
    io.to(`room:${roomId}`).emit("viewing_room_start", {
      roomId,
      userId: socket.data.userId,
    });
  });

  socket.on("viewing_room_stop", async (payload: { roomId?: string }) => {
    const roomId = payload?.roomId || socket.data.viewingRoomId;
    if (!roomId) return;
    presence.viewingDisconnect(roomId, socket.data.userId);
    const remaining = presence.disconnect(roomId, socket.data.userId);
    const isOnline = remaining > 0;
    io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
      roomId,
      userId: socket.data.userId,
      isOnline,
    });
    io.to(`room:${roomId}`).emit("viewing_room_stop", {
      roomId,
      userId: socket.data.userId,
    });
    if (socket.data.viewingRoomId === roomId) {
      socket.data.viewingRoomId = undefined;
    }
  });

  // ── leave_room ───────────────────────────────────────────────────

  socket.on("leave_room", async (payload: { roomId?: string }, ack) => {
    const roomId = payload?.roomId || socket.data.roomId;
    if (!roomId) {
      ack?.({ ok: false, error: "roomId required" });
      return;
    }

    const remaining = presence.disconnect(roomId, socket.data.userId);
    presence.viewingDisconnect(roomId, socket.data.userId);
    const isOnline = remaining > 0;
    io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
      roomId,
      userId: socket.data.userId,
      isOnline,
    });

    // Notify room that user stopped viewing
    io.to(`room:${roomId}`).emit("viewing_room_stop", {
      roomId,
      userId: socket.data.userId,
    });

    if (isGlobalSocket) {
      // Global socket: don't leave Socket.IO room, just clear viewing state
      socket.data.viewingRoomId = undefined;
    } else {
      // Per-room socket: actually leave the room
      await socket.leave(`room:${roomId}`);
      socket.data.subscribedRooms.delete(roomId);
      if (socket.data.roomId === roomId) {
        socket.data.roomId = undefined;
      }
    }
    ack?.({ ok: true });
  });

  // ── send_message ─────────────────────────────────────────────────

  socket.on(
    "send_message",
    async (
      payload: {
        roomId?: string;
        clientMessageId?: string;
        ciphertext?: string;
        iv?: string;
        authTag?: string;
        messageType?: "text" | "image" | "video" | "gif" | "audio";
        roomKeyVersion?: number;
      },
      ack
    ) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      const disabled = await isRoomDisabled(roomId);
      if (disabled) {
        ack?.({ ok: false, error: "ROOM_DISABLED" });
        return;
      }

      const { ciphertext, iv, authTag } = payload ?? {};
      const messageType = payload?.messageType ?? "text";
      if (!isNonEmptyString(ciphertext) || !isNonEmptyString(iv) || !isNonEmptyString(authTag)) {
        ack?.({ ok: false, error: "ciphertext, iv, and authTag are required" });
        return;
      }

      if (
        ciphertext.length > MAX_ENVELOPE_FIELD_SIZE ||
        iv.length > MAX_ENVELOPE_FIELD_SIZE ||
        authTag.length > MAX_ENVELOPE_FIELD_SIZE
      ) {
        ack?.({ ok: false, error: "Encrypted payload is too large" });
        return;
      }

      if (!["text", "image", "video", "gif", "audio"].includes(messageType)) {
        ack?.({ ok: false, error: "Invalid messageType" });
        return;
      }

      const clientMessageId = typeof payload?.clientMessageId === "string"
        ? payload.clientMessageId.slice(0, 64)
        : null;

      // Validate replyTo payload if present
      const replyToPayload = (payload as any)?.replyTo;
      let replyTo: Record<string, unknown> | null = null;
      if (replyToPayload) {
        if (
          typeof replyToPayload.messageId !== "string" ||
          typeof replyToPayload.senderId !== "string" ||
          typeof replyToPayload.senderName !== "string" ||
          !["text", "image", "video", "gif", "audio"].includes(replyToPayload.messageType)
        ) {
          ack?.({ ok: false, error: "Invalid replyTo payload" });
          return;
        }
        if (!/^[a-fA-F0-9]{24}$/.test(replyToPayload.messageId)) {
          ack?.({ ok: false, error: "Invalid replyTo.messageId format" });
          return;
        }

        const dbInstance = await getDb();
        const quoted = await dbInstance.collection("room_messages").findOne({
          _id: new ObjectId(replyToPayload.messageId),
          roomId: new ObjectId(roomId),
        });
        if (!quoted) {
          ack?.({ ok: false, error: "REPLY_TARGET_NOT_FOUND" });
          return;
        }

        replyTo = {
          messageId: replyToPayload.messageId,
          senderId: replyToPayload.senderId,
          senderName: replyToPayload.senderName,
          senderUserIndex: replyToPayload.senderUserIndex ?? null,
          messageType: replyToPayload.messageType,
          previewIv: replyToPayload.previewIv ?? null,
          previewCiphertext: replyToPayload.previewCiphertext ?? null,
          previewAuthTag: replyToPayload.previewAuthTag ?? null,
        };
      }

      try {
        const roomKeyVersion = typeof payload?.roomKeyVersion === "number" ? payload.roomKeyVersion : undefined;

        const savedMessage = await withTimeout(
          persistEncryptedMessage({
            roomId,
            senderId: socket.data.userId,
            ciphertext,
            iv,
            authTag,
            messageType,
            roomKeyVersion,
            replyTo: replyTo as any,
          }),
          DB_ACK_TIMEOUT_MS,
          "Database request timed out"
        );

        const senderInfo = await getSenderInfo(roomId, socket.data.userId);

        const outbound = {
          id: savedMessage._id,
          roomId,
          senderId: socket.data.userId,
          ciphertext,
          iv,
          authTag,
          messageType,
          ...(roomKeyVersion !== undefined ? { roomKeyVersion } : {}),
          replyTo: replyTo
            ? {
                messageId: replyTo.messageId,
                senderId: replyTo.senderId,
                senderName: replyTo.senderName,
                senderUserIndex: replyTo.senderUserIndex ?? null,
                messageType: replyTo.messageType,
                previewIv: replyTo.previewIv ?? null,
                previewCiphertext: replyTo.previewCiphertext ?? null,
                previewAuthTag: replyTo.previewAuthTag ?? null,
              }
            : null,
          editedAt: null,
          createdAt: savedMessage.createdAt,
          senderName: senderInfo.name,
          senderUserIndex: senderInfo.userIndex,
          senderPfp: senderInfo.pfp,
          clientMessageId,
        };

        // ACK back to sender
        ack?.({
          ok: true,
          message: outbound,
        });

        // Broadcast to room (full encrypted message)
        io.to(`room:${roomId}`).emit("room_message", outbound);

        // ── NEW: Lightweight room broadcast for room-list reordering ──
        io.to(`room:${roomId}`).emit("room_new_message_notify", {
          roomId,
          senderId: socket.data.userId,
          senderName: senderInfo.name,
          senderUserIndex: senderInfo.userIndex,
          senderPfp: senderInfo.pfp,
          messageType,
          createdAt: savedMessage.createdAt,
          messageId: savedMessage._id,
        });

        // ── NEW: Per-subscriber unread increment & FCM push for ALL members (online & offline/closed) ──
        const [memberUserIds, roomSockets, roomMetaArr] = await Promise.all([
          getApprovedRoomMemberIds(roomId),
          io.in(`room:${roomId}`).fetchSockets(),
          getRoomsMetadata([roomId]),
        ]);

        const roomName = roomMetaArr[0]?.roomName || "DeChat Room";
        const createdAtDate = new Date(savedMessage.createdAt);

        // Identify sockets currently viewing this room
        const activeViewerUserIds = new Set<string>();
        for (const sRaw of roomSockets) {
          const s = sRaw as any;
          if (s.data?.viewingRoomId === roomId && s.data?.userId) {
            activeViewerUserIds.add(s.data.userId);
          }
        }

        for (const memberUserId of memberUserIds) {
          if (memberUserId === socket.data.userId) continue;          // skip sender
          if (activeViewerUserIds.has(memberUserId)) continue;        // skip active room viewers

          const { count, version } = await unreadCounters.increment(memberUserId, roomId, createdAtDate);

          // Realtime Socket event (emitted to user channel, received if socket is connected)
          io.to(`user:${memberUserId}`).emit("user_unread_increment", {
            roomId,
            unreadCount: count,
            version,
            senderId: socket.data.userId,
            senderName: senderInfo.name,
            messageType,
            createdAt: savedMessage.createdAt,
          });

          // FCM Push notification (delivered by Firebase to Service Worker even when browser/app is CLOSED)
          void sendFCMPushNotification(memberUserId, {
            roomId,
            roomName,
            unreadCount: count,
            version,
          });
        }
      } catch (err) {
        ack?.({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to persist message",
        });
      }
    }
  );

  // ── edit_message ──────────────────────────────────────────────────

  socket.on(
    "edit_message",
    async (
      payload: {
        roomId?: string;
        messageId?: string;
        ciphertext?: string;
        iv?: string;
        authTag?: string;
      },
      ack
    ) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      if (!payload?.messageId) {
        ack?.({ ok: false, error: "messageId required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      const disabled = await isRoomDisabled(roomId);
      if (disabled) {
        ack?.({ ok: false, error: "ROOM_DISABLED" });
        return;
      }

      const { ciphertext, iv, authTag } = payload ?? {};
      if (!isNonEmptyString(ciphertext) || !isNonEmptyString(iv) || !isNonEmptyString(authTag)) {
        ack?.({ ok: false, error: "ciphertext, iv, and authTag are required" });
        return;
      }

      if (
        ciphertext.length > MAX_ENVELOPE_FIELD_SIZE ||
        iv.length > MAX_ENVELOPE_FIELD_SIZE ||
        authTag.length > MAX_ENVELOPE_FIELD_SIZE
      ) {
        ack?.({ ok: false, error: "Encrypted payload is too large" });
        return;
      }

      try {
        const db = await getDb();
        const message = await db.collection("room_messages").findOne({
          _id: new ObjectId(payload.messageId),
          roomId: new ObjectId(roomId),
        });

        if (!message) {
          ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
          return;
        }

        if (message.senderId.toHexString() !== socket.data.userId) {
          ack?.({ ok: false, error: "NOT_MESSAGE_OWNER" });
          return;
        }

        const now = new Date();
        const createdAt = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
        const diffMs = now.getTime() - createdAt.getTime();
        if (diffMs > 15 * 60 * 1000) {
          ack?.({ ok: false, error: "EDIT_WINDOW_EXPIRED" });
          return;
        }

        const currentEditCount = (typeof (message as any).editCount === "number") ? (message as any).editCount : 0;
        if (currentEditCount >= 2) {
          ack?.({ ok: false, error: "MAX_EDITS_REACHED" });
          return;
        }

        const newEditCount = currentEditCount + 1;
        const updated = await updateMessageContent(
          roomId,
          payload.messageId,
          socket.data.userId,
          ciphertext,
          iv,
          authTag,
          newEditCount
        );

        if (!updated) {
          ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
          return;
        }

        const senderInfo = await getSenderInfo(roomId, socket.data.userId);

        const outbound = {
          id: payload.messageId,
          roomId,
          messageId: payload.messageId,
          senderId: socket.data.userId,
          ciphertext,
          iv,
          authTag,
          messageType: message.messageType,
          roomKeyVersion: typeof message.roomKeyVersion === "number" ? message.roomKeyVersion : 0,
          createdAt: (message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt)).toISOString(),
          editedAt: now.toISOString(),
          editCount: newEditCount,
          replyTo: message.replyTo
            ? {
                messageId: message.replyTo.messageId.toString(),
                senderId: message.replyTo.senderId.toString(),
                senderName: message.replyTo.senderName,
                senderUserIndex: message.replyTo.senderUserIndex ?? null,
                messageType: message.replyTo.messageType,
                previewIv: message.replyTo.previewIv ?? null,
                previewCiphertext: message.replyTo.previewCiphertext ?? null,
                previewAuthTag: message.replyTo.previewAuthTag ?? null,
              }
            : null,
          senderName: senderInfo.name,
          senderUserIndex: senderInfo.userIndex,
          senderPfp: senderInfo.pfp,
        };

        ack?.({ ok: true, message: outbound });
        io.to(`room:${roomId}`).emit("message_edited", outbound);
        // Bump mutationVersion so clients can detect stale caches on next sync
        void incrementMutationVersion(roomId);
      } catch (err) {
        ack?.({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to edit message",
        });
      }
    }
  );

  // ── delete_message ────────────────────────────────────────────────

  socket.on(
    "delete_message",
    async (
      payload: {
        roomId?: string;
        messageId?: string;
      },
      ack
    ) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      if (!payload?.messageId) {
        ack?.({ ok: false, error: "messageId required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      const disabled = await isRoomDisabled(roomId);
      if (disabled) {
        ack?.({ ok: false, error: "ROOM_DISABLED" });
        return;
      }

      try {
        const db = await getDb();
        const message = await db.collection("room_messages").findOne({
          _id: new ObjectId(payload.messageId),
          roomId: new ObjectId(roomId),
        });

        if (!message) {
          ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
          return;
        }

        if (message.senderId.toHexString() !== socket.data.userId) {
          ack?.({ ok: false, error: "NOT_MESSAGE_OWNER" });
          return;
        }

        const deleted = await deleteMessage(roomId, payload.messageId, socket.data.userId);

        if (!deleted) {
          ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
          return;
        }

        const outbound = {
          roomId,
          messageId: payload.messageId,
          senderId: socket.data.userId,
        };

        ack?.({ ok: true });
        io.to(`room:${roomId}`).emit("message_deleted", outbound);
        // Bump mutationVersion so clients can detect stale caches on next sync
        void incrementMutationVersion(roomId);
      } catch (err) {
        ack?.({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to delete message",
        });
      }
    }
  );

  // ── typing (lease-based) ────────────────────────────────────────────

  socket.on(
    "typing",
    async (payload: { roomId?: string; preview?: string }, ack) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      const disabled = await isRoomDisabled(roomId);
      if (disabled) {
        ack?.({ ok: false, error: "ROOM_DISABLED" });
        return;
      }

      const preview =
        typeof payload?.preview === "string"
          ? payload.preview.slice(0, MAX_TYPING_PREVIEW_SIZE)
          : "";

      const isNew = typingLeases.refreshLease(roomId, socket.data.userId);
      if (isNew) {
        socket.to(`room:${roomId}`).emit("typing_started", {
          roomId,
          userId: socket.data.userId,
          preview,
        });
      }
      ack?.({ ok: true });
    }
  );

  // ── Deprecated: typing_start (backward compat — delegates to typing handler) ─

  socket.on(
    "typing_start",
    async (payload: { roomId?: string; preview?: string }, ack) => {
      // Forward to the lease-based typing handler for backward compatibility
      socket.emit("typing", payload);
      ack?.({ ok: true });
    }
  );

  // ── Deprecated: typing_stop (no-op — lease expiry handles stopping) ──

  socket.on("typing_stop", async (_payload: { roomId?: string }, ack) => {
    // No-op: the lease expiry timer handles stopping now
    ack?.({ ok: true });
  });

  // ── mark_as_read ──────────────────────────────────────────────────

  socket.on("mark_as_read", async (payload: { roomId?: string; version: number }, ack) => {
    const { roomId: payloadRoomId, version } = payload;
    const userId = socket.data.userId;
    const roomId = payloadRoomId || socket.data.roomId;
    if (!roomId || !userId) {
      ack?.({ ok: false, error: "Missing roomId/userId" });
      return;
    }

    const result = await unreadCounters.resetIfVersion(userId, roomId, version);
    if (result.success) {
      io.to(`user:${userId}`).emit("unread_count_updated", { roomId, unreadCount: 0, version: result.actualVersion });
      ack?.({ ok: true });
    } else {
      // Version mismatch — another message arrived. Return actual count.
      ack?.({ ok: true, conflict: true, unreadCount: result.actualCount, version: result.actualVersion });
    }
  });

  // ── sync_since ────────────────────────────────────────────────────

  socket.on(
    "sync_since",
    async (
      payload: { roomId?: string; since?: string; sinceId?: string; limit?: number },
      ack
    ) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      if (!isNonEmptyString(payload?.since)) {
        ack?.({ ok: false, error: "since timestamp required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      try {
        const limit =
          typeof payload.limit === "number"
            ? Math.min(Math.max(payload.limit, 1), 100)
            : 100;
        const messages = await fetchMessagesSince(
          roomId,
          socket.data.userId,
          payload.since,
          payload.sinceId,
          limit
        );
        ack?.({ ok: true, messages });
      } catch {
        ack?.({ ok: false, error: "Failed to sync messages" });
      }
    }
  );

  // ── sync_room_cache ───────────────────────────────────────────────
  // WebSocket RPC that replaces the HTTP resumeSync() in the room bootstrap.
  // Detects new messages (delta/replace strategy) AND edited/deleted messages
  // (mutation patches) using version metadata, so caches stay fully fresh.

  socket.on(
    "sync_room_cache",
    async (
      payload: {
        roomId?: string;
        newestCachedMessageId?: string;
        newestCachedCreatedAt?: string;
        mutationVersion?: number;
        cacheVersion?: number;
        cachedMessageIds?: string[];
      },
      ack
    ) => {
      const roomId = payload?.roomId || socket.data.roomId;
      if (!roomId) {
        ack?.({ ok: false, error: "roomId required" });
        return;
      }

      const member = await checkMembership(socket, roomId);
      if (!member) {
        ack?.({ ok: false, error: "Not an active member of this room" });
        return;
      }

      try {
        const db = await getDb();
        const room = await db.collection("rooms").findOne(
          { _id: new ObjectId(roomId) },
          { projection: { latestMessageId: 1, latestMessageCreatedAt: 1, mutationVersion: 1 } }
        );

        if (!room) {
          ack?.({ ok: false, error: "Room not found" });
          return;
        }

        const serverMutationVersion: number = typeof room.mutationVersion === "number" ? room.mutationVersion : 0;
        const clientMutationVersion: number = typeof payload?.mutationVersion === "number" ? payload.mutationVersion : 0;

        const membership = await db.collection("room_memberships").findOne(
          { roomId: new ObjectId(roomId), userId: new ObjectId(socket.data.userId) },
          { projection: { joinedAt: 1 } }
        );
        const joinedAt: Date = membership?.joinedAt instanceof Date ? membership.joinedAt : new Date(0);

        const { newestCachedMessageId, newestCachedCreatedAt } = payload ?? {};
        const CACHE_WINDOW = 100;
        const DELTA_LIMIT = 200;
        const collection = db.collection("room_messages");

        // ── Helper: fetch latest window (REPLACE strategy) ──
        const fetchReplaceWindow = async () => {
          const messages = await collection
            .find({ roomId: new ObjectId(roomId), createdAt: { $gt: joinedAt } })
            .sort({ createdAt: -1, _id: -1 })
            .limit(CACHE_WINDOW)
            .toArray();
          messages.reverse();

          const enriched = await (async () => {
            if (messages.length === 0) return [];
            const sIds = [...new Set(messages.map((d: any) => d.senderId.toHexString()))];
            const sOIds = sIds.map((id) => new ObjectId(id));
            const roomOId = new ObjectId(roomId);
            const [us, mbs] = await Promise.all([
              db.collection("user").find({ _id: { $in: sOIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray(),
              db.collection("room_memberships").find({ roomId: roomOId, userId: { $in: sOIds } }).project({ userId: 1, userIndex: 1 }).toArray(),
            ]);
            const uMap = new Map(us.map((u: any) => [u._id.toHexString(), u]));
            const mMap = new Map(mbs.map((m: any) => [m.userId.toHexString(), m]));
            return messages.map((d: any) => {
              const sid = d.senderId.toHexString();
              const u = uMap.get(sid);
              const mb = mMap.get(sid);
              const replyTo = d.replyTo ? {
                messageId: d.replyTo.messageId.toString(),
                senderId: d.replyTo.senderId.toString(),
                senderName: d.replyTo.senderName,
                senderUserIndex: d.replyTo.senderUserIndex ?? null,
                messageType: d.replyTo.messageType,
                previewIv: d.replyTo.previewIv ?? null,
                previewCiphertext: d.replyTo.previewCiphertext ?? null,
                previewAuthTag: d.replyTo.previewAuthTag ?? null,
              } : null;
              return {
                id: d._id.toHexString(),
                roomId,
                senderId: sid,
                ciphertext: d.ciphertext,
                iv: d.iv,
                authTag: d.authTag,
                messageType: d.messageType,
                roomKeyVersion: typeof d.roomKeyVersion === "number" ? d.roomKeyVersion : 0,
                replyTo,
                editedAt: d.editedAt ? (d.editedAt instanceof Date ? d.editedAt : new Date(d.editedAt)).toISOString() : null,
                editCount: d.editCount ?? 0,
                createdAt: (d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt)).toISOString(),
                senderName: u?.name || u?.email || null,
                senderUserIndex: mb?.userIndex ?? null,
                senderPfp: (u?.pfp as string) ?? null,
              };
            });
          })();

          return { strategy: "REPLACE" as const, messages: enriched, mutationPatches: undefined, serverMutationVersion };
        };

        // ── 1. Cold start ──
        if (!newestCachedMessageId || !newestCachedCreatedAt) {
          ack?.({ ok: true, ...(await fetchReplaceWindow()) });
          return;
        }

        // ── 2. Already up-to-date ──
        if (room.latestMessageId === newestCachedMessageId && clientMutationVersion === serverMutationVersion) {
          ack?.({ ok: true, strategy: "UP_TO_DATE", messages: [], serverMutationVersion });
          return;
        }

        // ── 3. Delta sync ──
        const anchorId = ObjectId.isValid(newestCachedMessageId) ? new ObjectId(newestCachedMessageId) : null;
        const sinceDate = new Date(newestCachedCreatedAt);

        if (!anchorId || Number.isNaN(sinceDate.getTime())) {
          ack?.({ ok: true, ...(await fetchReplaceWindow()) });
          return;
        }

        const roomOId = new ObjectId(roomId);
        const anchor = await collection.findOne({ _id: anchorId, roomId: roomOId });
        let deltaQuery: Record<string, unknown>;
        if (anchor) {
          deltaQuery = {
            roomId: roomOId,
            createdAt: { $gt: joinedAt },
            $or: [
              { createdAt: { $gt: anchor.createdAt } },
              { createdAt: anchor.createdAt, _id: { $gt: anchorId } },
            ],
          };
        } else {
          const effectiveSince = sinceDate > joinedAt ? sinceDate : joinedAt;
          deltaQuery = { roomId: roomOId, createdAt: { $gt: effectiveSince } };
        }

        const rawDelta = await collection
          .find(deltaQuery)
          .sort({ createdAt: 1, _id: 1 })
          .limit(DELTA_LIMIT + 1)
          .toArray();

        // Large gap → replace
        if (rawDelta.length > DELTA_LIMIT) {
          ack?.({ ok: true, ...(await fetchReplaceWindow()) });
          return;
        }

        // Enrich delta messages
        const sIds = [...new Set(rawDelta.map((d: any) => d.senderId.toHexString()))];
        const sOIds = sIds.map((id) => new ObjectId(id));
        const [us, mbs] = await Promise.all([
          sOIds.length > 0 ? db.collection("user").find({ _id: { $in: sOIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray() : [],
          sOIds.length > 0 ? db.collection("room_memberships").find({ roomId: roomOId, userId: { $in: sOIds } }).project({ userId: 1, userIndex: 1 }).toArray() : [],
        ]);
        const uMap = new Map(us.map((u: any) => [u._id.toHexString(), u]));
        const mMap = new Map(mbs.map((m: any) => [m.userId.toHexString(), m]));

        const deltaMessages = rawDelta.map((d: any) => {
          const sid = d.senderId.toHexString();
          const u = uMap.get(sid);
          const mb = mMap.get(sid);
          const replyTo = d.replyTo ? {
            messageId: d.replyTo.messageId.toString(),
            senderId: d.replyTo.senderId.toString(),
            senderName: d.replyTo.senderName,
            senderUserIndex: d.replyTo.senderUserIndex ?? null,
            messageType: d.replyTo.messageType,
            previewIv: d.replyTo.previewIv ?? null,
            previewCiphertext: d.replyTo.previewCiphertext ?? null,
            previewAuthTag: d.replyTo.previewAuthTag ?? null,
          } : null;
          return {
            id: d._id.toHexString(),
            roomId,
            senderId: sid,
            ciphertext: d.ciphertext,
            iv: d.iv,
            authTag: d.authTag,
            messageType: d.messageType,
            roomKeyVersion: typeof d.roomKeyVersion === "number" ? d.roomKeyVersion : 0,
            replyTo,
            editedAt: d.editedAt ? (d.editedAt instanceof Date ? d.editedAt : new Date(d.editedAt)).toISOString() : null,
            editCount: d.editCount ?? 0,
            createdAt: (d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt)).toISOString(),
            senderName: u?.name || u?.email || null,
            senderUserIndex: mb?.userIndex ?? null,
            senderPfp: (u?.pfp as string) ?? null,
          };
        });

        // ── 4. Mutation patches (only for DELTA when mutationVersion mismatch) ──
        let mutationPatches: { edits: any[]; deletes: any[] } | undefined;
        if (clientMutationVersion !== serverMutationVersion) {
          const ids = (payload?.cachedMessageIds ?? []).slice(0, 100);
          if (ids.length > 0) {
            mutationPatches = await fetchMutationPatches(roomId, ids);
          }
        }

        ack?.({
          ok: true,
          strategy: "DELTA",
          messages: deltaMessages,
          mutationPatches,
          serverMutationVersion,
        });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "sync_room_cache failed" });
      }
    }
  );

  // ── sync_metadata (NEW: global socket metadata sync on reconnect) ──

  socket.on("sync_metadata", async (_, ack) => {
    const roomIds = [...socket.data.subscribedRooms];
    if (roomIds.length === 0) {
      ack?.({ ok: true, metadata: [] });
      return;
    }
    try {
      const metadata = await getRoomsMetadata(roomIds);
      ack?.({ ok: true, metadata });
    } catch {
      ack?.({ ok: false, error: "Failed to sync metadata" });
    }
  });

  // ── disconnect ────────────────────────────────────────────────────

  socket.on("disconnect", async () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const userId = socket.data.userId;

    // Emit PRESENCE_UPDATED for all subscribed rooms (global socket)
    // or joinedRooms fallback for per-room sockets
    const rooms: string[] = socket.data.subscribedRooms.size > 0
      ? Array.from(socket.data.subscribedRooms) as string[]
      : [];

    for (const roomId of rooms) {
      const remaining = presence.disconnect(roomId, userId);
      presence.viewingDisconnect(roomId, userId);
      const isOnline = remaining > 0;
      io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
        roomId,
        userId,
        isOnline,
      });

      // Clean up typing leases on disconnect
      const wasTyping = typingLeases.removeUser(roomId, userId);
      if (wasTyping) {
        io.to(`room:${roomId}`).emit("typing_expired", { roomId, userId });
      }

      // Notify room that user stopped viewing (if they were viewing)
      if (socket.data.viewingRoomId === roomId) {
        io.to(`room:${roomId}`).emit("viewing_room_stop", {
          roomId,
          userId,
        });
      }
    }

    await subscriptionManager.handleDisconnect(socket);
    socket.data.membershipCache.clear();
  });

  // ── Heartbeat (supports both room-scoped and global) ───────────────

  socket.on("heartbeat", (payload: { roomId?: string; activeRoomId?: string | null }, ack) => {
    const userId = socket.data.userId;
    if (!userId) {
      ack?.({ ok: false });
      return;
    }

    // Global presence: always update
    presence.globalHeartbeat?.(userId);

    // Room presence: only when activeRoomId is explicitly provided (user is viewing/inside the room)
    const activeRoomId = payload?.activeRoomId;
    if (activeRoomId) {
      presence.heartbeat(activeRoomId, userId);
      presence.viewingHeartbeat(activeRoomId, userId);
    }

    ack?.({ ok: true });
  });

});

// Start periodic heartbeat eviction — emits PRESENCE_UPDATED for stale users
(presence as InMemoryPresenceStore).startCleanup((roomId: string, userId: string) => {
  io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
    roomId,
    userId,
    isOnline: false,
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  // Ensure unread_counters indexes on startup
  try {
    await UnreadCounterManager.ensureIndexes();
    console.log("[unread_counters] indexes ensured");
  } catch (err) {
    console.error("[unread_counters] failed to ensure indexes:", err);
  }
  console.log(`WebSocket server running on port ${PORT}`);
});
