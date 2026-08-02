"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.isRoomDisabled = isRoomDisabled;
exports.getSenderInfo = getSenderInfo;
exports.isActiveMember = isActiveMember;
exports.fetchMessagesSince = fetchMessagesSince;
exports.persistEncryptedMessage = persistEncryptedMessage;
exports.updateMessageContent = updateMessageContent;
exports.deleteMessage = deleteMessage;
exports.getApprovedMemberships = getApprovedMemberships;
exports.getRoomsMetadata = getRoomsMetadata;
exports.incrementMutationVersion = incrementMutationVersion;
exports.fetchMutationPatches = fetchMutationPatches;
require("./load-env");
const mongodb_1 = require("mongodb");
function getMongoUri() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not defined");
    }
    return uri;
}
let client;
async function getDb() {
    if (!client) {
        client = new mongodb_1.MongoClient(getMongoUri(), {
            // Fail fast instead of hanging socket ACKs when Mongo isn't reachable.
            serverSelectionTimeoutMS: 5_000,
            connectTimeoutMS: 5_000,
        });
        await client.connect();
    }
    const dbName = process.env.MONGODB_DB_NAME || "dechat";
    return client.db(dbName);
}
async function isRoomDisabled(roomId) {
    const db = await getDb();
    const room = await db.collection("rooms").findOne({ _id: new mongodb_1.ObjectId(roomId) }, { projection: { isDisabled: 1 } });
    return Boolean(room?.isDisabled);
}
async function getSenderInfo(roomId, userId) {
    const db = await getDb();
    const [user, membership] = await Promise.all([
        db.collection("user").findOne({ _id: new mongodb_1.ObjectId(userId) }, { projection: { name: 1, email: 1, pfp: 1 } }),
        db.collection("room_memberships").findOne({ roomId: new mongodb_1.ObjectId(roomId), userId: new mongodb_1.ObjectId(userId) }, { projection: { userIndex: 1 } }),
    ]);
    return {
        name: user?.name || user?.email || null,
        userIndex: membership?.userIndex ?? null,
        pfp: user?.pfp ?? null,
    };
}
async function isActiveMember(roomId, userId) {
    const db = await getDb();
    const membership = await db.collection("room_memberships").findOne({
        roomId: new mongodb_1.ObjectId(roomId),
        userId: new mongodb_1.ObjectId(userId),
        status: "APPROVED",
        isBlocked: false,
    });
    return Boolean(membership);
}
async function fetchMessagesSince(roomId, userId, since, sinceId, limit = 100) {
    const db = await getDb();
    const collection = db.collection("room_messages");
    const roomObjectId = new mongodb_1.ObjectId(roomId);
    // Enforce the member's join boundary — no messages before they joined.
    const membership = await db.collection("room_memberships").findOne({ roomId: roomObjectId, userId: new mongodb_1.ObjectId(userId) }, { projection: { joinedAt: 1 } });
    const joinedAt = membership?.joinedAt instanceof Date ? membership.joinedAt : new Date(0);
    let query = { roomId: roomObjectId };
    if (sinceId && mongodb_1.ObjectId.isValid(sinceId)) {
        const anchorId = new mongodb_1.ObjectId(sinceId);
        const anchor = await collection.findOne({ _id: anchorId, roomId: roomObjectId });
        if (anchor) {
            query = {
                roomId: roomObjectId,
                createdAt: { $gt: joinedAt }, // never return pre-join messages
                $or: [
                    { createdAt: { $gt: anchor.createdAt } },
                    { createdAt: anchor.createdAt, _id: { $gt: anchorId } },
                ],
            };
        }
    }
    else {
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
    const senderIds = [...new Set(messages.map((doc) => doc.senderId.toHexString()))];
    const senderObjectIds = senderIds.map((id) => new mongodb_1.ObjectId(id));
    const [users, memberships] = await Promise.all([
        db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray(),
        db.collection("room_memberships").find({ roomId: roomObjectId, userId: { $in: senderObjectIds } }).project({ userId: 1, userIndex: 1 }).toArray(),
    ]);
    const userMap = new Map(users.map((u) => [u._id.toHexString(), u]));
    const membershipMap = new Map(memberships.map((m) => [m.userId.toHexString(), m]));
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
            ciphertext: doc.ciphertext,
            iv: doc.iv,
            authTag: doc.authTag,
            messageType: doc.messageType,
            roomKeyVersion: typeof doc.roomKeyVersion === "number" ? doc.roomKeyVersion : 0,
            replyTo,
            editedAt: doc.editedAt ? doc.editedAt.toISOString() : null,
            createdAt: doc.createdAt.toISOString(),
            senderName: user?.name || user?.email || null,
            senderUserIndex: membership?.userIndex ?? null,
            senderPfp: user?.pfp ?? null,
        };
    });
}
async function persistEncryptedMessage(input) {
    const db = await getDb();
    const now = new Date();
    const doc = {
        roomId: new mongodb_1.ObjectId(input.roomId),
        senderId: new mongodb_1.ObjectId(input.senderId),
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
            messageId: new mongodb_1.ObjectId(input.replyTo.messageId),
            senderId: new mongodb_1.ObjectId(input.replyTo.senderId),
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
    await db.collection("rooms").updateOne({ _id: new mongodb_1.ObjectId(input.roomId) }, {
        $set: {
            latestMessageId: insertedIdHex,
            latestMessageCreatedAt: now,
        },
    });
    return {
        _id: insertedIdHex,
        createdAt: now.toISOString(),
    };
}
async function updateMessageContent(roomId, messageId, senderId, ciphertext, iv, authTag, editCount) {
    const db = await getDb();
    const result = await db.collection("room_messages").updateOne({ _id: new mongodb_1.ObjectId(messageId), roomId: new mongodb_1.ObjectId(roomId), senderId: new mongodb_1.ObjectId(senderId) }, { $set: { ciphertext, iv, authTag, editedAt: new Date(), editCount } });
    return result.matchedCount > 0;
}
async function deleteMessage(roomId, messageId, senderId) {
    const db = await getDb();
    const result = await db.collection("room_messages").deleteOne({ _id: new mongodb_1.ObjectId(messageId), roomId: new mongodb_1.ObjectId(roomId), senderId: new mongodb_1.ObjectId(senderId) });
    return result.deletedCount > 0;
}
/** Returns all approved (non-blocked) membership roomIds for a user. */
async function getApprovedMemberships(userId) {
    const db = await getDb();
    const docs = await db.collection("room_memberships").find({ userId: new mongodb_1.ObjectId(userId), status: "APPROVED", isBlocked: false }, { projection: { roomId: 1 } }).toArray();
    return docs.map((d) => d.roomId.toHexString());
}
async function getRoomsMetadata(roomIds) {
    if (roomIds.length === 0)
        return [];
    const db = await getDb();
    const objectIds = roomIds.map((id) => new mongodb_1.ObjectId(id));
    const rooms = await db.collection("rooms").find({ _id: { $in: objectIds } }, { projection: { name: 1, latestMessageId: 1, latestMessageCreatedAt: 1, memberCount: 1, isDisabled: 1 } }).toArray();
    return rooms.map((r) => ({
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
async function incrementMutationVersion(roomId) {
    const db = await getDb();
    await db.collection("rooms").updateOne({ _id: new mongodb_1.ObjectId(roomId) }, { $inc: { mutationVersion: 1 } });
}
/**
 * Given a list of message IDs that a client has cached, returns:
 *  - `edits`:   messages that still exist but have a non-null editedAt (content changed)
 *  - `deletes`: IDs that no longer exist in the DB (the message was deleted)
 *
 * Used by sync_room_cache when the client's mutationVersion is behind the server's.
 */
async function fetchMutationPatches(roomId, cachedMessageIds) {
    if (cachedMessageIds.length === 0)
        return { edits: [], deletes: [] };
    const db = await getDb();
    const roomObjectId = new mongodb_1.ObjectId(roomId);
    // Validate IDs before converting to ObjectId
    const validIds = cachedMessageIds.filter((id) => mongodb_1.ObjectId.isValid(id));
    const objectIds = validIds.map((id) => new mongodb_1.ObjectId(id));
    const found = await db
        .collection("room_messages")
        .find({ _id: { $in: objectIds }, roomId: roomObjectId })
        .project({ _id: 1, ciphertext: 1, iv: 1, authTag: 1, editedAt: 1, editCount: 1, roomKeyVersion: 1, createdAt: 1, senderId: 1, messageType: 1, replyTo: 1 })
        .toArray();
    const foundIdSet = new Set(found.map((d) => d._id.toHexString()));
    // Enrich found docs with sender info
    const senderIds = [...new Set(found.map((d) => d.senderId.toHexString()))];
    const senderObjectIds = senderIds.map((id) => new mongodb_1.ObjectId(id));
    const [users, memberships] = await Promise.all([
        db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1, pfp: 1 }).toArray(),
        db.collection("room_memberships").find({ roomId: roomObjectId, userId: { $in: senderObjectIds } }).project({ userId: 1, userIndex: 1 }).toArray(),
    ]);
    const userMap = new Map(users.map((u) => [u._id.toHexString(), u]));
    const membershipMap = new Map(memberships.map((m) => [m.userId.toHexString(), m]));
    const edits = found
        .filter((d) => d.editedAt != null)
        .map((d) => {
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
            ciphertext: d.ciphertext,
            iv: d.iv,
            authTag: d.authTag,
            editedAt: (d.editedAt instanceof Date ? d.editedAt : new Date(d.editedAt)).toISOString(),
            editCount: typeof d.editCount === "number" ? d.editCount : 1,
            roomKeyVersion: typeof d.roomKeyVersion === "number" ? d.roomKeyVersion : 0,
            createdAt: (d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt)).toISOString(),
            senderId: sid,
            roomId,
            messageType: d.messageType,
            senderName: user?.name || user?.email || null,
            senderUserIndex: mem?.userIndex ?? null,
            senderPfp: user?.pfp ?? null,
            replyTo,
        };
    });
    const deletes = validIds
        .filter((id) => !foundIdSet.has(id))
        .map((id) => ({ messageId: id }));
    return { edits, deletes };
}
