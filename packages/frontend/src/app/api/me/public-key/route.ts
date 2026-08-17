import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession, applyAuthHeaders, invalidateCachedSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";

export async function POST(req: Request) {
  try {
    await ensureMongoConnected();
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;

    const body = await req.json().catch(() => ({}));
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey.trim() : "";

    if (!publicKey) {
      return NextResponse.json({ error: "publicKey is required" }, { status: 400 });
    }

    const userId = new ObjectId(authResult.session.user.id);
    const result = await db.collection("user").updateOne(
      { _id: userId },
      { $set: { publicKey, encryptionEnabled: true } },
      { upsert: true }
    );

    if (result.matchedCount === 0 && result.upsertedCount === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Invalidate cached session so the next request sees the updated publicKey.
    return invalidateCachedSession(
      NextResponse.json({ ok: true, publicKey }),
      req
    );
  } catch (err) {
    console.error("Public key update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
