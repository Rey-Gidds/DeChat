import { db, auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { seedTags } from "@/lib/tags";

export async function GET(req: Request) {
  try {
    // Basic verification: only allow requests in development, or verify credentials
    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    
    if (process.env.NODE_ENV !== "development" && key !== process.env.ADMIN_INDEX_KEY) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const results: string[] = [];

    // 1. Index users unique name/email (Better Auth handles default user indexes, but we explicitly enforce)
    await db.collection("user").createIndex({ email: 1 }, { unique: true });
    results.push("Created unique index on user(email)");

    // 2. Indexes for rooms
    await db.collection("rooms").createIndex({ roomLink: 1 }, { unique: true });
    results.push("Created unique index on rooms(roomLink)");

    await db.collection("rooms").createIndex({ joinPolicy: 1, isActive: 1, isDisabled: 1, tags: 1, createdAt: -1 });
    results.push("Created comprehensive index on rooms(joinPolicy, isActive, isDisabled, tags, createdAt)");

    // 3. Indexes for memberships
    await db.collection("room_memberships").createIndex({ roomId: 1, userId: 1 }, { unique: true });
    results.push("Created unique compound index on room_memberships(roomId, userId)");

    await db.collection("room_memberships").createIndex({ userId: 1, status: 1, isBlocked: 1 });
    results.push("Created index on room_memberships(userId, status, isBlocked)");

    await db.collection("room_memberships").createIndex({ roomId: 1, status: 1, isBlocked: 1 });
    results.push("Created index on room_memberships(roomId, status, isBlocked)");

    await db.collection("room_memberships").createIndex({ roomId: 1, status: 1, createdAt: 1 });
    results.push("Created index on room_memberships(roomId, status, createdAt)");

    // Optimises join-ordered member listing AND the joinedAt boundary lookups on message fetch.
    await db.collection("room_memberships").createIndex({ roomId: 1, status: 1, isBlocked: 1, joinedAt: 1 });
    results.push("Created index on room_memberships(roomId, status, isBlocked, joinedAt)");

    // 4. Indexes for messages
    await db.collection("room_messages").createIndex({ roomId: 1, createdAt: -1, _id: -1 });
    results.push("Created pagination index on room_messages(roomId, createdAt, _id)");

    await db.collection("room_messages").createIndex({ roomId: 1, createdAt: 1, _id: 1 });
    results.push("Created ascending synchronization index on room_messages(roomId, createdAt, _id)");

    // Sparse index for reply-to lookups (admin tools / debugging)
    await db.collection("room_messages").createIndex(
      { "replyTo.messageId": 1 },
      { sparse: true }
    );
    results.push("Created sparse index on room_messages(replyTo.messageId)");

    // 5. Indexes for tag_stats
    await db.collection("tag_stats").createIndex({ tag: 1 }, { unique: true });
    results.push("Created unique index on tag_stats(tag)");

    await db.collection("tag_stats").createIndex({ trendingScore: -1 });
    results.push("Created index on tag_stats(trendingScore)");

    await db.collection("tag_stats").createIndex({ totalCount: -1 });
    results.push("Created index on tag_stats(totalCount)");

    // 6. Seed tags collection
    await seedTags();
    results.push("Seeded tag collection");

    return NextResponse.json({
      success: true,
      results,
    });
  } catch (err: any) {
    console.error("Index setup failed:", err);
    return NextResponse.json({ error: err.message || "Failed to initialize indexes" }, { status: 500 });
  }
}
