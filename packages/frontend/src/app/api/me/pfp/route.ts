import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:(image\/[\w+]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];
  return { mime, buffer: Buffer.from(base64, "base64") };
}

export async function POST(req: Request) {
  try {
    await ensureMongoConnected();
    const authResult = await requireSession(req);
    if ("error" in authResult) return authResult.error;

    const body = await req.json().catch(() => ({}));
    const image = typeof body?.image === "string" ? body.image.trim() : "";

    if (!image) {
      return NextResponse.json({ error: "image is required" }, { status: 400 });
    }

    const parsed = parseDataUrl(image);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid image data URL format" }, { status: 400 });
    }

    if (!ALLOWED_MIME_TYPES.includes(parsed.mime)) {
      return NextResponse.json(
        { error: "Only JPEG, PNG, GIF, and WebP images are allowed" },
        { status: 400 }
      );
    }

    if (parsed.buffer.length > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Image must be under 1 MB" },
        { status: 400 }
      );
    }

    const userId = new ObjectId(authResult.session.user.id);
    const result = await db.collection("user").updateOne(
      { _id: userId },
      { $set: { pfp: image } }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, pfp: image });
  } catch (err) {
    console.error("PFP upload error:", err);
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
      { $unset: { pfp: "" } }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PFP delete error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
