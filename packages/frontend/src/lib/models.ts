import { z } from "zod";
import { ObjectId } from "mongodb";

export * from "./pfp";

export const CreateRoomSchema = z.object({
  name: z
    .string()
    .min(3, "Room name must be at least 3 characters")
    .max(50, "Room name must not exceed 50 characters"),
  description: z
    .string()
    .max(200, "Description must not exceed 200 characters")
    .optional(),
  tags: z.array(z.string()).max(5, "Maximum of 5 tags allowed").default([]),
  joinPolicy: z.enum(["PUBLIC", "APPROVAL_REQUIRED", "PRIVATE"]).default("PUBLIC"),
  maxMembers: z
    .number()
    .int()
    .min(2, "Room must have at least 2 members")
    .max(500, "Maximum 500 members allowed per room")
    .default(500),
});

export type CreateRoomInput = z.infer<typeof CreateRoomSchema>;

export const MembershipStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "LEFT",
]);

export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const UploadWrappedRoomKeySchema = z.object({
  encryptedRoomKey: z
    .string()
    .min(1, "encryptedRoomKey is required")
    .max(8192, "encryptedRoomKey payload too large"),
});

export const ApproveJoinRequestSchema = z.object({
  encryptedRoomKey: z
    .string()
    .min(1, "encryptedRoomKey is required")
    .max(8192, "encryptedRoomKey payload too large"),
});

export const InitKeyVersionSchema = z.object({
  encryptedKey: z
    .string()
    .min(1, "encryptedKey is required")
    .max(8192, "encryptedKey payload too large"),
});

export const ClaimRotationSchema = z.object({
  version: z.number().int().min(0),
});

export const CompleteRotationSchema = z.object({
  version: z.number().int().min(0),
  distributions: z.array(
    z.object({
      userId: z.string().min(1),
      encryptedKey: z.string().min(1).max(8192),
    })
  ),
});

export const SyncKeyVersionSchema = z.object({
  keyVersion: z.number().int().min(0),
});

export interface Room {
  _id: ObjectId;
  name: string;
  description?: string;
  creatorId: ObjectId;
  tags: string[];
  joinPolicy: "PUBLIC" | "APPROVAL_REQUIRED" | "PRIVATE";
  maxMembers: number;
  memberCount: number;
  roomLink: string;
  createdAt: Date;
  isActive: boolean;
  isDisabled?: boolean;
  nextUserIndex?: number;
  pendingKeyRotation?: boolean;
  lastKeyVersion?: number;
  latestMessageId?: string;
  latestMessageCreatedAt?: Date;
}

export interface RoomMembership {
  _id: ObjectId;
  userId: ObjectId;
  roomId: ObjectId;
  status: MembershipStatus;
  joinedAt?: Date;
  leftAt?: Date;
  lastVisitedAt: Date;
  role: "OWNER" | "ADMIN" | "MEMBER";
  userIndex?: number | null;
  reviewedBy?: ObjectId | null;
  reviewedAt?: Date | null;
  isBlocked: boolean;
  kickoutCount: number;
  currentKeyVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ImageMetadata {
  type: "image";
  objectKey: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
  iv: string;
  caption?: string;
  localUrl?: string;
}

export interface VideoMetadata {
  type: "video";
  objectKey: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
  thumbnailKey: string;
  thumbnailIv: string;
  duration?: number;
  iv: string;
  caption?: string;
  // Per-chunk IV map for progressive streaming (Phase D+).
  // Absent for old messages and single-chunk uploads.
  ivBase?: string;
  chunkSize?: number;
  chunkIvMap?: string[];
  localUrl?: string;
}

export interface AudioMetadata {
  type: "audio";
  objectKey: string;
  mimeType: string;
  size: number;
  duration?: number;
  iv: string;
  chunkSize?: number;
  chunkIvMap?: string[];
  caption?: string;
  localUrl?: string;
}

export type MediaMetadata = ImageMetadata | VideoMetadata | AudioMetadata;

export interface GifMetadata {
  type: "gif";
  gifId: string;
  gifUrl: string;
  previewUrl: string;
  fallbackUrl: string;
  width: number;
  height: number;
  size: number;
  title?: string;
}

export interface ReplyToInfo {
  messageId: string;
  senderId: string;
  senderName: string;
  senderUserIndex: number | null;
  messageType: "text" | "image" | "video" | "gif" | "audio";
  previewIv: string | null;
  previewCiphertext: string | null;
  previewAuthTag: string | null;
  /** Key version used to encrypt the preview. Missing for old messages — falls back to current key. */
  previewKeyVersion?: number;
}

export interface RoomMessage {
  _id: ObjectId;
  roomId: ObjectId;
  senderId: ObjectId;
  ciphertext: string;
  iv: string;
  authTag: string;
  messageType: "text" | "image" | "video" | "gif" | "audio";
  roomKeyVersion?: number;
  replyTo?: ReplyToInfo | null;
  editedAt?: Date | null;
  createdAt: Date;
}

export interface RoomKeyVersion {
  _id: ObjectId;
  roomId: ObjectId;
  version: number;
  createdBy: ObjectId | null;
  createdAt: Date;
  reason: "CREATED" | "MEMBER_LEFT" | "MEMBER_KICKED";
  triggerUserId?: ObjectId;
  lockOwner?: ObjectId;
  lockExpiry?: Date;
  status: "ACTIVE" | "GENERATING" | "DISTRIBUTING" | "COMPLETE" | "FAILED";
}

export interface RoomKeyDistribution {
  _id: ObjectId;
  roomId: ObjectId;
  keyVersion: number;
  userId: ObjectId;
  encryptedKey: string;
  distributedAt: Date;
}

// Converts the string into the ObjectId in a safe manner
export function parseObjectId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}
