import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import {
  assertCanJoinRoom,
  getMembership,
} from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const room = await db.collection("rooms").findOne({ _id: roomId, isActive: true });
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  if (room.isDisabled) {
    return NextResponse.json(
      { error: "This room has been disabled by its owner." },
      { status: 409 }
    );
  }

  const userId = new ObjectId(authResult.session.user.id);
  const canJoin = await assertCanJoinRoom(roomId, userId);
  if (!canJoin.ok) {
    return NextResponse.json({ error: canJoin.message }, { status: canJoin.status });
  }

  // If the user was rejected or left, delete the membership for that user in the given room.
  await Promise.resolve().then(async () => {
  const existing = await getMembership(roomId, userId);
  if (existing?.status === "REJECTED" || existing?.status === "LEFT") {
    await db.collection("room_memberships").deleteOne({ _id: existing._id });
  }
  }).catch((error) => {
    console.error("Error deleting membership:", error);
  });

  const now = new Date();

  const joinPolicy = room.joinPolicy ?? "PUBLIC";
  if (joinPolicy === "PRIVATE") {
    return NextResponse.json({ error: "This room is invite-only." }, { status: 403 });
  }

  // All rooms now require approval — always create PENDING membership
  const desiredStatus = "PENDING";

  const membershipDoc = {
    _id: new ObjectId(),
    userId,
    roomId,
    status: desiredStatus,
    lastVisitedAt: now,
    role: "MEMBER",
    userIndex: null,
    reviewedBy: null,
    reviewedAt: null,
    isBlocked: false,
    kickoutCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("room_memberships").insertOne(membershipDoc);

  return NextResponse.json(
    {
      membership: {
        ...membershipDoc,
        id: membershipDoc._id.toString(),
        userId: membershipDoc.userId.toString(),
        roomId: membershipDoc.roomId.toString(),
      },
      room: {
        ...room,
        id: room._id.toString(),
      },
    },
    { status: 201 }
  );
}
