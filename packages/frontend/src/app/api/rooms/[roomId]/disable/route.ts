import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

async function notifyRoomMetadata(roomId: string, payload: Record<string, unknown>) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${wsUrl}/internal/room-metadata-updated`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

async function notifyMembershipUpdate(userId: string, roomId: string, payload: Record<string, unknown>) {
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
    body: JSON.stringify({ userId, roomId, ...payload }),
  }).catch(() => undefined);
}

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);

  if (!membership || membership.role !== "OWNER" || membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Only the room owner can toggle this setting" }, { status: 403 });
  }

  const room = await db.collection("rooms").findOne({ _id: roomId });
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const currentlyDisabled = Boolean(room.isDisabled);
  const now = new Date();

  if (!currentlyDisabled) {
    // Disabling: clean pending requests, notify those users, set isDisabled
    const pendingRequests = await db
      .collection("room_memberships")
      .find({ roomId, status: "PENDING" })
      .project({ userId: 1 })
      .toArray();

    await db.collection("room_memberships").deleteMany({ roomId, status: "PENDING" });

    await db.collection("rooms").updateOne(
      { _id: roomId },
      { $set: { isDisabled: true, updatedAt: now } }
    );

    // Notify subscribers via WS that room is now disabled
    void notifyRoomMetadata(roomId.toString(), { roomId: roomId.toString(), isDisabled: true });

    // Notify all pending users that their request was rejected due to room being disabled
    for (const pending of pendingRequests) {
      void notifyMembershipUpdate(
        pending.userId.toString(),
        roomId.toString(),
        { status: "REJECTED" }
      ).catch(() => undefined);
    }
  } else {
    // Re-enabling: set isDisabled to false
    await db.collection("rooms").updateOne(
      { _id: roomId },
      { $set: { isDisabled: false, updatedAt: now } }
    );

    // Notify subscribers via WS that room is now enabled
    void notifyRoomMetadata(roomId.toString(), { roomId: roomId.toString(), isDisabled: false });
  }

  return NextResponse.json({
    room: {
      id: roomId.toString(),
      isDisabled: !currentlyDisabled,
    },
  });
}
