import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

const CACHE_WINDOW_SIZE = 100;
const DELTA_LIMIT = 200;

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
    editedAt: doc.editedAt ? (doc.editedAt instanceof Date ? doc.editedAt : new Date(doc.editedAt)).toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    senderName: null as string | null,
    senderUserIndex: null as number | null,
  };
}

async function enrichMessagesWithSenders(
  roomId: ObjectId,
  messages: ReturnType<typeof serializeMessage>[]
) {
  if (messages.length === 0) return messages;

  const senderIds = [...new Set(messages.map((m) => m.senderId))];
  const senderObjectIds = senderIds.map((id) => {
    try { return new ObjectId(id); } catch { return null; }
  }).filter(Boolean) as ObjectId[];

  // Fetch user names
  const users = await db
    .collection("user")
    .find({ _id: { $in: senderObjectIds } })
    .project({ name: 1, email: 1 })
    .toArray();

  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  // Fetch memberships for these users in this room
  const memberships = await db
    .collection("room_memberships")
    .find({ roomId, userId: { $in: senderObjectIds } })
    .project({ userId: 1, userIndex: 1 })
    .toArray();

  const membershipMap = new Map(memberships.map((m: any) => [m.userId.toString(), m]));

  return messages.map((msg) => {
    const user = userMap.get(msg.senderId);
    const membership = membershipMap.get(msg.senderId);
    return {
      ...msg,
      senderName: user?.name || user?.email || null,
      senderUserIndex: membership?.userIndex ?? null,
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
  if (
    !membership ||
    membership.status !== "APPROVED" ||
    membership.isBlocked
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const newestCachedMessageId = searchParams.get("newestCachedMessageId");
  const newestCachedCreatedAt = searchParams.get("newestCachedCreatedAt");

  const room = await db.collection("rooms").findOne(
    { _id: roomId },
    { projection: { latestMessageId: 1, latestMessageCreatedAt: 1 } }
  );

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const joinedAt: Date = membership.joinedAt instanceof Date ? membership.joinedAt : new Date(0);
  const collection = db.collection("room_messages");

  // Helper function to return the latest window (REPLACE)
  const fetchReplaceWindow = async () => {
    const messages = await collection
      .find({ roomId, createdAt: { $gt: joinedAt } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(CACHE_WINDOW_SIZE)
      .toArray();

    messages.reverse();

    return NextResponse.json({
      strategy: "REPLACE",
      messages: await enrichMessagesWithSenders(roomId, messages.map((doc: any) => serializeMessage(doc))),
    });
  };

  // 1. Cold start / empty cache
  if (!newestCachedMessageId || !newestCachedCreatedAt) {
    return fetchReplaceWindow();
  }

  // 2. Client is already fully up-to-date
  if (room.latestMessageId === newestCachedMessageId) {
    return NextResponse.json({
      strategy: "UP_TO_DATE",
      messages: [],
    });
  }

  // 3. Perform Delta Sync check
  const anchorId = parseObjectId(newestCachedMessageId);
  const sinceDate = new Date(newestCachedCreatedAt);

  if (!anchorId || Number.isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: "Invalid newest cached message metadata" }, { status: 400 });
  }

  // Anchor query logic
  const anchor = await collection.findOne({ _id: anchorId, roomId });
  let deltaQuery: Record<string, unknown>;

  if (anchor) {
    deltaQuery = {
      roomId,
      createdAt: { $gt: joinedAt }, // never return pre-join messages
      $or: [
        { createdAt: { $gt: anchor.createdAt } },
        { createdAt: anchor.createdAt, _id: { $gt: anchorId } },
      ],
    };
  } else {
    // If the anchor isn't found in DB (e.g. deleted or client cache has weird ID)
    const effectiveSince = sinceDate > joinedAt ? sinceDate : joinedAt;
    deltaQuery = { roomId, createdAt: { $gt: effectiveSince } };
  }

  // Fetch up to DELTA_LIMIT + 1 messages to determine if we should delta or replace
  const messages = await collection
    .find(deltaQuery)
    .sort({ createdAt: 1, _id: 1 })
    .limit(DELTA_LIMIT + 1)
    .toArray();

  if (messages.length <= DELTA_LIMIT) {
    return NextResponse.json({
      strategy: "DELTA",
      messages: await enrichMessagesWithSenders(roomId, messages.map((doc: any) => serializeMessage(doc))),
    });
  }

  // 4. Large gap -> Fallback to REPLACE strategy
  return fetchReplaceWindow();
}
