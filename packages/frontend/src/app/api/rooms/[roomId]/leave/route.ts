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
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify({ roomId, version, reason, triggerUserId }),
  }).catch((err) => {
    console.error("[leave] Failed to notify websocket server:", err);
  });
}

async function notifyMembershipUpdate(
  userId: string,
  roomId: string,
  payload: Record<string, unknown>
) {
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
  }).catch((err) => {
    console.error("[leave] Failed to notify websocket membership update:", err);
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
      { error: "Room owners cannot leave. Transfer ownership first." },
      { status: 400 }
    );
  }

  // Parse optional succession payload (only relevant when caller is ADMIN)
  let promoteToAdmin: string[] = [];
  let makeEveryoneAdmin = false;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body.promoteToAdmin)) {
      promoteToAdmin = body.promoteToAdmin.filter((id: unknown) => typeof id === "string");
    }
    if (typeof body.makeEveryoneAdmin === "boolean") {
      makeEveryoneAdmin = body.makeEveryoneAdmin;
    }
  } catch {
    // body is optional — proceed without it
  }

  // Count active admins (OWNER or ADMIN) excluding the leaving user
  const otherAdminCount = await db.collection("room_memberships").countDocuments({
    roomId,
    userId: { $ne: userId },
    status: "APPROVED",
    isBlocked: false,
    role: { $in: ["OWNER", "ADMIN"] },
  });

  const isSoleAdmin = membership.role === "ADMIN" && otherAdminCount === 0;

  if (isSoleAdmin) {
    // Count other remaining approved members (who could be promoted)
    const otherMemberCount = await db.collection("room_memberships").countDocuments({
      roomId,
      userId: { $ne: userId },
      status: "APPROVED",
      isBlocked: false,
    });

    if (otherMemberCount > 0) {
      // Must nominate successors
      if (!makeEveryoneAdmin && promoteToAdmin.length === 0) {
        // Return the current member list so the client can render the picker
        const members = await db
          .collection("room_memberships")
          .find({ roomId, userId: { $ne: userId }, status: "APPROVED", isBlocked: false })
          .toArray();
        return NextResponse.json(
          {
            error: "succession_required",
            members: members.map((m) => ({
              userId: m.userId.toString(),
              role: m.role,
            })),
          },
          { status: 400 }
        );
      }

      const now = new Date();

      if (makeEveryoneAdmin) {
        await db.collection("room_memberships").updateMany(
          { roomId, userId: { $ne: userId }, status: "APPROVED", isBlocked: false, role: "MEMBER" },
          { $set: { role: "ADMIN", updatedAt: now } }
        );
      } else {
        // Validate that all provided userIds are actual approved members
        const targetIds = promoteToAdmin.map((id) => new ObjectId(id));
        const validCount = await db.collection("room_memberships").countDocuments({
          roomId,
          userId: { $in: targetIds },
          status: "APPROVED",
          isBlocked: false,
        });
        if (validCount !== targetIds.length) {
          return NextResponse.json(
            { error: "One or more selected members are not valid active members" },
            { status: 400 }
          );
        }
        await db.collection("room_memberships").updateMany(
          { roomId, userId: { $in: targetIds }, status: "APPROVED", role: "MEMBER" },
          { $set: { role: "ADMIN", updatedAt: now } }
        );
      }
    }
    // If otherMemberCount === 0 — last person leaves, fall through to normal leave logic
  }

  const now = new Date();

  await db.collection("room_memberships").updateOne(
    { _id: membership._id },
    { $set: { status: "LEFT", leftAt: now, updatedAt: now, role: "MEMBER" } }
  );

  await db.collection("rooms").updateOne({ _id: roomId }, { $inc: { memberCount: -1 } });

  const remainingCount = await db
    .collection("room_memberships")
    .countDocuments({ roomId, status: "APPROVED", isBlocked: false });

  if (remainingCount > 0) {
    const room = await db
      .collection("rooms")
      .findOne({ _id: roomId }, { projection: { lastKeyVersion: 1 } });
    const newVersion = (room?.lastKeyVersion ?? 0) + 1;
    await db.collection("rooms").updateOne({ _id: roomId }, { $set: { pendingKeyRotation: true } });
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
    await notifyKeyRotationPending(roomId.toString(), newVersion, "MEMBER_LEFT", userId.toString());
  } else {
    // Last person left — disable room but preserve their role in case they want to reactivate
    await db.collection("rooms").updateOne({ _id: roomId }, { $set: { isDisabled: true } });
    // Restore the preserved role so they can directly rejoin later (architecture §3.2 Case B)
    await db.collection("room_memberships").updateOne(
      { _id: membership._id },
      { $set: { role: membership.role } }
    );
  }

  // Notify the leaving user via WS (dual channel)
  const userInfo = await db.collection("user").findOne(
    { _id: userId },
    { projection: { name: 1, email: 1 } }
  );
  const roomInfo = await db.collection("rooms").findOne(
    { _id: roomId },
    { projection: { name: 1 } }
  );
  void notifyMembershipUpdate(userId.toString(), roomId.toString(), {
    status: "LEFT",
    isBlocked: false,
    userName: userInfo?.name || userInfo?.email || "",
    roomName: roomInfo?.name ?? "",
    reason: "left",
  });

  return NextResponse.json({ ok: true });
}
