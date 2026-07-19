import "./load-env";
import { MongoClient, ObjectId } from "mongodb";

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not defined");
  }
  return uri;
}

let client: MongoClient;

export async function getDb() {
  if (!client) {
    client = new MongoClient(getMongoUri(), {
      // Fail fast instead of hanging socket ACKs when Mongo isn't reachable.
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    await client.connect();
  }
  const dbName = process.env.MONGODB_DB_NAME || "dechat";
  return client.db(dbName);
}

export async function isRoomDisabled(roomId: string): Promise<boolean> {
  const db = await getDb();
  const room = await db.collection("rooms").findOne(
    { _id: new ObjectId(roomId) },
    { projection: { isDisabled: 1 } }
  );
  return Boolean(room?.isDisabled);
}

export async function getSenderInfo(roomId: string, userId: string): Promise<{ name: string | null; userIndex: number | null }> {
  const db = await getDb();
  const [user, membership] = await Promise.all([
    db.collection("user").findOne(
      { _id: new ObjectId(userId) },
      { projection: { name: 1, email: 1 } }
    ),
    db.collection("room_memberships").findOne(
      { roomId: new ObjectId(roomId), userId: new ObjectId(userId) },
      { projection: { userIndex: 1 } }
    ),
  ]);
  return {
    name: user?.name || user?.email || null,
    userIndex: membership?.userIndex ?? null,
  };
}

export async function isActiveMember(
  roomId: string,
  userId: string
): Promise<boolean> {
  const db = await getDb();
  const membership = await db.collection("room_memberships").findOne({
    roomId: new ObjectId(roomId),
    userId: new ObjectId(userId),
    status: "APPROVED",
    isBlocked: false,
  });
  return Boolean(membership);
}

export interface ReplyToSubdocument {
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif";
  previewIv: string | null;
  previewCiphertext: string | null;
  previewAuthTag: string | null;
}

export interface PersistEncryptedMessageInput {
  roomId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  messageType: "text" | "image" | "video" | "gif";
  roomKeyVersion?: number;
  replyTo?: ReplyToSubdocument | null;
}

export async function fetchMessagesSince(
  roomId: string,
  userId: string,
  since: string,
  sinceId?: string,
  limit = 100
) {
  const db = await getDb();
  const collection = db.collection("room_messages");
  const roomObjectId = new ObjectId(roomId);

  // Enforce the member's join boundary — no messages before they joined.
  const membership = await db.collection("room_memberships").findOne(
    { roomId: roomObjectId, userId: new ObjectId(userId) },
    { projection: { joinedAt: 1 } }
  );
  const joinedAt: Date = membership?.joinedAt instanceof Date ? membership.joinedAt : new Date(0);

  let query: Record<string, unknown> = { roomId: roomObjectId };

  if (sinceId && ObjectId.isValid(sinceId)) {
    const anchorId = new ObjectId(sinceId);
    const anchor = await collection.findOne({ _id: anchorId, roomId: roomObjectId });
    if (anchor) {
      query = {
        roomId: roomObjectId,
        createdAt: { $gt: joinedAt },  // never return pre-join messages
        $or: [
          { createdAt: { $gt: anchor.createdAt } },
          { createdAt: anchor.createdAt, _id: { $gt: anchorId } },
        ],
      };
    }
  } else {
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error("Invalid since timestamp");
    }
    // Use whichever lower-bound is later: the client's since timestamp or the member's joinedAt.
    const effectiveSince = sinceDate > joinedAt ? sinceDate : joinedAt;
    query = { roomId: roomObjectId, createdAt: { $gt: effectiveSince } };
  }

  const messages = await collection
    .find(query)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .toArray();

  // Enrich with sender info
  const senderIds = [...new Set(messages.map((doc: any) => doc.senderId.toHexString()))];
  const senderObjectIds = senderIds.map((id) => new ObjectId(id));
  const [users, memberships] = await Promise.all([
    db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1 }).toArray(),
    db.collection("room_memberships").find({ roomId: roomObjectId, userId: { $in: senderObjectIds } }).project({ userId: 1, userIndex: 1 }).toArray(),
  ]);
  const userMap = new Map(users.map((u: any) => [u._id.toHexString(), u]));
  const membershipMap = new Map(memberships.map((m: any) => [m.userId.toHexString(), m]));

  return messages.map((doc) => {
    const senderId = doc.senderId.toHexString();
    const user = userMap.get(senderId);
    const membership = membershipMap.get(senderId);
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
      id: doc._id.toHexString(),
      roomId: doc.roomId.toHexString(),
      senderId,
      ciphertext: doc.ciphertext as string,
      iv: doc.iv as string,
      authTag: doc.authTag as string,
      messageType: doc.messageType as "text" | "image" | "video",
      roomKeyVersion: typeof doc.roomKeyVersion === "number" ? doc.roomKeyVersion : 0,
      replyTo,
      editedAt: doc.editedAt ? (doc.editedAt as Date).toISOString() : null,
      createdAt: (doc.createdAt as Date).toISOString(),
      senderName: user?.name || user?.email || null,
      senderUserIndex: membership?.userIndex ?? null,
    };
  });
}

export async function persistEncryptedMessage(input: PersistEncryptedMessageInput) {
  const db = await getDb();
  const now = new Date();
  const doc: Record<string, unknown> = {
    roomId: new ObjectId(input.roomId),
    senderId: new ObjectId(input.senderId),
    ciphertext: input.ciphertext,
    iv: input.iv,
    authTag: input.authTag,
    messageType: input.messageType,
    createdAt: now,
  };

  if (typeof input.roomKeyVersion === "number") {
    doc.roomKeyVersion = input.roomKeyVersion;
  }

  if (input.replyTo) {
    doc.replyTo = {
      messageId: new ObjectId(input.replyTo.messageId),
      senderId: new ObjectId(input.replyTo.senderId),
      senderName: input.replyTo.senderName,
      senderUserIndex: input.replyTo.senderUserIndex ?? null,
      messageType: input.replyTo.messageType,
      previewIv: input.replyTo.previewIv ?? null,
      previewCiphertext: input.replyTo.previewCiphertext ?? null,
      previewAuthTag: input.replyTo.previewAuthTag ?? null,
    };
  }

  const result = await db.collection("room_messages").insertOne(doc);
  const insertedIdHex = result.insertedId.toHexString();

  // Keep room's latest message metadata up-to-date
  await db.collection("rooms").updateOne(
    { _id: new ObjectId(input.roomId) },
    {
      $set: {
        latestMessageId: insertedIdHex,
        latestMessageCreatedAt: now,
      },
    }
  );

  return {
    _id: insertedIdHex,
    createdAt: now.toISOString(),
  };
}

export async function updateMessageContent(
  roomId: string,
  messageId: string,
  senderId: string,
  ciphertext: string,
  iv: string,
  authTag: string
) {
  const db = await getDb();
  const result = await db.collection("room_messages").updateOne(
    { _id: new ObjectId(messageId), roomId: new ObjectId(roomId), senderId: new ObjectId(senderId) },
    { $set: { ciphertext, iv, authTag, editedAt: new Date() } }
  );
  return result.matchedCount > 0;
}

export async function deleteMessage(
  roomId: string,
  messageId: string,
  senderId: string
) {
  const db = await getDb();
  const result = await db.collection("room_messages").deleteOne(
    { _id: new ObjectId(messageId), roomId: new ObjectId(roomId), senderId: new ObjectId(senderId) }
  );
  return result.deletedCount > 0;
}
