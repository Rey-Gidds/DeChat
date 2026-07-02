import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db, ensureMongoConnected } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId, CompleteRotationSchema } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

async function notifyKeyRotationComplete(
  roomId: string,
  version: number
) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${wsUrl}/internal/key-rotation-complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({ roomId, version }),
  }).catch((err) => {
    console.error("[complete] Failed to notify websocket server:", err);
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
  if (!membership || membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Not an approved member" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = CompleteRotationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const now = new Date();

  // 1. Verify lock ownership — the client claims the lock before completing
  const versionDoc = await db
    .collection("room_key_versions")
    .findOne({
      roomId,
      version: parsed.data.version,
      status: "GENERATING",
      lockOwner: userId,
      lockExpiry: { $gt: now },
    });

  if (!versionDoc) {
    return NextResponse.json(
      { error: "Lock not held or expired. Re-claim the lock first." },
      { status: 403 }
    );
  }

  const client = await ensureMongoConnected();
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      // 2. Check for duplicate work — only one distribution per member per version
      const existing = await db
        .collection("room_key_distribution")
        .findOne(
          { roomId, keyVersion: parsed.data.version },
          { session }
        );

      if (existing) {
        throw new Error("Distribution for this version already exists");
      }

      // 3. Create room_key_distribution docs (one per remaining member)
      const distributionDocs = parsed.data.distributions.map((d) => ({
        _id: new ObjectId(),
        roomId,
        keyVersion: parsed.data.version,
        userId: new ObjectId(d.userId),
        encryptedKey: d.encryptedKey,
        distributedAt: now,
      }));

      await db
        .collection("room_key_distribution")
        .insertMany(distributionDocs, { session });

      // 4. Update room_key_versions: set status to COMPLETE, release lock
      await db
        .collection("room_key_versions")
        .updateOne(
          { roomId, version: parsed.data.version },
          {
            $set: {
              status: "COMPLETE",
              lockOwner: null,
              lockExpiry: null,
            },
          },
          { session }
        );

      // 5. Update room: bump lastKeyVersion, clear pendingKeyRotation
      await db
        .collection("rooms")
        .updateOne(
          { _id: roomId },
          {
            $set: {
              lastKeyVersion: parsed.data.version,
              pendingKeyRotation: false,
            },
          },
          { session }
        );

      // 6. Update each distribution member's membership: set currentKeyVersion
      const recipientIds = parsed.data.distributions.map((d) => new ObjectId(d.userId));
      await db
        .collection("room_memberships")
        .updateMany(
          {
            roomId,
            userId: { $in: recipientIds },
            status: "APPROVED",
          },
          {
            $set: {
              currentKeyVersion: parsed.data.version,
              updatedAt: now,
            },
          },
          { session }
        );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rotation complete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await session.endSession().catch(() => undefined);
  }

  // 7. Notify WebSocket server (outside transaction, fire-and-forget)
  notifyKeyRotationComplete(roomId.toString(), parsed.data.version);

  return NextResponse.json({ ok: true });
}