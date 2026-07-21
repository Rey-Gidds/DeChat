import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import {
  assertCanJoinRoom,
  getMembership,
} from "@/lib/membership-db";

const JoinByLinkSchema = z.object({
  roomLink: z.string().min(8).max(32),
});

export async function POST(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const body = await req.json();
  const parsed = JoinByLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const room = await db.collection("rooms").findOne({
    roomLink: parsed.data.roomLink,
    isActive: true,
  });

  if (!room) {
    return NextResponse.json({ error: "Invalid invite link" }, { status: 404 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const roomId = room._id as ObjectId;

  if (room.isDisabled) {
    return NextResponse.json(
      { error: "This room has been disabled by its owner." },
      { status: 409 }
    );
  }

  const canJoin = await assertCanJoinRoom(roomId, userId);
  if (!canJoin.ok) {
    return NextResponse.json({ error: canJoin.message }, { status: canJoin.status });
  }

  const existing = await getMembership(roomId, userId);
  if (existing?.status === "REJECTED" || existing?.status === "LEFT") {
    await db.collection("room_memberships").deleteOne({ _id: existing._id });
  }

  const now = new Date();

  const membershipDoc = {
    _id: new ObjectId(),
    userId,
    roomId,
    status: "PENDING" as const,
    lastVisitedAt: now,
    role: "MEMBER" as const,
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
