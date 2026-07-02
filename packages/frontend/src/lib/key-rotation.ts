import {
  generateRoomKey,
  wrapRoomKeyForPublicKey,
  storeRoomKeyVersion,
  importPublicKey,
  getRoomKeyVersion,
} from "@/lib/crypto";

export interface RoomKeyRotationState {
  pendingKeyRotation: boolean;
  lastKeyVersion: number;
  currentKeyVersion: number;
}

export async function claimRotationLock(
  roomId: string,
  version: number
): Promise<boolean> {
  const res = await fetch(`/api/rooms/${roomId}/key-rotation/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ version }),
  });

  const data = await res.json();
  return data.lockAcquired === true;
}

export async function releaseRotationLock(
  roomId: string,
  version: number
): Promise<void> {
  await fetch(`/api/rooms/${roomId}/key-rotation/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ version }),
  }).catch(() => undefined);
}

export async function completeRotation(
  roomId: string,
  version: number,
  distributions: Array<{ userId: string; encryptedKey: string }>
): Promise<void> {
  const res = await fetch(`/api/rooms/${roomId}/key-rotation/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ version, distributions }),
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Rotation complete failed");
  }
}

export async function syncKeyVersion(
  roomId: string,
  keyVersion: number
): Promise<void> {
  await fetch(`/api/rooms/${roomId}/membership/sync-key-version`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ keyVersion }),
  }).catch(() => undefined);
}

export async function fetchMyKeyDistributions(
  roomId: string
): Promise<Array<{ keyVersion: number; encryptedKey: string }>> {
  const res = await fetch(`/api/rooms/${roomId}/my-key-distribution`, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch key distributions");
  }

  const data = await res.json();
  return data.distributions;
}

export async function generateAndDistributeNewKey(
  roomId: string,
  remainingMembers: Array<{ userId: string; publicKey: string }>
): Promise<Array<{ userId: string; encryptedKey: string }>> {
  const newKey = await generateRoomKey();

  const distributions: Array<{ userId: string; encryptedKey: string }> = [];

  for (const member of remainingMembers) {
    const publicKey = await importPublicKey(member.publicKey);
    const encryptedKey = await wrapRoomKeyForPublicKey(newKey, publicKey);
    distributions.push({
      userId: member.userId,
      encryptedKey,
    });
  }

  await storeRoomKeyVersion(roomId, 0, newKey);

  return distributions;
}