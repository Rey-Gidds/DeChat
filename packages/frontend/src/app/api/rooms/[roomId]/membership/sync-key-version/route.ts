import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId, SyncKeyVersionSchema } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

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
  const membership = await getMembership(roomId, userId);
  if (!membership || membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Not an approved member" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = SyncKeyVersionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const now = new Date();

  // Update membership: set currentKeyVersion
  await db
    .collection("room_memberships")
    .updateOne(
      { roomId, userId },
      {
        $set: {
          currentKeyVersion: parsed.data.keyVersion,
          updatedAt: now,
        },
      }
    );

  const updated = await getMembership(roomId, userId);
  if (!updated) {
    return NextResponse.json({ error: "Membership lost" }, { status: 500 });
  }

  return NextResponse.json({
    membership: {
      ...updated,
      id: updated._id.toString(),
      userId: updated.userId.toString(),
      roomId: updated.roomId.toString(),
    },
  });
}