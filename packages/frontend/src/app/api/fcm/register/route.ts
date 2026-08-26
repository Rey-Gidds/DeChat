import { NextResponse } from "next/server";
import { getCachedSession } from "@/lib/cachedSession";
import { applyAuthHeaders } from "@/lib/api-auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

// POST /api/fcm/register — saves or updates user's FCM push token
export async function POST(req: Request) {
  try {
    const { session, responseHeaders } = await getCachedSession(req.headers);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { token } = body;

    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    const db = await getDb();
    const userIdObj = new ObjectId(session.user.id);

    await db.collection("fcm_tokens").updateOne(
      { userId: userIdObj, token },
      {
        $set: {
          userId: userIdObj,
          token,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return applyAuthHeaders(
      NextResponse.json({ ok: true }),
      responseHeaders
    );
  } catch (err) {
    console.error("[fcm/register] Error registering token:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
