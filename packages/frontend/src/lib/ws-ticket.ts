import crypto from "crypto";

const TICKET_TTL_MS = 60_000;

export interface WsTicketPayload {
  userId: string;
  roomId?: string;
  exp: number;
  type?: "room" | "user";
}

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.WS_TICKET_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET or WS_TICKET_SECRET must be set");
  }
  return secret;
}

export function createWsTicket(userId: string, roomId: string): string {
  const payload: WsTicketPayload = {
    userId,
    roomId,
    exp: Date.now() + TICKET_TTL_MS,
    type: "room",
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function createUserWsTicket(userId: string): string {
  const payload: WsTicketPayload = {
    userId,
    exp: Date.now() + TICKET_TTL_MS,
    type: "user",
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifyWsTicket(ticket: string): WsTicketPayload | null {
  const [body, sig] = ticket.split(".");
  if (!body || !sig) return null;

  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as WsTicketPayload;

    if (!payload.userId || !payload.exp) return null;
    if (payload.type === "room" && !payload.roomId) return null;
    if (Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}
