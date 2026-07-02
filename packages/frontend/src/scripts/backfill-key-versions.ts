/**
 * Migration script: backfill existing rooms with room_key_versions and
 * room_key_distribution docs for key version 0.
 *
 * Usage:
 *   MONGODB_URI=... MONGODB_DB_NAME=dechat npx tsx packages/frontend/src/scripts/backfill-key-versions.ts
 *
 * Idempotent — skips rooms that already have a version 0 document.
 */

import { MongoClient, ObjectId } from "mongodb";
import fs from "fs";
import path from "path";

// Load .env.local if present
try {
  const envPath = path.resolve(__dirname, "../../.env.local");
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, "utf-8");
    for (const line of envFile.split("\n")) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)\s*$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.substring(1, value.length - 1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
} catch (e) {
  // Ignore
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "dechat";

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}

const MONGO_URI: string = MONGODB_URI;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const roomsCol = db.collection("rooms");
  const versionsCol = db.collection("room_key_versions");
  const distCol = db.collection("room_key_distribution");
  const membersCol = db.collection("room_memberships");

  // Ensure indexes
  await versionsCol.createIndex({ roomId: 1, version: 1 }, { unique: true });
  await versionsCol.createIndex({ roomId: 1, status: 1 });
  await versionsCol.createIndex({ roomId: 1, lockOwner: 1, lockExpiry: 1 });
  await distCol.createIndex({ roomId: 1, keyVersion: 1, userId: 1 }, { unique: true });
  await distCol.createIndex({ roomId: 1, userId: 1 });

  const rooms = await roomsCol.find({ isActive: true }).toArray();
  console.log(`Found ${rooms.length} active rooms to process`);

  let processed = 0;
  let skipped = 0;

  for (const room of rooms) {
    const roomId = room._id;

    // Check if version 0 already exists
    const existing = await versionsCol.findOne({ roomId, version: 0 });
    if (existing) {
      skipped++;
      continue;
    }

    // Find all APPROVED members with their encryptedRoomKey
    const approvedMembers = await membersCol
      .find({ roomId, status: "APPROVED" })
      .toArray();

    if (approvedMembers.length === 0) {
      console.log(`  Room ${roomId}: no approved members, skipping`);
      skipped++;
      continue;
    }

    // Fetch user details for approved members to get publicKeys
    const userIds = approvedMembers.map((m: any) => m.userId);
    const users = await db
      .collection("user")
      .find({ _id: { $in: userIds } })
      .project({ publicKey: 1, name: 1, email: 1 })
      .toArray();

    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const added: string[] = [];
    const warnNoKey: string[] = [];
    const warnNeither: string[] = [];
    const warnNoPublicKey: string[] = [];

    const distDocs = [];
    const now = new Date();

    for (const m of approvedMembers) {
      const u = userMap.get(m.userId.toString());
      const hasPublicKey = !!u?.publicKey;
      const hasEncryptedKey = !!m.encryptedRoomKey;
      const identifier = u ? `${u.name || "Unknown"} (${u.email || m.userId.toString()})` : m.userId.toString();

      if (hasEncryptedKey) {
        distDocs.push({
          _id: new ObjectId(),
          roomId,
          keyVersion: 0,
          userId: m.userId,
          encryptedKey: m.encryptedRoomKey,
          distributedAt: m.joinedAt || now,
        });
        if (hasPublicKey) {
          added.push(identifier);
        } else {
          warnNoPublicKey.push(identifier);
        }
      } else {
        if (hasPublicKey) {
          warnNoKey.push(identifier);
        } else {
          warnNeither.push(identifier);
        }
      }
    }

    if (added.length > 0) {
      console.log(`  Room ${roomId}: members added to distribution:`, added.join(", "));
    }
    if (warnNoPublicKey.length > 0) {
      console.log(`  Room ${roomId}: WARNING - members added to distribution but missing publicKey in user doc:`, warnNoPublicKey.join(", "));
    }
    if (warnNoKey.length > 0) {
      console.log(`  Room ${roomId}: WARNING - members have publicKey but no encryptedRoomKey in membership (needs manual re-distribution):`, warnNoKey.join(", "));
    }
    if (warnNeither.length > 0) {
      console.log(`  Room ${roomId}: WARNING - members have neither publicKey nor encryptedRoomKey:`, warnNeither.join(", "));
    }

    // 1. Create room_key_versions doc (version 0)
    await versionsCol.insertOne({
      _id: new ObjectId(),
      roomId,
      version: 0,
      createdBy: room.creatorId || approvedMembers[0].userId,
      createdAt: room.createdAt || now,
      reason: "CREATED",
      status: "ACTIVE",
    });

    if (distDocs.length > 0) {
      await distCol.insertMany(distDocs);
    }

    // 3. Update room: set lastKeyVersion and pendingKeyRotation
    await roomsCol.updateOne(
      { _id: roomId },
      {
        $set: {
          lastKeyVersion: 0,
          pendingKeyRotation: false,
        },
      }
    );

    // 4. Update memberships: set currentKeyVersion
    await membersCol.updateMany(
      { roomId, status: "APPROVED" },
      { $set: { currentKeyVersion: 0 } }
    );

    processed++;
    console.log(
      `  Room ${roomId}: version 0 created, ${distDocs.length} distribution docs`
    );
  }

  console.log(`\nDone. Processed: ${processed}, Skipped: ${skipped}`);
  await client.close();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
