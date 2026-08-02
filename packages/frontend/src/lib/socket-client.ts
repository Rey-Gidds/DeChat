"use client";

import { io, Socket } from "socket.io-client";

export const USE_GLOBAL_SOCKET = process.env.NEXT_PUBLIC_USE_GLOBAL_SOCKET == "true";

let socket: Socket | null = null;
let globalSocket: Socket | null = null;
let activeRoomId: string | null = null;
let globalActiveRoomId: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const ACK_TIMEOUT_MS = 7_000;
export { ACK_TIMEOUT_MS };
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ReplyToPayload {
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif";
  previewIv: string | null;
  previewCiphertext: string | null;
  previewAuthTag: string | null;
}

export interface OutboundEncryptedMessage {
  roomId: string;
  clientMessageId: string;       // NEW: crypto.randomUUID() — client-generated for ACK correlation
  ciphertext: string;
  iv: string;
  authTag: string;
  roomKeyVersion?: number;
  messageType?: "text" | "image" | "video" | "gif";
  replyTo?: ReplyToPayload;
}

export interface RealtimeRoomMessage {
  id: string;
  roomId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  roomKeyVersion?: number;
  messageType?: "text" | "image" | "video" | "gif";
  replyTo?: ReplyToPayload | null;
  editedAt?: string | null;
  editCount?: number;
  createdAt: string;
  senderName?: string | null;
  senderUserIndex?: number | null;
  senderPfp?: string | null;
  clientMessageId?: string;       // present in ACK only; absent in broadcasts
}

export interface TypingEventPayload {
  roomId: string;
  userId: string;
  preview?: string;
}

export interface TypingExpiredPayload {
  roomId: string;
  userId: string;
}

export interface TypingSnapshotPayload {
  roomId: string;
  users: { userId: string; preview?: string }[];
}

export interface UnreadIncrementPayload {
  roomId: string;
  unreadCount: number;
  version: number;
  senderId?: string;
  senderName?: string;
  messageType?: string;
  createdAt?: string | number;
}

export interface UnreadCountUpdatedPayload {
  roomId: string;
  unreadCount: number;
  version: number;
}

export interface KeyRotationPayload {
  roomId: string;
  version: number;
  reason: string;
  triggerUserId?: string;
}

export interface KeyRotationCompletePayload {
  roomId: string;
  version: number;
}

export interface KeyRotationFailedPayload {
  roomId: string;
  version: number;
  error: string;
}

export type ReconnectHandler = () => void;

const reconnectHandlers = new Set<ReconnectHandler>();

export function onSocketReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => reconnectHandlers.delete(handler);
}

export function startHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (socket?.connected && activeRoomId) {
      socket.emit("heartbeat", { roomId: activeRoomId });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getActiveRoomId(): string | null {
  return activeRoomId;
}

export async function connectToRoom(roomId: string): Promise<Socket> {
  const res = await fetch("/api/ws/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ roomId }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Failed to obtain WebSocket ticket");
  }

  activeRoomId = roomId;

  if (socket?.connected && (socket.io.opts as any)?.auth?.ticket === data.ticket) {
    socket.emit("join_room", { roomId });
    return socket;
  }

  if (socket) {
    socket.disconnect();
  }

  socket = io(data.wsUrl, {
    auth: { ticket: data.ticket },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 21_000,
    randomizationFactor: 0.2,
  });

  socket.io.on("reconnect", () => {
    reconnectHandlers.forEach((handler) => handler());
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);

    socket!.on("connect", () => {
      clearTimeout(timeout);
      socket!.timeout(ACK_TIMEOUT_MS).emit(
        "join_room",
        { roomId },
        (err: unknown, response: { ok: boolean; error?: string }) => {
          if (err) {
            reject(new Error("Socket request timed out"));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "Failed to join room"));
            return;
          }
          resolve(socket!);
        }
      );
    });

    socket!.on("connect_error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket!.on("disconnect", (reason) => {
      // Helpful for debugging unexpected disconnect loops.
      console.warn("[socket] disconnected:", reason);
    });
  });
}

export async function connectAsUser(): Promise<Socket> {
  const res = await fetch("/api/ws/user-ticket", {
    method: "POST",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "Failed to obtain WebSocket ticket");
  }

  activeRoomId = null;

  if (socket?.connected && (socket.io.opts as any)?.auth?.ticket === data.ticket) {
    return socket;
  }

  if (socket) socket.disconnect();

  socket = io(data.wsUrl, {
    auth: { ticket: data.ticket },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connection timed out")), 10_000);
    socket!.on("connect", () => {
      clearTimeout(timeout);
      resolve(socket!);
    });
    socket!.on("connect_error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function watchRoomMembership(roomId: string): Promise<void> {
  await emitWithAck<{ ok: boolean; error?: string }>("watch_room_membership", { roomId });
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  activeRoomId = null;
}

/** Called by ReconnectionManager to register a freshly created socket. */
export function setSocket(s: Socket): void {
  socket?.disconnect();
  socket = s;
}

function emitWithAck<T>(event: string, payload: unknown): Promise<T> {
  const target = USE_GLOBAL_SOCKET ? globalSocket : socket;
  if (!target) {
    return Promise.reject(new Error("Socket is not connected"));
  }

  return new Promise((resolve, reject) => {
    target.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err: unknown, response: T) => {
      if (err) {
        reject(new Error("Socket request timed out"));
        return;
      }
      resolve(response);
    });
  });
}

// ── Global-socket variants (for Phase 2 migration) ──

function emitWithGlobalAck<T>(event: string, payload: unknown): Promise<T> {
  if (!globalSocket) {
    return Promise.reject(new Error("Global socket is not connected"));
  }
  return new Promise((resolve, reject) => {
    globalSocket!.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err: unknown, response: T) => {
      if (err) {
        reject(new Error("Socket request timed out"));
        return;
      }
      resolve(response);
    });
  });
}

