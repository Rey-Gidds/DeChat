"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./load-env");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const ws_ticket_1 = require("./ws-ticket");
const db_1 = require("./db");
const mongodb_1 = require("mongodb");
const presence_store_1 = require("./presence-store");
const app = (0, express_1.default)();
const allowedOrigin = process.env.CORS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
app.use((0, cors_1.default)({
    origin: allowedOrigin,
    credentials: true,
}));
app.use(express_1.default.json());
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: allowedOrigin,
        methods: ["GET", "POST"],
        credentials: true,
    },
});
const presence = new presence_store_1.InMemoryPresenceStore();
app.get("/health", (_req, res) => {
    res.json({ status: "healthy", service: "websocket-server" });
});
function getInternalSecret() {
    return process.env.INTERNAL_WS_SECRET || process.env.BETTER_AUTH_SECRET || process.env.WS_TICKET_SECRET || null;
}
app.post("/internal/membership-updated", (req, res) => {
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
    const { userId, roomId, status } = req.body ?? {};
    if (!isNonEmptyString(userId) || !isNonEmptyString(roomId) || !isNonEmptyString(status)) {
        res.status(400).json({ error: "userId, roomId, and status are required" });
        return;
    }
    const normalized = status.toUpperCase();
    if (normalized === "APPROVED") {
        io.to(`user:${userId}`).emit("REQUEST_APPROVED", { userId, roomId, status: normalized });
    }
    else if (normalized === "REJECTED") {
        io.to(`user:${userId}`).emit("REQUEST_REJECTED", { userId, roomId, status: normalized });
    }
    else {
        io.to(`user:${userId}`).emit("membership_updated", { userId, roomId, status: normalized });
    }
    res.json({ ok: true });
});
app.post("/internal/key-rotation-pending", (req, res) => {
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
app.post("/internal/key-rotation-complete", (req, res) => {
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
/**
 * Presence query endpoint — called by the REST API when building
 * the member list so it can merge online state without hitting MongoDB.
 *
 * GET /internal/presence?roomId=xxx
 * Returns: { onlineUserIds: string[] }
 */
app.get("/internal/presence", (req, res) => {
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
    const roomId = req.query.roomId;
    if (!roomId) {
        res.status(400).json({ error: "roomId query parameter required" });
        return;
    }
    const onlineUserIds = Array.from(presence.onlineUsers(roomId));
    res.json({ onlineUserIds });
});
const MAX_ENVELOPE_FIELD_SIZE = 8_192;
const MAX_TYPING_PREVIEW_SIZE = 120;
const DB_ACK_TIMEOUT_MS = 6_000;
function withTimeout(promise, timeoutMs, errorMessage) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs)),
    ]);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
