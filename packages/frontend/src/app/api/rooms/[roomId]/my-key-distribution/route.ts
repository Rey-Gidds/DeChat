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

  const distributions = await db
    .collection("room_key_distribution")
    .find({ roomId, userId })
    .sort({ keyVersion: 1 })
    .toArray();

  return NextResponse.json({
    distributions: distributions.map((d) => ({
      id: d._id.toString(),
      roomId: d.roomId.toString(),
      keyVersion: d.keyVersion,
      userId: d.userId.toString(),
      encryptedKey: d.encryptedKey,
      distributedAt: d.distributedAt,
    })),
  });
}
