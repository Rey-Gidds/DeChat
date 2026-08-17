import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { ensureMongoConnected } from "@/lib/mongodb";

const ENVELOPE_LIMIT = 128 * 1024;
const ENVELOPE_VERSION = 1;

function isEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.version === ENVELOPE_VERSION &&
    envelope.algorithm === "AES-256-GCM" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ciphertext === "string" &&
    envelope.iv.length <= 128 &&
    envelope.ciphertext.length <= ENVELOPE_LIMIT
  );
}

function publicStatus(record: Record<string, unknown> | null) {
  return {
    configured: Boolean(record),
    version: typeof record?.version === "number" ? record.version : null,
    updatedAt: record?.updatedAt ?? null,
  };
}

async function getUserRecord(req: Request) {
  await ensureMongoConnected();
  const authResult = await requireSession(req, { fresh: true });
  if ("error" in authResult) return authResult;
  return { ...authResult, userId: new ObjectId(authResult.session.user.id) };
}

export async function GET(req: Request) {
  try {
    const result = await getUserRecord(req);
    if ("error" in result) return result.error;
    const record = await db.collection("user-encryption").findOne({ userId: result.userId });
    if (!record) return NextResponse.json({ configured: false, keyEnvelope: null, recoveryEnvelope: null });
    return NextResponse.json({
      ...publicStatus(record),
      keyEnvelope: record.keyEnvelope,
      recoveryEnvelope: record.recoveryEnvelope,
    });
  } catch (error) {
    console.error("Key envelope fetch error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function writeEnvelopes(req: Request, replace: boolean) {
  const result = await getUserRecord(req);
  if ("error" in result) return result.error;
  const body = await req.json().catch(() => ({}));
  const keyEnvelope = body?.keyEnvelope;
  const recoveryEnvelope = body?.recoveryEnvelope;
  const expectedVersion = body?.expectedVersion;

  if (!isEnvelope(keyEnvelope) || !isEnvelope(recoveryEnvelope)) {
    return NextResponse.json({ error: "Invalid encryption envelopes" }, { status: 400 });
  }
  if (typeof body?.publicKey !== "string" || body.publicKey.length === 0 || body.publicKey.length > ENVELOPE_LIMIT) {
    return NextResponse.json({ error: "publicKey is required" }, { status: 400 });
  }
  if (replace && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    return NextResponse.json({ error: "expectedVersion is required" }, { status: 400 });
  }

  const now = new Date();
  const filter = replace
    ? { userId: result.userId, version: expectedVersion }
    : { userId: result.userId };
  const update = {
    $set: {
      keyEnvelope,
      recoveryEnvelope,
      version: replace ? expectedVersion + 1 : 1,
      updatedAt: now,
    },
    $setOnInsert: { userId: result.userId, createdAt: now },
  };
  const write = await db.collection("user-encryption").updateOne(filter, update, { upsert: !replace });
  if (replace && write.matchedCount !== 1) {
    return NextResponse.json({ error: "Encryption record changed; reload and retry" }, { status: 409 });
  }
  if (!replace && write.upsertedCount !== 1) {
    return NextResponse.json({ error: "Encryption is already configured" }, { status: 409 });
  }
  await db.collection("user").updateOne(
    { _id: result.userId },
    { $set: { publicKey: body.publicKey, encryptionEnabled: true } }
  );
  return NextResponse.json({ ok: true, version: replace ? expectedVersion + 1 : 1 });
}

export async function POST(req: Request) {
  try {
    return await writeEnvelopes(req, false);
  } catch (error) {
    console.error("Key envelope creation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    return await writeEnvelopes(req, true);
  } catch (error) {
    console.error("Key envelope replacement error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
