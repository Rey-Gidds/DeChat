import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { countActiveMembers, getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string }> };

async function notifyRoomMetadata(roomId: string, payload: Record<string, unknown>) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";
  const secret =
    process.env.INTERNAL_WS_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.WS_TICKET_SECRET;
  if (!secret) return;

  await fetch(`${wsUrl}/internal/room-metadata-updated`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

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

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);

  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN") || membership.status !== "APPROVED") {
    return NextResponse.json({ error: "Only room owners or admins can update details" }, { status: 403 });
  }

  let body: { name?: string; description?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updateFields: Record<string, any> = {};
  if (typeof body.name === "string" && body.name.trim().length > 0) {
    updateFields.name = body.name.trim();
  }
  if (typeof body.description === "string") {
    updateFields.description = body.description.trim();
  }

  if (Object.keys(updateFields).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updateFields.updatedAt = new Date();

  await db.collection("rooms").updateOne({ _id: roomId }, { $set: updateFields });

  await notifyRoomMetadata(roomId.toString(), {
    roomId: roomId.toString(),
    newName: updateFields.name,
    description: updateFields.description,
  });

  return NextResponse.json({ ok: true, room: updateFields });
}
