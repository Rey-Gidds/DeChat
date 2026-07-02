import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import {
  parseObjectId,
  UploadWrappedRoomKeySchema,
} from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 404 });
  }

  return NextResponse.json({
    membership: {
      ...membership,
      id: membership._id.toString(),
      userId: membership.userId.toString(),
      roomId: membership.roomId.toString(),
    },
  });
}

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const body = await req.json();
  const parsed = UploadWrappedRoomKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 404 });
  }

  if ((membership.role !== "OWNER" && membership.role !== "ADMIN") || membership.status !== "APPROVED") {
    return NextResponse.json(
      { error: "Only active room admins can upload wrapped room keys" },
      { status: 403 }
    );
  }

  // Upsert a room_key_distribution entry for the current version
  const now = new Date();
  const room = await db.collection("rooms").findOne({ _id: roomId }, { projection: { lastKeyVersion: 1 } });
  const currentKeyVersion = room?.lastKeyVersion ?? 0;

  await db.collection("room_key_distribution").updateOne(
    { roomId, keyVersion: currentKeyVersion, userId },
    {
      $set: {
        encryptedKey: parsed.data.encryptedRoomKey,
        distributedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
      },
    },
    { upsert: true }
  );

  const updated = await getMembership(roomId, userId);
  if (!updated) return NextResponse.json({ error: "Membership lost" }, { status: 500 });

  return NextResponse.json({
    membership: {
      ...updated,
      id: updated._id.toString(),
      userId: updated.userId.toString(),
      roomId: updated.roomId.toString(),
    }
  });
}
