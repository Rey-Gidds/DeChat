import { NextResponse } from "next/server";
import { getCachedSession } from "@/lib/cachedSession";
import { applyAuthHeaders } from "@/lib/api-auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

// GET /api/unread-counts — returns all unread counters for auth'd user
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

    return applyAuthHeaders(NextResponse.json({
      counts: counters.map((c: any) => ({
        roomId: c.roomId.toString(),
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
