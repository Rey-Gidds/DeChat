import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId, ClaimRotationSchema } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

const LOCK_TTL_MS = 30_000;

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
  const lockExpiry = new Date(now.getTime() + LOCK_TTL_MS);

  const result = await db.collection("room_key_versions").findOneAndUpdate(
    {
      roomId,
      version: parsed.data.version,
      status: "GENERATING",
      $or: [
        { lockOwner: null },
        { lockExpiry: { $lt: now } },
      ],
    },
    {
      $set: {
        lockOwner: userId,
        lockExpiry,
      },
    }
  );

  const lockAcquired = result !== null;

  return NextResponse.json({ lockAcquired });
}
