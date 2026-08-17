import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession, applyAuthHeaders } from "@/lib/api-auth";

export async function GET(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const userId = new ObjectId(authResult.session.user.id);
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const query: Record<string, unknown> = { userId };
  if (status) query.status = status;
  else query.status = { $in: ["PENDING", "APPROVED", "REJECTED"] };

  const memberships = await db
    .collection("room_memberships")
    .find(query)
    .sort({ updatedAt: -1 })
    .project({
      roomId: 1,
      status: 1,
      createdAt: 1,
      reviewedBy: 1,
      reviewedAt: 1,
    })
    .toArray();

  const roomIds = memberships.map((m: any) => m.roomId).filter(Boolean);
  const rooms =
    roomIds.length > 0
      ? await db
          .collection("rooms")
          .find({ _id: { $in: roomIds } })
          .project({ name: 1, joinPolicy: 1, roomLink: 1, isDisabled: 1 })
          .toArray()
      : [];

  const roomMap = new Map(rooms.map((r: any) => [r._id.toString(), r]));

  return applyAuthHeaders(NextResponse.json({
    requests: memberships.map((m: any) => {
      const room = roomMap.get(m.roomId.toString()) ?? null;
      return {
        roomId: m.roomId.toString(),
        status: m.status,
        requestedAt: m.createdAt,
        reviewedBy: m.reviewedBy ? m.reviewedBy.toString() : null,
        reviewedAt: m.reviewedAt ?? null,
        room: room
          ? {
              id: room._id.toString(),
              name: room.name,
              joinPolicy: room.joinPolicy ?? null,
              roomLink: room.roomLink ?? null,
              isDisabled: room.isDisabled ?? false,
            }
          : null,
      };
    }),
  }), authResult.responseHeaders);
}

