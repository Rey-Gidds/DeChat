import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

async function notifyKeyRotationPending(
  roomId: string,
  version: number,
  reason: string,
  triggerUserId?: string
) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${wsUrl}/internal/key-rotation-pending`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ roomId, version, reason, triggerUserId }),
  }).catch((err) => {
    console.error("[leave] Failed to notify websocket server:", err);
  });
}

export async function POST(req: Request, context: RouteContext) {
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

  if (membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Only approved members can leave" }, { status: 400 });
  }

  if (membership.role === "OWNER") {
    return NextResponse.json(
      { error: "Room owners cannot leave. Transfer ownership or delete the room first." },
      { status: 400 }
    );
  }

  const now = new Date();

  // 1. Update membership: set LEFT
  await db.collection("room_memberships").updateOne(
    { _id: membership._id },
    {
      $set: {
        status: "LEFT",
        leftAt: now,
        updatedAt: now,
      },
    }
  );

  // 2. Decrement memberCount
  await db.collection("rooms").updateOne(
    { _id: roomId },
    { $inc: { memberCount: -1 } }
  );

  // 3. Check remaining members
  const remainingCount = await db
    .collection("room_memberships")
    .countDocuments({ roomId, status: "APPROVED", isBlocked: false });

  // 4. If members remain, trigger key rotation
  if (remainingCount > 0) {
    // Get current lastKeyVersion
    const room = await db.collection("rooms").findOne(
      { _id: roomId },
      { projection: { lastKeyVersion: 1 } }
    );
    const currentVersion = room?.lastKeyVersion ?? 0;
    const newVersion = currentVersion + 1;

    await db.collection("rooms").updateOne(
      { _id: roomId },
      { $set: { pendingKeyRotation: true } }
    );

    await db.collection("room_key_versions").insertOne({
      _id: new ObjectId(),
      roomId,
      version: newVersion,
      createdBy: null,
      createdAt: now,
      reason: "MEMBER_LEFT",
      triggerUserId: userId,
      status: "GENERATING",
    });

    await notifyKeyRotationPending(
      roomId.toString(),
      newVersion,
      "MEMBER_LEFT",
      userId.toString()
    );
  }

  return NextResponse.json({ ok: true });
}
