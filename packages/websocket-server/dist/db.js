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
        db.collection("user").findOne({ _id: new mongodb_1.ObjectId(userId) }, { projection: { name: 1, email: 1 } }),
        db.collection("room_memberships").findOne({ roomId: new mongodb_1.ObjectId(roomId), userId: new mongodb_1.ObjectId(userId) }, { projection: { userIndex: 1 } }),
    ]);
    return {
        name: user?.name || user?.email || null,
        userIndex: membership?.userIndex ?? null,
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
        db.collection("user").find({ _id: { $in: senderObjectIds } }).project({ name: 1, email: 1 }).toArray(),
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
async function updateMessageContent(roomId, messageId, senderId, ciphertext, iv, authTag) {
    const db = await getDb();
    const result = await db.collection("room_messages").updateOne({ _id: new mongodb_1.ObjectId(messageId), roomId: new mongodb_1.ObjectId(roomId), senderId: new mongodb_1.ObjectId(senderId) }, { $set: { ciphertext, iv, authTag, editedAt: new Date() } });
    return result.matchedCount > 0;
}
async function deleteMessage(roomId, messageId, senderId) {
    const db = await getDb();
    const result = await db.collection("room_messages").deleteOne({ _id: new mongodb_1.ObjectId(messageId), roomId: new mongodb_1.ObjectId(roomId), senderId: new mongodb_1.ObjectId(senderId) });
    return result.deletedCount > 0;
}
