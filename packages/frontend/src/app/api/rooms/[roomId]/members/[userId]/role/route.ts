import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { db } from "@/lib/auth";
import { requireSession } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";

type RouteContext = { params: Promise<{ roomId: string; userId: string }> };

type NewRole = "ADMIN" | "MEMBER" | "OWNER";

// Business rules enforced here:
// - Only OWNER can transfer ownership or demote an ADMIN to MEMBER.
// - OWNER and ADMIN can promote a MEMBER to ADMIN.
// - An ADMIN cannot be demoted by another ADMIN.
// - The owner's role cannot be demoted by anyone except themselves via transfer.
// - Transfer of ownership atomically demotes the old owner to ADMIN.

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const { roomId: roomIdParam, userId: targetParam } = await context.params;
  const roomId = parseObjectId(roomIdParam);
  const targetUserId = parseObjectId(targetParam);

  if (!roomId || !targetUserId) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newRole = body.role as NewRole | undefined;
  if (!newRole || !["ADMIN", "MEMBER", "OWNER"].includes(newRole)) {
    return NextResponse.json({ error: "role must be ADMIN, MEMBER, or OWNER" }, { status: 400 });
  }

  const callerId = new ObjectId(authResult.session.user.id);

  if (callerId.equals(targetUserId)) {
    return NextResponse.json({ error: "Cannot change your own role this way" }, { status: 400 });
  }

  const [callerMembership, targetMembership] = await Promise.all([
    getMembership(roomId, callerId),
    getMembership(roomId, targetUserId),
  ]);

  if (!callerMembership || callerMembership.status !== "APPROVED" || callerMembership.isBlocked) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!targetMembership || targetMembership.status !== "APPROVED" || targetMembership.isBlocked) {
    return NextResponse.json({ error: "Target user is not an active member" }, { status: 404 });
  }

  const callerRole = callerMembership.role;
  const targetRole = targetMembership.role;

  // --- Permission matrix ---
  if (newRole === "OWNER") {
    // Only OWNER can transfer ownership
    if (callerRole !== "OWNER") {
      return NextResponse.json({ error: "Only the room owner can transfer ownership" }, { status: 403 });
    }
    // Cannot transfer ownership to another OWNER (there can only be one)
    if (targetRole === "OWNER") {
      return NextResponse.json({ error: "Target is already the owner" }, { status: 400 });
    }
  } else if (newRole === "ADMIN") {
    // OWNER or ADMIN can promote MEMBER -> ADMIN
    if (callerRole !== "OWNER" && callerRole !== "ADMIN") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    if (targetRole === "OWNER") {
      return NextResponse.json({ error: "Cannot change the owner's role" }, { status: 403 });
    }
    if (targetRole === "ADMIN") {
      return NextResponse.json({ error: "User is already an admin" }, { status: 400 });
    }
  } else if (newRole === "MEMBER") {
    // Only OWNER can demote ADMIN -> MEMBER
    if (callerRole !== "OWNER") {
      return NextResponse.json({ error: "Only the room owner can demote admins" }, { status: 403 });
    }
    if (targetRole === "OWNER") {
      return NextResponse.json({ error: "Cannot demote the owner" }, { status: 403 });
    }
    if (targetRole === "MEMBER") {
      return NextResponse.json({ error: "User is already a member" }, { status: 400 });
    }
  }

  const now = new Date();

  if (newRole === "OWNER") {
    // Atomic ownership transfer: promote target, demote current owner
    await db.collection("room_memberships").updateOne(
      { _id: targetMembership._id },
      { $set: { role: "OWNER", updatedAt: now } }
    );
    await db.collection("room_memberships").updateOne(
      { _id: callerMembership._id },
      { $set: { role: "ADMIN", updatedAt: now } }
    );
  } else {
    await db.collection("room_memberships").updateOne(
      { _id: targetMembership._id },
      { $set: { role: newRole, updatedAt: now } }
    );
  }

  return NextResponse.json({ ok: true });
}
