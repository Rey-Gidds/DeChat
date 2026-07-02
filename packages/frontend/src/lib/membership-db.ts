import { ObjectId, type WithId } from "mongodb";
import { db } from "./auth";
import type { MembershipStatus, RoomMembership } from "./models";
import {
  getCachedRoomKickoutCount,
  invalidateKickoutCache,
  invalidateUserKickoutCache,
  incrementKickoutCache,
  MAX_KICKOUTS,
} from "./kickout-cache";

export type MembershipDoc = WithId<RoomMembership>;

export {
  invalidateKickoutCache,
  invalidateUserKickoutCache,
  incrementKickoutCache,
  MAX_KICKOUTS,
};

export async function getMembership(
  roomId: ObjectId,
  userId: ObjectId
): Promise<MembershipDoc | null> {
  return db
    .collection<RoomMembership>("room_memberships")
    .findOne({ roomId, userId }) as Promise<MembershipDoc | null>;
}

export async function countActiveMembers(roomId: ObjectId): Promise<number> {
  return db.collection("room_memberships").countDocuments({
    roomId,
    status: "APPROVED",
    isBlocked: false,
  });
}

export async function isRoomAdmin(
  roomId: ObjectId,
  userId: ObjectId
): Promise<boolean> {
  const membership = await getMembership(roomId, userId);
  return (
    (membership?.role === "OWNER" || membership?.role === "ADMIN") &&
    membership.status === "APPROVED" &&
    !membership.isBlocked
  );
}

async function getRoomKickoutCountFromDb(
  roomId: ObjectId,
  userId: ObjectId
): Promise<number> {
  const membership = await db
    .collection<RoomMembership>("room_memberships")
    .findOne({ roomId, userId }, { projection: { kickoutCount: 1 } });
  return membership?.kickoutCount ?? 0;
}

async function getUserKickoutRowsFromDb(userId: ObjectId) {
  return db
    .collection<RoomMembership>("room_memberships")
    .find({ userId, kickoutCount: { $gt: 0 } })
    .project({ roomId: 1, kickoutCount: 1 })
    .toArray();
}

/** Kickout count for a single user–room membership. */
export async function getRoomKickoutCount(
  roomId: ObjectId,
  userId: ObjectId
): Promise<number> {
  return getCachedRoomKickoutCount(userId, roomId, () =>
    getRoomKickoutCountFromDb(roomId, userId)
  );
}


export async function assertCanJoinRoom(
  roomId: ObjectId,
  userId: ObjectId
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const room = await db.collection("rooms").findOne({ _id: roomId, isActive: true });
  if (!room) {
    return { ok: false, status: 404, message: "Room not found" };
  }

  if (room.isDisabled) {
    return { ok: false, status: 409, message: "This room has been disabled by its owner." };
  }

  const existing = await getMembership(roomId, userId);
  if (existing) {
    if (existing.status === "APPROVED") {
      return { ok: false, status: 409, message: "Already a member of this room" };
    }
    if (existing.status === "PENDING") {
      return { ok: false, status: 409, message: "Join request already pending" };
    }
    if (existing.isBlocked) {
      return { ok: false, status: 403, message: "You are blocked from this room" };
    }
  }

  const roomKickouts = await getRoomKickoutCount(roomId, userId);
  if (roomKickouts >= MAX_KICKOUTS) {
    return {
      ok: false,
      status: 403,
      message: "You are restricted from joining this room due to repeated removals",
    };
  }

  // Phase 1 note: we still fall back to `capacity` if the room hasn't been migrated to `maxMembers` yet.
  const maxMembers =
    typeof room.maxMembers === "number"
      ? room.maxMembers
      : typeof room.capacity === "number"
        ? room.capacity
        : 500;

  const activeCount = await countActiveMembers(roomId);
  if (activeCount >= maxMembers) {
    return { ok: false, status: 409, message: "Room is at capacity" };
  }

  return { ok: true };
}

export async function listPendingRequests(
  roomId: ObjectId
): Promise<MembershipDoc[]> {
  return db
    .collection<RoomMembership>("room_memberships")
    .find({ roomId, status: "PENDING" as MembershipStatus })
    .sort({ createdAt: 1 })
    .toArray() as Promise<MembershipDoc[]>;
}

export async function getUserPublicKey(userId: ObjectId): Promise<string | null> {
  const user = await db.collection("user").findOne(
    { _id: userId },
    { projection: { publicKey: 1, name: 1, email: 1 } }
  );
  if (!user?.publicKey) return null;
  return user.publicKey as string;
}

export type EnrichedMembership = MembershipDoc & {
  user: {
    name?: string;
    email?: string;
    publicKey?: string;
    image?: string;
  } | null;
};

export async function enrichMembershipUsers(
  memberships: MembershipDoc[]
): Promise<EnrichedMembership[]> {
  if (memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.userId);
  const users = await db
    .collection("user")
    .find({ _id: { $in: userIds } })
    .project({ name: 1, email: 1, publicKey: 1, image: 1 })
    .toArray();

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  return memberships.map((m) => ({
    ...m,
    user: (userMap.get(m.userId.toString()) as EnrichedMembership["user"]) ?? null,
  }));
}
