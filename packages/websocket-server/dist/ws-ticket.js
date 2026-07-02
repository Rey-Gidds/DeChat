"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWsTicket = verifyWsTicket;
const crypto_1 = __importDefault(require("crypto"));
function getSecret() {
    const secret = process.env.BETTER_AUTH_SECRET || process.env.WS_TICKET_SECRET;
    if (!secret) {
        throw new Error("BETTER_AUTH_SECRET or WS_TICKET_SECRET must be set");
    }
    return secret;
}
function verifyWsTicket(ticket) {
    const [body, sig] = ticket.split(".");
    if (!body || !sig)
        return null;
    const expected = crypto_1.default
        .createHmac("sha256", getSecret())
        .update(body)
        .digest("base64url");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length ||
        !crypto_1.default.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!payload.userId || !payload.exp)
            return null;
        if (payload.type === "room" && !payload.roomId)
            return null;
        if (Date.now() > payload.exp)
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
