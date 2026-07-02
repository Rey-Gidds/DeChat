import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import {
  enrichMembershipUsers,
  getMembership,
  type MembershipDoc,
} from "@/lib/membership-db";
import { db } from "@/lib/auth";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const viewerMembership = await getMembership(roomId, userId);

  if (
    !viewerMembership ||
    viewerMembership.status !== "APPROVED" ||
    viewerMembership.isBlocked
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Improvement: Implement the caching for the members list to avoid repeated hits to the database.
  const members = await Promise.resolve().then(async () => {
    return await db
    .collection("room_memberships")
    .find({ roomId, status: "APPROVED", isBlocked: false })
      .sort({ joinedAt: 1 })
      .toArray() as MembershipDoc[];
  }).catch((error) => {
    console.error("Error querying members:", error);
    return [];
  });

  const enriched = await enrichMembershipUsers(members);

  // Resolve online presence from the WebSocket server (in-memory).
  let onlineUserIds: Set<string> = new Set();
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;

  if (secret) {
    try {
      const presenceRes = await fetch(
        `${wsUrl}/internal/presence?roomId=${roomIdParam}`,
        {
          headers: { "x-internal-secret": secret },
          // Timeout quickly so slow presence doesn't block the member list.
          signal: AbortSignal.timeout(2_000),
        }
      );
      if (presenceRes.ok) {
        const body = await presenceRes.json();
        onlineUserIds = new Set<string>(body.onlineUserIds ?? []);
      }
    } catch {
      // Presence is best-effort; fall back to all-offline.
    }
  }

  return NextResponse.json({
    members: enriched.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      isOnline: onlineUserIds.has(m.userId.toString()),
      userIndex: (m as any).userIndex ?? null,
      user: m.user
        ? {
            name: m.user.name,
            email: m.user.email,
            image: m.user.image,
            publicKey: m.user.publicKey,
          }
        : null,
    })),
  });
}
