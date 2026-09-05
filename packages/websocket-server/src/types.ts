import type { Socket } from "socket.io";

export interface MembershipCacheEntry {
  valid: boolean;
  expiresAt: number;
}

export type AuthedSocket = Socket & {
  data: {
    userId: string;
    roomId?: string;
    viewingRoomId?: string;
    subscribedRooms: Set<string>;
    membershipCache: Map<string, MembershipCacheEntry>;
  };
};

// Profile picture metadata stored in R2 object storage.
// Replaces the legacy base64 string on user.pfp.
export interface PfpMetadata {
  type: "avatar";
  objectKey: string;
  mimeType: string;
  size: number;
  updatedAt: string;
}
