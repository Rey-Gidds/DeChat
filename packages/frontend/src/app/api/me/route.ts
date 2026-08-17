import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession, applyAuthHeaders, invalidateCachedSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";

const USERNAME_MAX = 20;
const USERNAME_REGEX = /^[a-zA-Z0-9_ ]+$/;

export async function GET(req: Request) {
  await ensureMongoConnected();
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const user = authResult.session.user;

  return applyAuthHeaders(
    NextResponse.json({
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: (user.image as string | undefined) ?? null,
      publicKey: (user.publicKey as string | undefined) ?? null,
      pfp: (user.pfp as string | undefined) ?? null,
      encryptionEnabled: (user.encryptionEnabled as boolean | undefined) ?? false,
    }),
    authResult.responseHeaders
  );
}

export async function PATCH(req: Request) {
  try {
    await ensureMongoConnected();
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;

    const body = await req.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : undefined;

    if (name === undefined) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    if (name.length === 0 || name.length > USERNAME_MAX) {
      return NextResponse.json(
        { error: `Name must be between 1 and ${USERNAME_MAX} characters` },
        { status: 400 }
      );
    }

    if (!USERNAME_REGEX.test(name)) {
      return NextResponse.json(
        { error: "Name can only contain letters, numbers, spaces, and underscores" },
        { status: 400 }
      );
    }

    const userId = new ObjectId(authResult.session.user.id);
    const result = await db.collection("user").updateOne(
      { _id: userId },
      { $set: { name } }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Invalidate cached session (in-memory + cookieCache) so the next
    // request gets the updated name from the database.
    return invalidateCachedSession(
      NextResponse.json({ ok: true, name }),
      req
    );
  } catch (err) {
    console.error("Profile update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
