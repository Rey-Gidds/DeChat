import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import type { PfpMetadata } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";


type RouteContext = { params: Promise<{ roomId: string }> };

function serializeMessage(doc: Record<string, any>) {
  const replyTo = doc.replyTo
    ? {
        messageId: doc.replyTo.messageId.toString(),
        senderId: doc.replyTo.senderId.toString(),
        senderName: doc.replyTo.senderName,
        senderUserIndex: doc.replyTo.senderUserIndex ?? null,
        messageType: doc.replyTo.messageType,
        previewIv: doc.replyTo.previewIv ?? null,
        previewCiphertext: doc.replyTo.previewCiphertext ?? null,
        previewAuthTag: doc.replyTo.previewAuthTag ?? null,
      }
    : null;

  return {
    id: doc._id.toString(),
    roomId: doc.roomId.toString(),
    senderId: doc.senderId.toString(),
    ciphertext: doc.ciphertext,
    iv: doc.iv,
    authTag: doc.authTag,
    messageType: doc.messageType,
    roomKeyVersion: doc.roomKeyVersion ?? 0,
    replyTo,
    editedAt: doc.editedAt
      ? (doc.editedAt instanceof Date ? doc.editedAt : new Date(doc.editedAt)).toISOString()
      : null,
    createdAt: doc.createdAt.toISOString(),
    senderName: null as string | null,
    senderUserIndex: null as number | null,
    senderPfp: null as PfpMetadata | null,
  };
}

async function enrichMessagesWithSenders(
  roomId: ObjectId,
  messages: ReturnType<typeof serializeMessage>[]
) {
  if (messages.length === 0) return messages;

  const senderIds = [...new Set(messages.map((m) => m.senderId))];
  const senderObjectIds = senderIds
    .map((id) => {
      try {
        return new ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ObjectId[];

  const [users, memberships] = await Promise.all([
    db
      .collection("user")
      .find({ _id: { $in: senderObjectIds } })
      .project({ name: 1, email: 1, pfp: 1 })
      .toArray(),
    db
      .collection("room_memberships")
      .find({ roomId, userId: { $in: senderObjectIds } })
      .project({ userId: 1, userIndex: 1 })
      .toArray(),
  ]);

  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));
  const membershipMap = new Map(
    memberships.map((m: any) => [m.userId.toString(), m])
  );

  return messages.map((msg) => {
    const user = userMap.get(msg.senderId);
    const membership = membershipMap.get(msg.senderId);
    return {
      ...msg,
      senderName: user?.name || user?.email || null,
      senderUserIndex: membership?.userIndex ?? null,
      senderPfp: (user?.pfp as PfpMetadata) ?? null,
    };
  });
}

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
  if (!membership || membership.status !== "APPROVED" || membership.isBlocked) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const messageId = searchParams.get("messageId");
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") || "25", 10), 1),
    50
  );

  if (!messageId || !/^[a-fA-F0-9]{24}$/.test(messageId)) {
    return NextResponse.json(
      { error: "Invalid or missing messageId" },
      { status: 400 }
    );
  }

  const collection = db.collection("room_messages");

  // Enforce the member's join boundary — no messages before they joined.
  const joinedAt: Date =
    membership.joinedAt instanceof Date ? membership.joinedAt : new Date(0);

  // Look up the target message
  const target = await collection.findOne({
    _id: new ObjectId(messageId),
    roomId,
  });

  if (!target) {
    return NextResponse.json(
      { error: "Target message not found" },
      { status: 404 }
    );
  }

  // If the target message was created before the user joined, silently refuse
  if (target.createdAt <= joinedAt) {
    return NextResponse.json({
      messages: [],
      targetMessageId: messageId,
      hasOlder: false,
      hasNewer: false,
      olderCursor: null,
      newerCursor: null,
      reason: "before_join",
    });
  }

  // Fetch older messages (before the target), clamped to joinedAt
  const older = await collection
    .find({
      roomId,
      createdAt: { $gt: joinedAt },
      $or: [
        { createdAt: { $lt: target.createdAt } },
        {
          createdAt: target.createdAt,
          _id: { $lt: target._id },
        },
      ],
    })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
  older.reverse();

  // Fetch newer messages (after the target), clamped to joinedAt
  const newer = await collection
    .find({
      roomId,
      createdAt: { $gt: joinedAt },
      $or: [
        { createdAt: { $gt: target.createdAt } },
        {
          createdAt: target.createdAt,
          _id: { $gt: target._id },
        },
      ],
    })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();

  // Merge: older + target + newer, sorted ascending
  const merged = [...older, target, ...newer];

  // Compute cursors
  const hasOlder = older.length === limit;
  const hasNewer = newer.length === limit;
  const olderCursor =
    merged.length > 0 ? merged[0]._id.toString() : null;
  const newerCursor =
    merged.length > 0
      ? merged[merged.length - 1]._id.toString()
      : null;

  const messages = await enrichMessagesWithSenders(
    roomId,
    merged.map((doc: any) => serializeMessage(doc))
  );

  return NextResponse.json({
    messages,
    targetMessageId: messageId,
    hasOlder,
    hasNewer,
    olderCursor,
    newerCursor,
  });
}
