import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import {
  enrichMembershipUsers,
  isRoomAdmin,
  listPendingRequests,
} from "@/lib/membership-db";

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
  const admin = await isRoomAdmin(roomId, userId);
  if (!admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const pending = await listPendingRequests(roomId);
  const enriched = await enrichMembershipUsers(pending);

  return NextResponse.json({
    requests: enriched.map((r) => ({
      userId: r.userId,
      membershipId: r._id,
      createdAt: r.createdAt,
      status: r.status,
      reviewedBy: (r as any).reviewedBy ?? null,
      reviewedAt: (r as any).reviewedAt ?? null,
      user: r.user
        ? {
            name: r.user.name,
            email: r.user.email,
            publicKey: r.user.publicKey ?? null,
          }
        : null,
    })),
  });
}