io.use((socket, next) => {
    const ticket = socket.handshake.auth?.ticket ||
        socket.handshake.query?.ticket;
    if (!ticket) {
        return next(new Error("Authentication ticket required"));
    }
    const payload = (0, ws_ticket_1.verifyWsTicket)(ticket);
    if (!payload) {
        return next(new Error("Invalid or expired ticket"));
    }
    socket.data.userId = payload.userId;
    socket.data.roomId = payload.roomId;
    next();
});
io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id} (user ${socket.data.userId})`);
    socket.data.joinedRooms = new Set();
    socket.on("error", (err) => {
        console.error(`[socket ${socket.id}] error:`, err);
    });
    void socket.join(`user:${socket.data.userId}`);
    socket.on("watch_room_membership", async (payload, ack) => {
        const roomId = payload?.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        // Allow pending users to watch membership changes without joining the room.
        ack?.({ ok: true });
    });
    socket.on("join_room", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        if (socket.data.roomId && socket.data.roomId !== roomId) {
            socket.leave(`room:${socket.data.roomId}`);
        }
        socket.data.roomId = roomId;
        socket.data.joinedRooms.add(roomId);
        await socket.join(`room:${roomId}`);
        presence.connect(roomId, socket.data.userId);
        io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
            roomId,
            userId: socket.data.userId,
            isOnline: true,
        });
        ack?.({ ok: true, roomId });
    });
    socket.on("leave_room", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        const remaining = presence.disconnect(roomId, socket.data.userId);
        const isOnline = remaining > 0;
        // Emit BEFORE leaving the socket room so the leaving user receives this too.
        io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
            roomId,
            userId: socket.data.userId,
            isOnline,
        });
        await socket.leave(`room:${roomId}`);
        socket.data.joinedRooms.delete(roomId);
        if (socket.data.roomId === roomId) {
            socket.data.roomId = undefined;
        }
        ack?.({ ok: true });
    });
    socket.on("send_message", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        const disabled = await (0, db_1.isRoomDisabled)(roomId);
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
        if (ciphertext.length > MAX_ENVELOPE_FIELD_SIZE ||
            iv.length > MAX_ENVELOPE_FIELD_SIZE ||
            authTag.length > MAX_ENVELOPE_FIELD_SIZE) {
            ack?.({ ok: false, error: "Encrypted payload is too large" });
            return;
        }
        if (!["text", "image", "video", "gif"].includes(messageType)) {
            ack?.({ ok: false, error: "Invalid messageType" });
            return;
        }
        // Sanitize clientMessageId (optional — backward compatible)
        const clientMessageId = typeof payload?.clientMessageId === "string"
            ? payload.clientMessageId.slice(0, 64)
            : null;
        // Validate replyTo payload if present
        const replyToPayload = payload?.replyTo;
        let replyTo = null;
        if (replyToPayload) {
            if (typeof replyToPayload.messageId !== "string" ||
                typeof replyToPayload.senderId !== "string" ||
                typeof replyToPayload.senderName !== "string" ||
                !["text", "image", "video", "gif"].includes(replyToPayload.messageType)) {
                ack?.({ ok: false, error: "Invalid replyTo payload" });
                return;
            }
            if (!/^[a-fA-F0-9]{24}$/.test(replyToPayload.messageId)) {
                ack?.({ ok: false, error: "Invalid replyTo.messageId format" });
                return;
            }
            const dbInstance = await (0, db_1.getDb)();
            const quoted = await dbInstance.collection("room_messages").findOne({
                _id: new mongodb_1.ObjectId(replyToPayload.messageId),
                roomId: new mongodb_1.ObjectId(roomId),
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
            const savedMessage = await withTimeout((0, db_1.persistEncryptedMessage)({
                roomId,
                senderId: socket.data.userId,
                ciphertext,
                iv,
                authTag,
                messageType,
                roomKeyVersion,
                replyTo: replyTo,
            }), DB_ACK_TIMEOUT_MS, "Database request timed out");
            const senderInfo = await (0, db_1.getSenderInfo)(roomId, socket.data.userId);
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
            // ACK back to sender (for outbox reconciliation)
            ack?.({
                ok: true,
                message: outbound,
            });
            // Broadcast to room
            io.to(`room:${roomId}`).emit("room_message", outbound);
        }
        catch (err) {
            ack?.({
                ok: false,
                error: err instanceof Error ? err.message : "Failed to persist message",
            });
        }
    });
    socket.on("edit_message", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        if (!payload?.messageId) {
            ack?.({ ok: false, error: "messageId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        const disabled = await (0, db_1.isRoomDisabled)(roomId);
        if (disabled) {
            ack?.({ ok: false, error: "ROOM_DISABLED" });
            return;
        }
        const { ciphertext, iv, authTag } = payload ?? {};
        if (!isNonEmptyString(ciphertext) || !isNonEmptyString(iv) || !isNonEmptyString(authTag)) {
            ack?.({ ok: false, error: "ciphertext, iv, and authTag are required" });
            return;
        }
        if (ciphertext.length > MAX_ENVELOPE_FIELD_SIZE ||
            iv.length > MAX_ENVELOPE_FIELD_SIZE ||
            authTag.length > MAX_ENVELOPE_FIELD_SIZE) {
            ack?.({ ok: false, error: "Encrypted payload is too large" });
            return;
        }
        try {
            const db = await (0, db_1.getDb)();
            const message = await db.collection("room_messages").findOne({
                _id: new mongodb_1.ObjectId(payload.messageId),
                roomId: new mongodb_1.ObjectId(roomId),
            });
            if (!message) {
                ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
                return;
            }
            if (message.senderId.toHexString() !== socket.data.userId) {
                ack?.({ ok: false, error: "NOT_MESSAGE_OWNER" });
                return;
            }
            // 15-minute edit window enforcement
            const now = new Date();
            const createdAt = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
            const diffMs = now.getTime() - createdAt.getTime();
            if (diffMs > 15 * 60 * 1000) {
                ack?.({ ok: false, error: "EDIT_WINDOW_EXPIRED" });
                return;
            }
            // Max 2 edits allowed
            const currentEditCount = (typeof message.editCount === "number") ? message.editCount : 0;
            if (currentEditCount >= 2) {
                ack?.({ ok: false, error: "MAX_EDITS_REACHED" });
                return;
            }
            const newEditCount = currentEditCount + 1;
            const updated = await (0, db_1.updateMessageContent)(roomId, payload.messageId, socket.data.userId, ciphertext, iv, authTag, newEditCount);
            if (!updated) {
                ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
                return;
            }
            const senderInfo = await (0, db_1.getSenderInfo)(roomId, socket.data.userId);
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
        }
        catch (err) {
            ack?.({
                ok: false,
                error: err instanceof Error ? err.message : "Failed to edit message",
            });
        }
    });
    socket.on("delete_message", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        if (!payload?.messageId) {
            ack?.({ ok: false, error: "messageId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        const disabled = await (0, db_1.isRoomDisabled)(roomId);
        if (disabled) {
            ack?.({ ok: false, error: "ROOM_DISABLED" });
            return;
        }
        try {
            const db = await (0, db_1.getDb)();
            const message = await db.collection("room_messages").findOne({
                _id: new mongodb_1.ObjectId(payload.messageId),
                roomId: new mongodb_1.ObjectId(roomId),
            });
            if (!message) {
                ack?.({ ok: false, error: "MESSAGE_NOT_FOUND" });
                return;
            }
            if (message.senderId.toHexString() !== socket.data.userId) {
                ack?.({ ok: false, error: "NOT_MESSAGE_OWNER" });
                return;
            }
            const deleted = await (0, db_1.deleteMessage)(roomId, payload.messageId, socket.data.userId);
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
        }
        catch (err) {
            ack?.({
                ok: false,
                error: err instanceof Error ? err.message : "Failed to delete message",
            });
        }
    });
    socket.on("typing_start", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        const disabled = await (0, db_1.isRoomDisabled)(roomId);
        if (disabled) {
            ack?.({ ok: false, error: "ROOM_DISABLED" });
            return;
        }
        const preview = typeof payload?.preview === "string"
            ? payload.preview.slice(0, MAX_TYPING_PREVIEW_SIZE)
            : "";
        socket.to(`room:${roomId}`).emit("typing_started", {
            roomId,
            userId: socket.data.userId,
            preview,
        });
        ack?.({ ok: true });
    });
    socket.on("typing_stop", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        const disabled = await (0, db_1.isRoomDisabled)(roomId);
        if (disabled) {
            ack?.({ ok: false, error: "ROOM_DISABLED" });
            return;
        }
        socket.to(`room:${roomId}`).emit("typing_stopped", {
            roomId,
            userId: socket.data.userId,
        });
        ack?.({ ok: true });
    });
    socket.on("sync_since", async (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId) {
            ack?.({ ok: false, error: "roomId required" });
            return;
        }
        if (!isNonEmptyString(payload?.since)) {
            ack?.({ ok: false, error: "since timestamp required" });
            return;
        }
        const member = await (0, db_1.isActiveMember)(roomId, socket.data.userId);
        if (!member) {
            ack?.({ ok: false, error: "Not an active member of this room" });
            return;
        }
        try {
            const limit = typeof payload.limit === "number"
                ? Math.min(Math.max(payload.limit, 1), 100)
                : 100;
            const messages = await (0, db_1.fetchMessagesSince)(roomId, socket.data.userId, payload.since, payload.sinceId, limit);
            ack?.({ ok: true, messages });
        }
        catch {
            ack?.({ ok: false, error: "Failed to sync messages" });
        }
    });
    socket.on("disconnect", () => {
        console.log(`Socket disconnected: ${socket.id}`);
        const userId = socket.data.userId;
        for (const roomId of socket.data.joinedRooms) {
            const remaining = presence.disconnect(roomId, userId);
            const isOnline = remaining > 0;
            io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
                roomId,
                userId,
                isOnline,
            });
        }
        socket.data.joinedRooms.clear();
    });
    // ── Heartbeat ──
    socket.on("heartbeat", (payload, ack) => {
        const roomId = payload?.roomId || socket.data.roomId;
        if (!roomId || !socket.data.userId) {
            ack?.({ ok: false });
            return;
        }
        presence.heartbeat(roomId, socket.data.userId);
        ack?.({ ok: true });
    });
});
// Start periodic heartbeat eviction — emits PRESENCE_UPDATED for stale users
presence.startCleanup((roomId, userId) => {
    io.to(`room:${roomId}`).emit("PRESENCE_UPDATED", {
        roomId,
        userId,
        isOnline: false,
    });
});
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
