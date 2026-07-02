/**
 * Client-side helpers for Phase 4 membership + E2EE key exchange flows.
 */

import {
  setupCreatorRoomKey,
  wrapRoomKeyForMember,
  storeRoomKeyVersion,
  unwrapRoomKey,
  getPrivateKey,
} from "./crypto";
import { fetchMyKeyDistributions } from "./key-rotation";

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : data?.message || "Request failed";
    throw new Error(message);
  }
  return data as T;
}

/** After POST /api/rooms — generate, wrap, and upload the admin's room key. */
export async function finalizeCreatorRoomKey(
  roomId: string,
  userId: string,
  publicKeyBase64: string
): Promise<void> {
  const encryptedRoomKey = await setupCreatorRoomKey(
    roomId,
    userId,
    publicKeyBase64
  );

  // Upload to room_key_distribution via the membership PATCH endpoint
  const res = await fetch(`/api/rooms/${roomId}/membership`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ encryptedRoomKey }),
  });

  await parseJson(res);
}

/** Approved member unlocks their wrapped room key by fetching distributions. */
export async function syncMemberRoomKey(
  roomId: string,
  userId: string
): Promise<void> {
  const distributions = await fetchMyKeyDistributions(roomId);
  if (distributions.length === 0) {
    throw new Error("Room key not available yet. Wait for admin approval.");
  }

  const privateKey = await getPrivateKey(userId);
  if (!privateKey) {
    throw new Error("Private key not found. Restore from your recovery kit.");
  }

  for (const dist of distributions) {
    const aesKey = await unwrapRoomKey(dist.encryptedKey, privateKey);
    await storeRoomKeyVersion(roomId, dist.keyVersion, aesKey);
  }
}

/** Admin approves a pending user with a client-wrapped room key. */
export async function approveJoinRequest(
  roomId: string,
  targetUserId: string,
  memberPublicKeyBase64: string
): Promise<void> {
  const encryptedRoomKey = await wrapRoomKeyForMember(
    roomId,
    memberPublicKeyBase64
  );

  const res = await fetch(
    `/api/rooms/${roomId}/join-requests/${targetUserId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ encryptedRoomKey }),
    }
  );

  await parseJson(res);
}

export async function requestJoinRoom(roomId: string) {
  const res = await fetch(`/api/rooms/${roomId}/join`, {
    method: "POST",
    credentials: "include",
  });
  return parseJson(res);
}

export async function requestJoinByLink(roomLink: string) {
  const res = await fetch("/api/rooms/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ roomLink }),
  });
  return parseJson(res);
}
