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

export async function getSenderInfo(roomId: string, userId: string): Promise<{ name: string | null; userIndex: number | null; pfp: string | null }> {
  const db = await getDb();
  const [user, membership] = await Promise.all([
    db.collection("user").findOne(
      { _id: new ObjectId(userId) },
      { projection: { name: 1, email: 1, pfp: 1 } }
    ),
    db.collection("room_memberships").findOne(
      { roomId: new ObjectId(roomId), userId: new ObjectId(userId) },
      { projection: { userIndex: 1 } }
    ),
  ]);
  return {
    name: user?.name || user?.email || null,
    userIndex: membership?.userIndex ?? null,
    pfp: (user?.pfp as string) ?? null,
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

// ── In-Memory Approved Room Members Cache ─────────────────────────────────────
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes TTL
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes cleanup script interval

interface MemberCacheEntry {
  memberIds: string[];
  fetchedAt: number;
}

const memberCache = new Map<string, MemberCacheEntry>();

// Periodic cleanup script running every 5 minutes to purge entries older than 10 mins
setInterval(() => {
  const now = Date.now();
  for (const [roomId, entry] of memberCache.entries()) {
    if (now - entry.fetchedAt > MEMBER_CACHE_TTL_MS) {
      memberCache.delete(roomId);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function invalidateRoomMembersCache(roomId?: string): void {
  if (roomId) {
    memberCache.delete(roomId);
  } else {
    memberCache.clear();
  }
}

export async function getApprovedRoomMemberIds(roomId: string): Promise<string[]> {
  const now = Date.now();
  const cached = memberCache.get(roomId);
  if (cached && now - cached.fetchedAt <= MEMBER_CACHE_TTL_MS) {
    return cached.memberIds;
  }

  const db = await getDb();
  const memberships = await db.collection("room_memberships").find({
    roomId: new ObjectId(roomId),
    status: "APPROVED",
    isBlocked: false,
  }, { projection: { userId: 1 } }).toArray();

  const memberIds = memberships.map((m: any) => m.userId.toHexString());
  memberCache.set(roomId, { memberIds, fetchedAt: now });
  return memberIds;
}

export interface ReplyToSubdocument {
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif" | "audio";
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
  messageType: "text" | "image" | "video" | "gif" | "audio";
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
    db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray(),
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
      messageType: doc.messageType as "text" | "image" | "video" | "gif" | "audio",
      roomKeyVersion: typeof doc.roomKeyVersion === "number" ? doc.roomKeyVersion : 0,
      replyTo,
      editedAt: doc.editedAt ? (doc.editedAt as Date).toISOString() : null,
      createdAt: (doc.createdAt as Date).toISOString(),
      senderName: user?.name || user?.email || null,
      senderUserIndex: membership?.userIndex ?? null,
      senderPfp: (user?.pfp as string) ?? null,
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
  authTag: string,
  editCount: number
) {
  const db = await getDb();
  const result = await db.collection("room_messages").updateOne(
    { _id: new ObjectId(messageId), roomId: new ObjectId(roomId), senderId: new ObjectId(senderId) },
    { $set: { ciphertext, iv, authTag, editedAt: new Date(), editCount } }
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

/** Returns all approved (non-blocked) membership roomIds for a user. */
export async function getApprovedMemberships(userId: string): Promise<string[]> {
  const db = await getDb();
  const docs = await db.collection("room_memberships").find(
    { userId: new ObjectId(userId), status: "APPROVED", isBlocked: false },
    { projection: { roomId: 1 } }
  ).toArray();
  return docs.map((d) => (d.roomId as ObjectId).toHexString());
}

export interface RoomMetadata {
  roomId: string;
  latestMessageId: string | null;
  latestMessageCreatedAt: string | null;
  roomName: string;
  memberCount: number;
  isDisabled: boolean;
}

export async function getRoomsMetadata(
  roomIds: string[]
): Promise<RoomMetadata[]> {
  if (roomIds.length === 0) return [];
  const db = await getDb();
  const objectIds = roomIds.map((id) => new ObjectId(id));
  const rooms = await db.collection("rooms").find(
    { _id: { $in: objectIds } },
    { projection: { name: 1, latestMessageId: 1, latestMessageCreatedAt: 1, memberCount: 1, isDisabled: 1 } }
  ).toArray();

  return rooms.map((r: any) => ({
    roomId: r._id.toHexString(),
    latestMessageId: r.latestMessageId ?? null,
    latestMessageCreatedAt: r.latestMessageCreatedAt instanceof Date ? r.latestMessageCreatedAt.toISOString() : null,
    roomName: r.name ?? "Unnamed Room",
    memberCount: r.memberCount ?? 0,
    isDisabled: Boolean(r.isDisabled),
  }));
}

/**
 * Atomically increments the mutationVersion counter on a room document.
 * Called after every successful edit_message or delete_message so that clients
 * can detect stale caches on their next sync_room_cache RPC.
 */
export async function incrementMutationVersion(roomId: string): Promise<void> {
  const db = await getDb();
  await db.collection("rooms").updateOne(
    { _id: new ObjectId(roomId) },
    { $inc: { mutationVersion: 1 } }
  );
}

export interface MutationPatches {
  edits: Array<{
    id: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    editedAt: string;
    editCount: number;
    roomKeyVersion: number;
    createdAt: string;
    senderId: string;
    roomId: string;
    messageType: string;
    senderName: string | null;
    senderUserIndex: number | null;
    senderPfp: string | null;
    replyTo: any | null;
  }>;
  deletes: Array<{ messageId: string }>;
}

/**
 * Given a list of message IDs that a client has cached, returns:
 *  - `edits`:   messages that still exist but have a non-null editedAt (content changed)
 *  - `deletes`: IDs that no longer exist in the DB (the message was deleted)
 *
 * Used by sync_room_cache when the client's mutationVersion is behind the server's.
 */
export async function fetchMutationPatches(
  roomId: string,
  cachedMessageIds: string[]
): Promise<MutationPatches> {
  if (cachedMessageIds.length === 0) return { edits: [], deletes: [] };

  const db = await getDb();
  const roomObjectId = new ObjectId(roomId);

  // Validate IDs before converting to ObjectId
  const validIds = cachedMessageIds.filter((id) => ObjectId.isValid(id));
  const objectIds = validIds.map((id) => new ObjectId(id));

  const found = await db
    .collection("room_messages")
    .find({ _id: { $in: objectIds }, roomId: roomObjectId })
    .project({ _id: 1, ciphertext: 1, iv: 1, authTag: 1, editedAt: 1, editCount: 1, roomKeyVersion: 1, createdAt: 1, senderId: 1, messageType: 1, replyTo: 1 })
    .toArray();

  const foundIdSet = new Set(found.map((d: any) => d._id.toHexString()));

  // Enrich found docs with sender info
  const senderIds = [...new Set(found.map((d: any) => d.senderId.toHexString()))];
  const senderObjectIds = senderIds.map((id) => new ObjectId(id));
  const [users, memberships] = await Promise.all([
    db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray(),
    db.collection("room_memberships").find({ roomId: roomObjectId, userId: { $in: senderObjectIds } }).project({ userId: 1, userIndex: 1 }).toArray(),
  ]);
  const userMap = new Map(users.map((u: any) => [u._id.toHexString(), u]));
  const membershipMap = new Map(memberships.map((m: any) => [m.userId.toHexString(), m]));

  const edits = found
    .filter((d: any) => d.editedAt != null)
    .map((d: any) => {
      const sid = d.senderId.toHexString();
      const user = userMap.get(sid);
      const mem = membershipMap.get(sid);
      const replyTo = d.replyTo
        ? {
            messageId: d.replyTo.messageId.toString(),
            senderId: d.replyTo.senderId.toString(),
            senderName: d.replyTo.senderName,
            senderUserIndex: d.replyTo.senderUserIndex ?? null,
            messageType: d.replyTo.messageType,
            previewIv: d.replyTo.previewIv ?? null,
            previewCiphertext: d.replyTo.previewCiphertext ?? null,
            previewAuthTag: d.replyTo.previewAuthTag ?? null,
          }
        : null;
      return {
        id: d._id.toHexString(),
        ciphertext: d.ciphertext as string,
        iv: d.iv as string,
        authTag: d.authTag as string,
        editedAt: (d.editedAt instanceof Date ? d.editedAt : new Date(d.editedAt)).toISOString(),
        editCount: typeof d.editCount === "number" ? d.editCount : 1,
        roomKeyVersion: typeof d.roomKeyVersion === "number" ? d.roomKeyVersion : 0,
        createdAt: (d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt)).toISOString(),
        senderId: sid,
        roomId,
        messageType: d.messageType as string,
        senderName: user?.name || user?.email || null,
        senderUserIndex: mem?.userIndex ?? null,
        senderPfp: (user?.pfp as string) ?? null,
        replyTo,
      };
    });

  const deletes = validIds
    .filter((id) => !foundIdSet.has(id))
    .map((id) => ({ messageId: id }));

  return { edits, deletes };
}

