import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { countActiveMembers, getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const room = await db.collection("rooms").findOne({ _id: roomId, isActive: true });
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);
  const memberCount = await countActiveMembers(roomId);

  return NextResponse.json({
    room: {
      id: room._id.toString(),
      name: room.name,
      description: room.description ?? "",
      tags: room.tags ?? [],
      joinPolicy: room.joinPolicy,
      maxMembers: room.maxMembers,
      roomLink: room.roomLink,
      createdAt: room.createdAt,
      isDisabled: room.isDisabled ?? false,
      lastKeyVersion: room.lastKeyVersion ?? 0,
      pendingKeyRotation: room.pendingKeyRotation ?? false,
    },
    memberCount,
    membership: membership
      ? {
          id: membership._id.toString(),
          status: membership.status,
          role: membership.role,
          isBlocked: membership.isBlocked,
          userIndex: (membership as any).userIndex ?? null,
          userId: membership.userId.toString(),
        }
      : null,
  });
}
