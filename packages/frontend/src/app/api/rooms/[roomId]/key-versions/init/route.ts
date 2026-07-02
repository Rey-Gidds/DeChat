import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { ensureMongoConnected } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId, InitKeyVersionSchema } from "@/lib/models";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);

  const body = await req.json();
  const parsed = InitKeyVersionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  // Verify user is the room creator
  const room = await db.collection("rooms").findOne({ _id: roomId, isActive: true });
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  if (!room.creatorId.equals(userId)) {
    return NextResponse.json({ error: "Only the room creator can initialize key versions" }, { status: 403 });
  }

  const client = await ensureMongoConnected();
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      // 1. Create version 0
      await db.collection("room_key_versions").insertOne(
        {
          _id: new ObjectId(),
          roomId,
          version: 0,
          createdBy: userId,
          createdAt: new Date(),
          reason: "CREATED",
          status: "ACTIVE",
        },
        { session }
      );

      // 2. Create distribution entry for creator
      await db.collection("room_key_distribution").insertOne(
        {
          _id: new ObjectId(),
          roomId,
          keyVersion: 0,
          userId,
          encryptedKey: parsed.data.encryptedKey,
          distributedAt: new Date(),
        },
        { session }
      );

      // 3. Update room
      await db.collection("rooms").updateOne(
        { _id: roomId },
        {
          $set: {
            lastKeyVersion: 0,
            pendingKeyRotation: false,
          },
        },
        { session }
      );

      // 4. Update creator's membership
      await db.collection("room_memberships").updateOne(
        { roomId, userId },
        {
          $set: {
            currentKeyVersion: 0,
          },
        },
        { session }
      );
    });
  } finally {
    await session.endSession().catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}
