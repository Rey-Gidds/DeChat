import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "@/lib/auth";
import { requireSession, invalidateCachedSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";
import type { PfpMetadata } from "@/lib/models";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Confirms a completed direct upload to R2 and persists metadata to the user document
const ConfirmSchema = z.object({
  objectKey: z.string().min(1).startsWith("avatars/"),
  mimeType: z.string().refine((v) => ALLOWED_MIME_TYPES.includes(v), {
    message: "Invalid image type",
  }),
  size: z.number().int().positive(),
});

export async function POST(req: Request) {
  try {
    await ensureMongoConnected();
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = ConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { objectKey, mimeType, size } = parsed.data;

    const pfp: PfpMetadata = {
      type: "avatar",
      objectKey,
      mimeType,
      size,
      updatedAt: new Date().toISOString(),
    };

    const userId = new ObjectId(authResult.session.user.id);
    const result = await db.collection("user").updateOne(
      { _id: userId },
      {
        $set: { pfp },
        // Clear migration flag once user uploads a new pfp
        $unset: { pfpNeedsReupload: "" },
      }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return invalidateCachedSession(NextResponse.json({ ok: true, pfp }), req);
  } catch (err) {
    console.error("[pfp/confirm] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureMongoConnected();
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;

    const userId = new ObjectId(authResult.session.user.id);
    await db.collection("user").updateOne(
      { _id: userId },
      { $set: { pfp: null } }
    );

    return invalidateCachedSession(NextResponse.json({ ok: true }), req);
  } catch (err) {
    console.error("[pfp/delete] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
