import { NextResponse } from "next/server";
import { getCachedSession } from "@/lib/cachedSession";
import { applyAuthHeaders } from "@/lib/api-auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

// GET /api/unread-counts — returns all unread counters with room names for auth'd user
// roomName is included so the service worker can display notifications without
// access to the in-memory SWR cache.
export async function GET(req: Request) {
  try {
    const { session, responseHeaders } = await getCachedSession(req.headers);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const counters = await db.collection("unread_counters")
      .find({ userId: new ObjectId(session.user.id) })
      .project({ roomId: 1, unreadCount: 1, version: 1, lastMessageTimestamp: 1, _id: 0 })
      .toArray();

    if (!counters.length) {
      return applyAuthHeaders(NextResponse.json({ counts: [] }), responseHeaders);
    }

    // Fetch room names in a single query so the SW can use them for notification titles
    const roomIds = counters.map((c: any) => new ObjectId(c.roomId));
    const rooms = await db.collection("rooms")
      .find({ _id: { $in: roomIds } })
      .project({ _id: 1, name: 1 })
      .toArray();

    const roomNameMap = new Map<string, string>(
      rooms.map((r: any) => [r._id.toString(), r.name ?? "DeChat Room"])
    );

    return applyAuthHeaders(NextResponse.json({
      counts: counters.map((c: any) => ({
        roomId: c.roomId.toString(),
        roomName: roomNameMap.get(c.roomId.toString()) ?? "DeChat Room",
        unreadCount: c.unreadCount,
        version: c.version,
        lastMessageTimestamp: c.lastMessageTimestamp?.getTime() ?? 0,
      })),
    }), responseHeaders);
  } catch (err) {
    console.error("[unread-counts] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
