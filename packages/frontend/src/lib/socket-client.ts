"use client";

import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;
let activeRoomId: string | null = null;
const ACK_TIMEOUT_MS = 7_000;

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
  createdAt: string;
  senderName?: string | null;
  senderUserIndex?: number | null;
  clientMessageId?: string;       // present in ACK only; absent in broadcasts
}

export interface TypingEventPayload {
  roomId: string;
  userId: string;
  preview?: string;
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
  });

  socket.io.on("reconnect", () => {
    if (activeRoomId) {
      socket?.emit("join_room", { roomId: activeRoomId });
    }
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

function emitWithAck<T>(event: string, payload: unknown): Promise<T> {
  if (!socket) {
    return Promise.reject(new Error("Socket is not connected"));
  }

  return new Promise((resolve, reject) => {
    socket!.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err: unknown, response: T) => {
      if (err) {
        reject(new Error("Socket request timed out"));
        return;
      }
      resolve(response);
    });
  });
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

export async function emitTypingStart(roomId: string, preview?: string) {
  return emitWithAck<{ ok: boolean; error?: string }>("typing_start", { roomId, preview });
}

export async function emitTypingStop(roomId: string) {
  return emitWithAck<{ ok: boolean; error?: string }>("typing_stop", { roomId });
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
