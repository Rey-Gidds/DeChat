import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
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
  if (!membership || membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Not an approved member" }, { status: 403 });
  }

  const versions = await db
    .collection("room_key_versions")
    .find({ roomId })
    .sort({ version: 1 })
    .toArray();

  return NextResponse.json({
    versions: versions.map((v) => ({
      id: v._id.toString(),
      roomId: v.roomId.toString(),
      version: v.version,
      createdBy: v.createdBy?.toString() ?? null,
      createdAt: v.createdAt,
      reason: v.reason,
      triggerUserId: v.triggerUserId?.toString() ?? null,
      status: v.status,
    })),
  });
}
