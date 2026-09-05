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
    editedAt: doc.editedAt ? (doc.editedAt instanceof Date ? doc.editedAt : new Date(doc.editedAt)).toISOString() : null,
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
  const senderObjectIds = senderIds.map((id) => {
    try { return new ObjectId(id); } catch { return null; }
  }).filter(Boolean) as ObjectId[];

  // Fetch user names + pfp
  const users = await db
    .collection("user")
    .find({ _id: { $in: senderObjectIds } })
    .project({ name: 1, email: 1, pfp: 1 })
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
  if (
    !membership ||
    membership.status !== "APPROVED" ||
    membership.isBlocked
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "30", 10), 1), 100);
  const cursor = searchParams.get("cursor");
  const since = searchParams.get("since");
  const sinceId = searchParams.get("sinceId");
  const direction = searchParams.get("direction"); // "newer" | undefined (older)

  const collection = db.collection("room_messages");

  // Enforce the member's join boundary — no messages before they joined.
  const joinedAt: Date = membership.joinedAt instanceof Date ? membership.joinedAt : new Date(0);

  if (since) {
    let syncQuery: Record<string, unknown> = { roomId };

    if (sinceId) {
      const anchorId = parseObjectId(sinceId);
      if (!anchorId) {
        return NextResponse.json({ error: "Invalid sinceId" }, { status: 400 });
      }
      const anchor = await collection.findOne({ _id: anchorId, roomId });
      if (!anchor) {
        return NextResponse.json({ error: "Anchor message not found" }, { status: 400 });
      }
      syncQuery = {
        roomId,
        createdAt: { $gt: joinedAt }, // never surface pre-join messages
        $or: [
          { createdAt: { $gt: anchor.createdAt } },
          { createdAt: anchor.createdAt, _id: { $gt: anchorId } },
        ],
      };
    } else {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
      }
      // Use whichever lower-bound is later: client's since timestamp or the member's joinedAt.
      const effectiveSince = sinceDate > joinedAt ? sinceDate : joinedAt;
      syncQuery = { roomId, createdAt: { $gt: effectiveSince } };
    }

    const messages = await collection
      .find(syncQuery)
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();

    return NextResponse.json({
      messages: await enrichMessagesWithSenders(roomId, messages.map((doc: any) => serializeMessage(doc))),
      nextCursor: null,
    });
  }

  // Newer-direction scrollback (from a jumped-to position, scrolling down toward live)
  if (direction === "newer" && cursor) {
    const cursorId = parseObjectId(cursor);
    if (!cursorId) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
    const cursorMsg = await collection.findOne({ _id: cursorId, roomId });
    if (!cursorMsg) {
      return NextResponse.json({ error: "Cursor message not found" }, { status: 400 });
    }
    const pageQuery = {
      roomId,
      $or: [
        { createdAt: { $gt: cursorMsg.createdAt } },
        { createdAt: cursorMsg.createdAt, _id: { $gt: cursorId } },
      ],
    };

    const rows = await collection
      .find(pageQuery)
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const nextCursor =
      hasMore && rows.length > 0 ? rows[rows.length - 1]._id.toString() : null;

    return NextResponse.json({
      messages: await enrichMessagesWithSenders(roomId, rows.map((doc: any) => serializeMessage(doc))),
      nextCursor,
    });
  }

  // Scrollback (older-direction) query: always clamp the oldest visible message to the member's joinedAt.
  let pageQuery: Record<string, unknown> = { roomId, createdAt: { $gt: joinedAt } };

  if (cursor) {
    const cursorId = parseObjectId(cursor);
    if (!cursorId) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
    const cursorMsg = await collection.findOne({ _id: cursorId, roomId });
    if (!cursorMsg) {
      return NextResponse.json({ error: "Cursor message not found" }, { status: 400 });
    }
    pageQuery = {
      roomId,
      createdAt: { $gt: joinedAt }, // enforce join boundary even during scrollback
      $or: [
        { createdAt: { $lt: cursorMsg.createdAt } },
        { createdAt: cursorMsg.createdAt, _id: { $lt: cursorId } },
      ],
    };
  }

  const rows = await collection
    .find(pageQuery)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  rows.reverse();

  const nextCursor =
    hasMore && rows.length > 0 ? rows[0]._id.toString() : null;

  return NextResponse.json({
    messages: await enrichMessagesWithSenders(roomId, rows.map((doc: any) => serializeMessage(doc))),
    nextCursor,
  });
}
