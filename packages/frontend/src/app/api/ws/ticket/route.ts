import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requireSession, applyAuthHeaders } from "@/lib/api-auth";
import { parseObjectId } from "@/lib/models";
import { getMembership } from "@/lib/membership-db";
import { createWsTicket } from "@/lib/ws-ticket";
import { z } from "zod";

const TicketRequestSchema = z.object({
  roomId: z.string().min(1),
});

export async function POST(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  const body = await req.json();
  const parsed = TicketRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const roomId = parseObjectId(parsed.data.roomId);
  if (!roomId) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const userId = new ObjectId(authResult.session.user.id);
  const membership = await getMembership(roomId, userId);

  if (
    !membership ||
    membership.status !== "APPROVED" ||
    membership.isBlocked
  ) {
    return NextResponse.json(
      { error: "Active room membership required" },
      { status: 403 }
    );
  }

  const ticket = createWsTicket(authResult.session.user.id, roomId.toString());

  return applyAuthHeaders(NextResponse.json({
    ticket,
    expiresInMs: 60_000,
    wsUrl: process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001",
  }), authResult.responseHeaders);
}
