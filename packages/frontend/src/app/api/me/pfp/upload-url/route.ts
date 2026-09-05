import { NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { requireSession } from "@/lib/api-auth";

const MAX_PFP_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const PRESIGN_TTL_SECONDS = 300; // 5 minutes

const RequestSchema = z.object({
  mimeType: z.string().refine((v) => ALLOWED_MIME_TYPES.includes(v), {
    message: "Only JPEG, PNG, GIF, and WebP images are allowed",
  }),
  size: z.number().int().positive().max(MAX_PFP_SIZE, "Image must be under 2 MB"),
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
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function POST(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { mimeType, size } = parsed.data;
  const bucketName = process.env.R2_BUCKET_NAME || "dechat-media";
  // Avatars live under a dedicated prefix for easy lifecycle management
  const objectKey = `avatars/${crypto.randomUUID()}`;

  try {
    const s3 = getR2Client();
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: mimeType,
      ContentLength: size,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
    return NextResponse.json({ uploadUrl, objectKey });
  } catch (err) {
    console.error("[pfp/upload-url] Failed to generate presigned URL:", err);
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
  }
}
