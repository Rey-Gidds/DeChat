import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import {
  enrichMembershipUsers,
  type MembershipDoc,
} from "@/lib/membership-db";

export async function GET(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const userId = new ObjectId(authResult.session.user.id);
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const query: Record<string, unknown> = { userId };
  if (status) {
    query.status = status;
  } else {
    query.status = { $in: ["APPROVED", "PENDING"] };
  }

  const memberships = await db
    .collection("room_memberships")
    .find(query)
    .sort({ updatedAt: -1 })
    .toArray() as MembershipDoc[];

  const roomIds = memberships.map((m) => m.roomId);
  const rooms =
    roomIds.length > 0
      ? await db
          .collection("rooms")
          .find({ _id: { $in: roomIds } })
          .toArray()
      : [];

  const roomMap = new Map(rooms.map((r) => [r._id.toString(), r]));
  const enriched = await enrichMembershipUsers(memberships);

  return NextResponse.json({
    memberships: enriched.map((m) => ({
      ...m,
      room: (() => {
        const room = roomMap.get(m.roomId.toString());
        if (!room) return null;
        return {
          name: room.name,
          description: room.description ?? "",
          joinPolicy: room.joinPolicy ?? "PUBLIC",
          maxMembers: room.maxMembers ?? 500,
          memberCount: room.memberCount ?? 0,
          isDisabled: room.isDisabled ?? false,
        };
      })(),
    })),
  });
}
