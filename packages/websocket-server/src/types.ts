import type { Socket } from "socket.io";

export interface MembershipCacheEntry {
  valid: boolean;
  expiresAt: number;
}

export type AuthedSocket = Socket & {
  data: {
    userId: string;
    roomId?: string;
    subscribedRooms: Set<string>;
    membershipCache: Map<string, MembershipCacheEntry>;
  };
};
