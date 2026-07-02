import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";

const USERNAME_MAX = 20;
const USERNAME_REGEX = /^[a-zA-Z0-9_ ]+$/;

export async function GET(req: Request) {
  await ensureMongoConnected();
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const userId = new ObjectId(authResult.session.user.id);
  const user = await db.collection("user").findOne(
    { _id: userId },
    { projection: { name: 1, email: 1, image: 1, publicKey: 1, pfp: 1 } }
  );

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: userId.toString(),
    name: user.name ?? authResult.session.user.name,
    email: user.email ?? authResult.session.user.email,
    image: user.image ?? null,
    publicKey: (user.publicKey as string | undefined) ?? null,
    pfp: (user.pfp as string | undefined) ?? null,
  });
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

    return NextResponse.json({ ok: true, name });
  } catch (err) {
    console.error("Profile update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
