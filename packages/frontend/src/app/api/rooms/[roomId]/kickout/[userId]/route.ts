import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership, isRoomAdmin } from "@/lib/membership-db";

type RouteContext = {
  params: Promise<{ roomId: string; userId: string }>;
};

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
    console.error("[kickout] Failed to notify websocket server:", err);
  });
}

async function notifyMembershipUpdate(userId: string, roomId: string, status: string) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${wsUrl}/internal/membership-updated`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ userId, roomId, status }),
  }).catch((err) => {
    console.error("[kickout] Failed to notify websocket server:", err);
  });
}

export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam, userId: targetUserParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  const targetUserId = parseObjectId(targetUserParam);

  if (!roomId || !targetUserId) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const adminId = new ObjectId(authResult.session.user.id);
  const admin = await isRoomAdmin(roomId, adminId);
  if (!admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Cannot kick yourself
  if (adminId.equals(targetUserId)) {
    return NextResponse.json({ error: "Cannot kick yourself" }, { status: 400 });
  }

  const targetMembership = await getMembership(roomId, targetUserId);
  if (!targetMembership) {
    return NextResponse.json({ error: "User is not a member of this room" }, { status: 404 });
  }

  if (targetMembership.status !== "APPROVED") {
    return NextResponse.json({ error: "User is not an approved member" }, { status: 400 });
  }

  // Cannot kick another OWNER
  if (targetMembership.role === "OWNER") {
    return NextResponse.json({ error: "Cannot kick the room owner" }, { status: 403 });
  }

  const now = new Date();

  // 1. Update target membership: set LEFT, increment kickoutCount
  await db.collection("room_memberships").updateOne(
    { _id: targetMembership._id },
    {
      $set: {
        status: "LEFT",
        leftAt: now,
        updatedAt: now,
      },
      $inc: { kickoutCount: 1 },
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
      reason: "MEMBER_KICKED",
      triggerUserId: targetUserId,
      status: "GENERATING",
    });

    await notifyKeyRotationPending(
      roomId.toString(),
      newVersion,
      "MEMBER_KICKED",
      targetUserId.toString()
    );
  }

  // 5. Notify the kicked user
  await notifyMembershipUpdate(targetUserId.toString(), roomId.toString(), "KICKED");

  return NextResponse.json({ ok: true });
}