export async function sendGlobalEncryptedMessage(payload: OutboundEncryptedMessage) {
  return emitWithGlobalAck<{ ok: boolean; error?: string; message?: RealtimeRoomMessage }>(
    "send_message",
    payload
  );
}

export async function syncGlobalSince(
  roomId: string,
  since: string,
  sinceId?: string
) {
  return emitWithGlobalAck<{ ok: boolean; error?: string; messages?: RealtimeRoomMessage[] }>(
    "sync_since",
    { roomId, since, sinceId }
  );
}

export interface SyncRoomCachePayload {
  roomId: string;
  newestCachedMessageId?: string;
  newestCachedCreatedAt?: string;
  mutationVersion: number;
  cacheVersion: number;
  cachedMessageIds: string[];
}

export interface MutationPatch {
  edits: RealtimeRoomMessage[];
  deletes: { messageId: string }[];
}

export interface SyncRoomCacheResponse {
  ok: boolean;
  error?: string;
  strategy?: "UP_TO_DATE" | "DELTA" | "REPLACE";
  messages?: RealtimeRoomMessage[];
  mutationPatches?: MutationPatch;
  serverMutationVersion?: number;
}

/**
 * WebSocket RPC that replaces the HTTP resumeSync() call in the room bootstrap.
 * Detects new messages AND edits/deletes via mutationVersion comparison.
 * Uses the global socket (must be connected before calling).
 */
export async function syncRoomCache(
  payload: SyncRoomCachePayload
): Promise<SyncRoomCacheResponse> {
  return emitWithGlobalAck<SyncRoomCacheResponse>("sync_room_cache", payload);
}


export async function emitTyping(roomId: string, preview?: string) {
  return emitWithAck<{ ok: boolean; error?: string }>("typing", { roomId, preview });
}

export async function emitGlobalTyping(roomId: string, preview?: string) {
  return emitWithGlobalAck<{ ok: boolean; error?: string }>("typing", { roomId, preview });
}

/** @deprecated Use emitTyping instead. Kept for backward compat — delegates to typing event. */
export async function emitTypingStart(roomId: string, preview?: string) {
  return emitWithAck<{ ok: boolean; error?: string }>("typing", { roomId, preview });
}

/** @deprecated No-op — typing lease expiry handles stopping. Kept for backward compat. */
export async function emitTypingStop(_roomId: string) {
  return Promise.resolve({ ok: true });
}

/** @deprecated Use emitGlobalTyping instead. */
export async function emitGlobalTypingStart(roomId: string, preview?: string) {
  return emitWithGlobalAck<{ ok: boolean; error?: string }>("typing", { roomId, preview });
}

/** @deprecated No-op — typing lease expiry handles stopping. */
export async function emitGlobalTypingStop(_roomId: string) {
  return Promise.resolve({ ok: true });
}

export async function emitMarkAsRead(roomId: string, version: number) {
  return emitWithAck<{ ok: boolean; error?: string; conflict?: boolean; unreadCount?: number; version?: number }>(
    "mark_as_read",
    { roomId, version }
  );
}

export async function emitGlobalMarkAsRead(roomId: string, version: number) {
  return emitWithGlobalAck<{ ok: boolean; error?: string; conflict?: boolean; unreadCount?: number; version?: number }>(
    "mark_as_read",
    { roomId, version }
  );
}

export async function editGlobalEncryptedMessage(payload: OutboundEditMessage) {
  return emitWithGlobalAck<{ ok: boolean; error?: string; message?: RealtimeRoomMessage }>(
    "edit_message",
    payload
  );
}

export async function deleteGlobalEncryptedMessage(payload: OutboundDeleteMessage) {
  return emitWithGlobalAck<{ ok: boolean; error?: string }>("delete_message", payload);
}

export async function sendEncryptedMessage(payload: OutboundEncryptedMessage) {
  return emitWithAck<{ ok: boolean; error?: string; message?: RealtimeRoomMessage }>(
    "send_message",
    payload
  );
}

export async function syncSince(
  roomId: string,
  since: string,
  sinceId?: string
) {
  return emitWithAck<{ ok: boolean; error?: string; messages?: RealtimeRoomMessage[] }>(
    "sync_since",
    { roomId, since, sinceId }
  );
}

export interface OutboundEditMessage {
  roomId: string;
  messageId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface OutboundDeleteMessage {
  roomId: string;
  messageId: string;
}

export async function editEncryptedMessage(payload: OutboundEditMessage) {
  return emitWithAck<{ ok: boolean; error?: string; message?: RealtimeRoomMessage }>(
    "edit_message",
    payload
  );
}

export async function deleteEncryptedMessage(payload: OutboundDeleteMessage) {
  return emitWithAck<{ ok: boolean; error?: string }>("delete_message", payload);
}

// ── Global Socket (feature-flagged) ──────────────────────────────────

export function getGlobalSocket(): Socket | null {
  return globalSocket;
}

export function setGlobalSocket(s: Socket): void {
  globalSocket?.disconnect();
  globalSocket = s;
}

export function setGlobalActiveRoomId(roomId: string | null): void {
  globalActiveRoomId = roomId;
}

export function startGlobalHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (globalSocket?.connected) {
      globalSocket.emit("heartbeat", { activeRoomId: globalActiveRoomId });
    }
  }, HEARTBEAT_INTERVAL_MS);
}
