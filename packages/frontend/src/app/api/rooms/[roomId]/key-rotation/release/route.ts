import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId, ClaimRotationSchema } from "@/lib/models";
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
  const parsed = ClaimRotationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const now = new Date();

  // Verify lock ownership
  const versionDoc = await db
    .collection("room_key_versions")
    .findOne({
      roomId,
      version: parsed.data.version,
      status: "GENERATING",
      lockOwner: userId,
    });

  if (!versionDoc) {
    return NextResponse.json(
      { error: "Lock not held or expired" },
      { status: 403 }
    );
  }

  // Release the lock
  await db
    .collection("room_key_versions")
    .updateOne(
      { roomId, version: parsed.data.version, lockOwner: userId },
      {
        $set: {
          lockOwner: null,
          lockExpiry: null,
        },
      }
    );

  return NextResponse.json({ ok: true });
}