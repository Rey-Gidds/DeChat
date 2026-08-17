import { NextResponse } from "next/server";
import { getCachedSession, invalidateSessionDataCookie, type CachedSessionResult } from "./cachedSession";

export type Session = NonNullable<CachedSessionResult["session"]>;

export type AuthResult =
  | { session: Session; responseHeaders?: Headers }
  | { error: NextResponse };

export type RequireSessionOptions = {
  /** Bypass caches and revalidate session against the database. */
  fresh?: boolean;
};

export async function requireSession(
  req: Request,
  options: RequireSessionOptions = {}
): Promise<AuthResult> {
  const { session, responseHeaders } = await getCachedSession(req.headers, {
    forceRefresh: options.fresh,
  });

  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return { session, responseHeaders };
}

/**
 * Propagates BetterAuth auth response headers (Set-Cookie from cookieCache
 * refresh, etc.) onto a NextResponse. Call this on every response after
 * requireSession / getCachedSession so that cookie updates reach the client.
 */
export function applyAuthHeaders(
  response: NextResponse,
  headers?: Headers
): NextResponse {
  if (!headers) return response;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      response.headers.append("set-cookie", value);
    } else {
      response.headers.set(key, value);
    }
  });
  return response;
}

/**
 * Clears the in-memory session cache and the BetterAuth session data cookie
 * so the next request fetches a fresh session from the database. Call this
 * after any mutation that changes user profile fields stored in the session
 * (name, pfp, publicKey, encryptionEnabled).
 */
export function invalidateCachedSession(response: NextResponse, req: Request): NextResponse {
  invalidateSessionDataCookie(response, req.headers);
  return response;
}
