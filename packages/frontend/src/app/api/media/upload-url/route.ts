import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";
import { db } from "@/lib/auth";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10 MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB

const UploadUrlRequestSchema = z.object({
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  roomId: z.string().min(1),
});

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured");
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

export async function POST(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;
  const userId = new ObjectId(authResult.session.user.id);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UploadUrlRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { mimeType, size, roomId: roomIdParam } = parsed.data;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  // Validate room exists and is active
  const room = await db.collection("rooms").findOne(
    { _id: roomId, isActive: true },
    { projection: { isDisabled: 1 } }
  );
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  if (room.isDisabled) {
    return NextResponse.json({ error: "Room is disabled" }, { status: 409 });
  }

  // Validate active APPROVED membership
  const membership = await getMembership(roomId, userId);
  if (
    !membership ||
    membership.status !== "APPROVED" ||
    membership.isBlocked
  ) {
    return NextResponse.json(
      { error: "Active room membership required" },
      { status: 403 }
    );
  }

  // Size limits based on MIME type
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  if (!isImage && !isVideo) {
    return NextResponse.json(
      { error: "Unsupported media type. Only images and videos are allowed." },
      { status: 400 }
    );
  }

  if (isImage && size > MAX_IMAGE_SIZE) {
    return NextResponse.json(
      { error: "Image size exceeds 10 MB limit" },
      { status: 413 }
    );
  }
  if (isVideo && size > MAX_VIDEO_SIZE) {
    return NextResponse.json(
      { error: "Video size exceeds 100 MB limit" },
      { status: 413 }
    );
  }

  // Generate object key (random UUID — no user/room metadata)
  const objectKey = crypto.randomUUID();

  // Generate presigned PUT URL
  const bucketName = process.env.R2_BUCKET_NAME || "dechat-media";

  try {
    const s3 = getR2Client();
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: "application/octet-stream",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes

    return NextResponse.json({
      uploadUrl,
      objectKey,
    });
  } catch (err) {
    console.error("[media/upload-url] Failed to generate presigned URL:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL. Check R2 configuration." },
      { status: 500 }
    );
  }
}
