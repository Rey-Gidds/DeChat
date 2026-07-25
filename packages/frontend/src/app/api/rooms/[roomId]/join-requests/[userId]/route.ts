import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { ensureMongoConnected } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import {
  ApproveJoinRequestSchema,
  parseObjectId,
} from "@/lib/models";
import {
  countActiveMembers,
  getMembership,
  getUserPublicKey,
  isRoomAdmin,
} from "@/lib/membership-db";

type RouteContext = {
  params: Promise<{ roomId: string; userId: string }>;
};

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
    console.error("[membership-updated] Failed to notify websocket server:", err);
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

  const body = await req.json();
  const parsed = ApproveJoinRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const publicKey = await getUserPublicKey(targetUserId);
  if (!publicKey) {
    return NextResponse.json(
      { error: "User has no encryption public key registered" },
      { status: 422 }
    );
  }

  const client = await ensureMongoConnected();
  const session = client.startSession();

  let approvedMembershipId: ObjectId | null = null;
  let rejectedDueToCapacity = false;

  try {
    const now = new Date();

    await session.withTransaction(async () => {
      const roomsCol = db.collection("rooms");
      const membershipsCol = db.collection("room_memberships");

      const room = await roomsCol.findOne({ _id: roomId, isActive: true }, { session });
      if (!room) {
        throw Object.assign(new Error("Room not found"), { status: 404 });
      }
      if (room.isDisabled) {
        throw Object.assign(new Error("This room has been disabled by its owner."), { status: 409 });
      }

      const currentKeyVersion = room.lastKeyVersion ?? 0;

      // On-demand normalization (no backfill scripts): ensure these fields exist for atomic capacity/indexing.
      const derivedMaxMembers =
        typeof room.maxMembers === "number"
          ? room.maxMembers
          : typeof (room as any).capacity === "number"
            ? (room as any).capacity
            : 500;

      let memberCount =
        typeof room.memberCount === "number" ? room.memberCount : await countActiveMembers(roomId);
      let nextUserIndex =
        typeof room.nextUserIndex === "number" && room.nextUserIndex > 0 ? room.nextUserIndex : 1;

      if (
        typeof room.maxMembers !== "number" ||
        typeof room.memberCount !== "number" ||
        typeof room.nextUserIndex !== "number"
      ) {
        await roomsCol.updateOne(
          { _id: roomId },
          {
            $set: {
              maxMembers: derivedMaxMembers,
              memberCount,
              nextUserIndex,
            },
          },
          { session }
        );
      }

      // Atomically claim the request (first reviewer wins).
      const claimed = await membershipsCol.findOneAndUpdate(
        {
          roomId,
          userId: targetUserId,
          status: "PENDING",
          reviewedAt: null,
        },
        {
          $set: {
            reviewedBy: adminId,
            reviewedAt: now,
            updatedAt: now,
          },
        },
        { session, returnDocument: "after" }
      );

      if (!claimed) {
        throw Object.assign(new Error("This join request has already been reviewed."), { status: 409 });
      }

      if (claimed.isBlocked) {
        throw Object.assign(new Error("User is blocked"), { status: 403 });
      }

      // Capacity reservation (atomic).
      const capacityRes = await roomsCol.updateOne(
        {
          _id: roomId,
          isActive: true,
          isDisabled: { $ne: true },
          memberCount: { $lt: derivedMaxMembers },
        },
        { $inc: { memberCount: 1 } },
        { session }
      );

      if (capacityRes.matchedCount !== 1) {
        rejectedDueToCapacity = true;
        await membershipsCol.updateOne(
          { _id: claimed._id },
          {
            $set: {
              status: "REJECTED",
              updatedAt: now,
            },
          },
          { session }
        );
        return;
      }

      // Allocate per-room sequential index.
      const indexDoc = await roomsCol.findOneAndUpdate(
        { _id: roomId },
        { $inc: { nextUserIndex: 1 } },
        { session, returnDocument: "before", projection: { nextUserIndex: 1 } }
      );

      const assignedIndex =
        typeof indexDoc?.nextUserIndex === "number" ? indexDoc.nextUserIndex : 1;

      await membershipsCol.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: "APPROVED",
            joinedAt: now,
            lastVisitedAt: now,
            updatedAt: now,
            userIndex: assignedIndex,
            currentKeyVersion,
          },
        },
        { session }
      );

      // Create room_key_distribution entry for the new joiner
      await db.collection("room_key_distribution").insertOne(
        {
          _id: new ObjectId(),
          roomId,
          keyVersion: currentKeyVersion,
          userId: targetUserId,
          encryptedKey: parsed.data.encryptedRoomKey,
          distributedAt: now,
        },
        { session }
      );

      approvedMembershipId = claimed._id as ObjectId;
    });
  } finally {
    await session.endSession().catch(() => undefined);
  }

  if (rejectedDueToCapacity) {
    await notifyMembershipUpdate(targetUserId.toString(), roomId.toString(), {
      status: "REJECTED",
    });
    return NextResponse.json(
      { error: "This room has reached its member limit." },
      { status: 409 }
    );
  }

  if (!approvedMembershipId) {
    return NextResponse.json({ error: "Approval failed" }, { status: 500 });
  }

  const updated = await getMembership(roomId, targetUserId);
  if (!updated) return NextResponse.json({ error: "Membership lost" }, { status: 500 });

  // Fetch user info and room info for full notification payload
  const [approvedUser, roomInfo] = await Promise.all([
    db.collection("user").findOne({ _id: targetUserId }, { projection: { name: 1, email: 1, pfp: 1 } }),
    db.collection("rooms").findOne({ _id: roomId }, { projection: { name: 1 } }),
  ]);
  const currentCount = await db.collection("room_memberships").countDocuments({
    roomId, status: "APPROVED", isBlocked: false,
  });

  await notifyMembershipUpdate(targetUserId.toString(), roomId.toString(), {
    status: "APPROVED",
    role: "MEMBER",
    userIndex: (updated as any)?.userIndex ?? null,
    userName: approvedUser?.name || approvedUser?.email || "",
    userPfp: (approvedUser?.pfp as string) ?? null,
    roomName: roomInfo?.name ?? "",
    memberCount: currentCount,
  });

  return NextResponse.json({
    membership: {
      ...updated,
      id: updated._id.toString(),
      userId: updated.userId.toString(),
      roomId: updated.roomId.toString(),
    },
  });
}

export async function DELETE(req: Request, context: RouteContext) {
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

  const pendingMembership = await getMembership(roomId, targetUserId);
  if (!pendingMembership || pendingMembership.status !== "PENDING") {
    return NextResponse.json({ error: "No pending join request" }, { status: 404 });
  }

  const now = new Date();
  const result = await db.collection("room_memberships").findOneAndUpdate(
    { _id: pendingMembership._id, status: "PENDING", reviewedAt: null },
    {
      $set: {
        status: "REJECTED",
        reviewedBy: adminId,
        reviewedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (!result?.value) {
    return NextResponse.json(
      { error: "This join request has already been reviewed." },
      { status: 409 }
    );
  }

  await notifyMembershipUpdate(
    targetUserId.toString(),
    roomId.toString(),
    { status: "REJECTED" }
  );

  return NextResponse.json({ success: true });
}
