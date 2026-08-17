import { auth, ensureMongoConnected } from "./auth";

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

type CacheEntry = {
  session: NonNullable<Session>;
  responseHeaders?: Headers;
  timestamp: number;
  expiresAt: number;
};

const sessionCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;
const inFlightSessions = new Map<string, Promise<CachedSessionResult>>();

function getDefaultTtlMs(): number {
  const env = process.env.SESSION_CACHE_TTL_MS;
  if (!env) return 60_000;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function extractSessionCacheKey(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookieParts = cookieHeader.split(";").map((c) => c.trim());

  // Better Auth uses `__Secure-` prefix on cookie names when running over HTTPS
  // (production on Vercel). Without this prefix the lookup returns null and we
  // bail out before ever calling auth.api.getSession, causing 401 on all
  // protected routes even though /api/auth/get-session works fine.
  const findCookie = (name: string) =>
    cookieParts.find((c) => c === name || c.startsWith(`${name}=`));

  const sessionCookie =
    // Production (HTTPS) — __Secure- prefixed names
    findCookie("__Secure-better-auth.session_token") ??
    findCookie("__Secure-better-auth.session-token") ??
    // Development (HTTP) — bare names
    findCookie("better-auth.session_token") ??
    findCookie("better-auth.session-token");

  return sessionCookie ?? null;
}

function parseSessionExpiresAt(session: NonNullable<Session>): number {
  const raw = session?.session?.expiresAt;
  if (!raw) return 0;
  const expiresAt = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}

function isFresh(entry: CacheEntry, now: number): boolean {
  if (now >= entry.expiresAt) return false;
  return now - entry.timestamp < getDefaultTtlMs();
}

function evictStaleEntries(now: number): void {
  if (sessionCache.size <= MAX_CACHE_ENTRIES) return;

  for (const [key, entry] of sessionCache.entries()) {
    if (now - entry.timestamp >= getDefaultTtlMs() || now >= entry.expiresAt) {
      sessionCache.delete(key);
    }
  }
}

export function evictSession(headers: Headers) {
  const cacheKey = extractSessionCacheKey(headers.get("cookie"));
  if (!cacheKey) return;
  sessionCache.delete(cacheKey);
}

export type GetCachedSessionOptions = {
  /** Bypass server cache and Better Auth cookie cache (hits DB). */
  forceRefresh?: boolean;
};

export type CachedSessionResult = {
  session: NonNullable<Session> | null;
  responseHeaders?: Headers;
};

export async function getCachedSession(
  headers: Headers,
  options: GetCachedSessionOptions = {}
): Promise<CachedSessionResult> {
  const cookieHeader = headers.get("cookie");
  // Use the matched session cookie as the cache key; fall back to the full
  // cookie header if no known session-cookie name was found (e.g. if Better
  // Auth changes its naming convention). This ensures we still call
  // auth.api.getSession rather than bailing with null immediately.
  const cacheKey = extractSessionCacheKey(cookieHeader) ?? cookieHeader;
  if (!cacheKey) return { session: null };

  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = sessionCache.get(cacheKey);
    if (cached && isFresh(cached, now)) {
      return { session: cached.session, responseHeaders: cached.responseHeaders };
    }
  } else {
    sessionCache.delete(cacheKey);
  }

  evictStaleEntries(now);

  // Request coalescing: if a DB fetch for this session is already in-flight,
  // await it instead of firing a duplicate getSession query.
  const inFlight = inFlightSessions.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = fetchSessionFromDb(cacheKey, headers);
  inFlightSessions.set(cacheKey, promise);
  void promise.finally(() => {
    inFlightSessions.delete(cacheKey);
  });
  return promise;
}

async function fetchSessionFromDb(cacheKey: string, headers: Headers): Promise<CachedSessionResult> {
  try {
    // Better Auth uses the database for session validation. Ensure MongoDB is connected
    // before calling getSession, otherwise all protected routes can incorrectly 401.
    await ensureMongoConnected();
    // Use returnHeaders so we can propagate Set-Cookie headers (e.g. cookieCache
    // refresh) back to the client via the route handler's response.
    const result = await auth.api.getSession({ headers, returnHeaders: true });
    const session = result?.response ?? null;
    const responseHeaders = result?.headers;

    if (!session?.session || !session?.user) {
      sessionCache.delete(cacheKey);
      return { session: null, responseHeaders };
    }

    const expiresAt = parseSessionExpiresAt(session);
    const timestamp = Date.now();
    sessionCache.set(cacheKey, {
      session,
      responseHeaders,
      timestamp,
      expiresAt,
    });

    return { session, responseHeaders };
  } catch (err) {
    console.error("[cachedSession] Error fetching session:", err);
    return { session: null };
  }
}

// ── Cookie invalidation helpers ──────────────────────────────────────────

const SECURE_COOKIE_PREFIX = "__Secure-";

function getSessionDataCookieName(): string {
  const baseURL =
    process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const isSecure = baseURL.startsWith("https://") || process.env.NODE_ENV === "production";
  const prefix = "better-auth";
  return (isSecure ? SECURE_COOKIE_PREFIX : "") + `${prefix}.session_data`;
}

function getSessionDataCookieAttributes(): Record<string, any> {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "none" as const,
    path: "/",
  };
}

/**
 * Clears the BetterAuth session data cookie (cookieCache) on the response
 * so the next request falls through to the DB for a fresh session.
 * Also evicts the in-memory session cache entry.
 */
export function invalidateSessionDataCookie(response: any, headers: Headers): void {
  evictSession(headers);
  const cookieName = getSessionDataCookieName();
  const attrs = getSessionDataCookieAttributes();
  response.cookies.set(cookieName, "", { ...attrs, maxAge: 0 });
}
