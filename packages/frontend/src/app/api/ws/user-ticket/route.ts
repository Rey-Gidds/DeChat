import { NextResponse } from "next/server";
import { requireSession, applyAuthHeaders } from "@/lib/api-auth";
import { createUserWsTicket } from "@/lib/ws-ticket";

export async function POST(req: Request) {
  const authResult = await requireSession(req);
  if ("error" in authResult) return authResult.error;

  return applyAuthHeaders(NextResponse.json({
    ticket: createUserWsTicket(authResult.session.user.id),
    expiresInMs: 60_000,
    wsUrl: process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001",
  }), authResult.responseHeaders);
}

