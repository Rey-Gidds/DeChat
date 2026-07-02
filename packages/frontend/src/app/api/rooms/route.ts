import { db } from "@/lib/auth";
import { NextResponse } from "next/server";
import { CreateRoomSchema, InitKeyVersionSchema } from "@/lib/models";
import { ObjectId } from "mongodb";
import crypto from "crypto";
import { requireSession } from "@/lib/api-auth";
import { getCachedSession } from "@/lib/cachedSession";
import { incrementTagCounts } from "@/lib/tag-stats";
import { generateRoomKey, wrapRoomKeyForPublicKey, importPublicKey } from "@/lib/crypto";

// POST: Create a new room
export async function POST(req: Request) {
  try {
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;
    const session = authResult.session;

    const body = await req.json();
    const parsed = CreateRoomSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    const { name, description, tags, joinPolicy, maxMembers } = parsed.data;

    // Generate unique invite code/link
    const roomLink = crypto.randomBytes(8).toString("hex");

    const creatorId = new ObjectId(session.user.id);
    const roomId = new ObjectId();

    const roomDoc = {
      _id: roomId,
      name,
      description,
      creatorId,
      tags: tags.map((t: any) => t.toLowerCase().trim()),
      joinPolicy,
      maxMembers,
      memberCount: 1,
      nextUserIndex: 2,
      roomLink,
      createdAt: new Date(),
      isActive: true,
      isDisabled: false,
    };

    // Insert room document
    await db.collection("rooms").insertOne(roomDoc);

    // Generate and wrap room key for creator
    const creatorKey = await generateRoomKey();
    const creatorUserDoc = await db.collection("user").findOne({ _id: creatorId });
    const creatorPublicKey = await importPublicKey(creatorUserDoc?.publicKey || "");
    const encryptedRoomKey = await wrapRoomKeyForPublicKey(creatorKey, creatorPublicKey);

    // Create version 0 record
    await db.collection("room_key_versions").insertOne({
      _id: new ObjectId(),
      roomId,
      version: 0,
      createdBy: creatorId,
      createdAt: new Date(),
      reason: "CREATED",
      status: "ACTIVE",
    });

    // Create distribution entry for creator
    await db.collection("room_key_distribution").insertOne({
      _id: new ObjectId(),
      roomId,
      keyVersion: 0,
      userId: creatorId,
      encryptedKey: encryptedRoomKey,
      distributedAt: new Date(),
    });

    // Update room with lastKeyVersion and clear pendingKeyRotation
    await db.collection("rooms").updateOne(
      { _id: roomId },
      {
        $set: {
          lastKeyVersion: 0,
          pendingKeyRotation: false,
        },
      }
    );

    // Creators automatically become the default Room Admin
    const membershipDoc = {
      _id: new ObjectId(),
      userId: creatorId,
      roomId: roomId,
      status: "APPROVED",
      joinedAt: new Date(),
      lastVisitedAt: new Date(),
      role: "OWNER",
      userIndex: 1,
      reviewedBy: null,
      reviewedAt: null,
      isBlocked: false,
      kickoutCount: 0,
      currentKeyVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection("room_memberships").insertOne(membershipDoc);

    // Fire-and-forget: increment tag usage counters (non-fatal on failure)
    if (tags.length > 0) {
      incrementTagCounts(tags).catch((err) => {
        console.error("[rooms] Failed to increment tag counts:", err);
      });
    }

    return NextResponse.json({
      room: {
        ...roomDoc,
        id: roomId.toString(),
      },
      membership: {
        ...membershipDoc,
        id: membershipDoc._id.toString(),
      },
    }, { status: 201 });
  } catch (err: any) {
    console.error("Room creation error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET: Discover public rooms with cursor pagination
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const tagsParam = searchParams.get("tags") || "";
    const cursor = searchParams.get("cursor") || "";
    const limit = Math.min(parseInt(searchParams.get("limit") || "10"), 50);

    const query: any = {
      joinPolicy: { $in: ["PUBLIC", "APPROVAL_REQUIRED"] },
      isActive: true,
      isDisabled: { $ne: true },
    };

    // Search filter
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Tag filter (comma-separated, any-match)
    if (tagsParam) {
      const selectedTags = tagsParam
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (selectedTags.length > 0) {
        query.tags = { $in: selectedTags };
      }
    }

    // Cursor pagination mapping
    if (cursor) {
      try {
        query._id = { $lt: new ObjectId(cursor) };
      } catch (err) {
        return NextResponse.json({ error: "Invalid cursor token" }, { status: 400 });
      }
    }

    // Fetch and sort by ID descending (newest first)
    const rooms = await db
      .collection("rooms")
      .find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasNextPage = rooms.length > limit;
    if (hasNextPage) {
      rooms.pop(); // Remove extra record used for page check
    }

    const nextCursor = hasNextPage ? rooms[rooms.length - 1]._id.toString() : null;

    const session = await getCachedSession(req.headers);
    const roomIds = rooms.map((r) => r._id);

    let statusMap = new Map<string, string>();
    let countMap = new Map<string, number>();

    if (rooms.length > 0) {
      const promises: Promise<any>[] = [
        db
          .collection("room_memberships")
          .aggregate<{ _id: ObjectId; count: number }>([
            {
              $match: {
                roomId: { $in: roomIds },
                status: "APPROVED",
                isBlocked: false,
              },
            },
            { $group: { _id: "$roomId", count: { $sum: 1 } } },
          ])
          .toArray(),
      ];

      if (session?.user?.id) {
        promises.push(
          db
            .collection("room_memberships")
            .find({ roomId: { $in: roomIds }, userId: new ObjectId(session.user.id) })
            .project({ roomId: 1, status: 1 })
            .toArray()
        );
      }

      const [memberCounts, memberships] = await Promise.all(promises);

      countMap = new Map(memberCounts.map((row: any) => [row._id.toString(), row.count]));
      if (memberships) {
        statusMap = new Map(memberships.map((m: any) => [m.roomId.toString(), m.status as string]));
      }
    }

    const enrichedRooms = rooms.map((room) => ({
      ...room,
      id: room._id.toString(),
      memberCount: countMap.get(room._id.toString()) ?? 0,
      membershipStatus: statusMap.get(room._id.toString()) ?? null,
    }));

    return NextResponse.json({
      rooms: enrichedRooms,
      nextCursor,
    });
  } catch (err) {
    console.error("Room listing error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
