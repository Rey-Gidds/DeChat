import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { isRoomAdmin, listPendingRequests } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";

async function notifyRejection(userId: string, roomId: string) {
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${WS_URL}/internal/membership-updated`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ userId, roomId, status: "REJECTED" }),
  }).catch(() => {});
}

export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const adminId = new ObjectId(authResult.session.user.id);
  const admin = await isRoomAdmin(roomId, adminId);
  if (!admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const pending = await listPendingRequests(roomId);
  if (pending.length === 0) {
    return NextResponse.json({ success: true, rejected: 0 });
  }

  const now = new Date();
  const pendingIds = pending.map((p) => p._id);
  const userIds = pending.map((p) => p.userId.toString());

  await db.collection("room_memberships").updateMany(
    { _id: { $in: pendingIds }, status: "PENDING", reviewedAt: null },
    {
      $set: {
        status: "REJECTED",
        reviewedBy: adminId,
        reviewedAt: now,
        updatedAt: now,
      },
    }
  );

  // Notify each rejected user asynchronously
  userIds.forEach((uid) => notifyRejection(uid, roomId.toString()));

  return NextResponse.json({ success: true, rejected: pending.length });
}
