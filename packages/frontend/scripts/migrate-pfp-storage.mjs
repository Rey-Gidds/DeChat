/**
 * Migration Script: Base64 PFP -> Object Storage Preparation
 *
 * 1. Resets legacy Base64 string profile pictures on all users to null
 *    and sets `pfpNeedsReupload: true`.
 * 2. Deletes all active sessions in MongoDB to force re-authentication.
 * 3. Flushes session keys in Redis (if Upstash Redis is configured).
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-pfp-storage.mjs
 *   or
 *   node scripts/migrate-pfp-storage.mjs (reads process.env)
 */

import { MongoClient } from "mongodb";
import { Redis } from "@upstash/redis";

async function runMigration() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Error: MONGODB_URI environment variable is required.");
    process.exit(1);
  }

  const dbName = process.env.MONGODB_DB_NAME || "dechat";
  console.log(`Connecting to MongoDB (${dbName})...`);

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  console.log("Connected to MongoDB.");

  // 1. Clear legacy base64 pfp strings and flag users for re-upload
  console.log("Migrating users with legacy string profile pictures...");
  const userResult = await db.collection("user").updateMany(
    { pfp: { $type: "string" } },
    { $set: { pfp: null, pfpNeedsReupload: true } }
  );
  console.log(`Updated ${userResult.modifiedCount} user(s).`);

  // 2. Clear all session records in MongoDB
  console.log("Invalidating all active sessions in MongoDB...");
  const sessionResult = await db.collection("session").deleteMany({});
  console.log(`Deleted ${sessionResult.deletedCount} session document(s).`);

  // 3. Invalidate Redis session cache if configured
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.log("Flushing session keys in Upstash Redis...");
    try {
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });

      // Find all session keys and delete them
      let cursor = 0;
      let totalDeleted = 0;
      do {
        const [nextCursor, keys] = await redis.scan(cursor, { match: "session:*", count: 100 });
        cursor = Number(nextCursor);
        if (keys.length > 0) {
          await redis.del(...keys);
          totalDeleted += keys.length;
        }
      } while (cursor !== 0);

      console.log(`Deleted ${totalDeleted} session key(s) from Redis.`);
    } catch (err) {
      console.warn("Warning: Could not flush Redis session keys:", err.message);
    }
  } else {
    console.log("Upstash Redis not configured, skipping Redis session flush.");
  }

  await client.close();
  console.log("Migration complete!");
}

runMigration().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
