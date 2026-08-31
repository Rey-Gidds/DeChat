import { auth, ensureMongoConnected } from "./auth";
import { Redis } from "@upstash/redis";

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

type RedisCacheEntry = {
  session: NonNullable<Session>;
  serializedHeaders?: [string, string][];
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

if (!redis) {
  console.warn("[cachedSession] Warning: Redis is not configured. Session caching is disabled.");
}

const inFlightSessions = new Map<string, Promise<CachedSessionResult>>();

function getRedisKey(cacheKey: string): string {
  return `session:${cacheKey}`;
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

export async function evictSession(headers: Headers) {
  const cacheKey = extractSessionCacheKey(headers.get("cookie"));
  if (!cacheKey) return;
  if (redis) {
    try {
      await redis.del(getRedisKey(cacheKey));
    } catch (err) {
      console.error("[cachedSession] Error evicting session from Redis:", err);
    }
  }
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

  if (!options.forceRefresh) {
    if (redis) {
      try {
        const cachedRaw = await redis.get<string | RedisCacheEntry>(getRedisKey(cacheKey));
        if (cachedRaw) {
          let entry: RedisCacheEntry;
          if (typeof cachedRaw === "string") {
            entry = JSON.parse(cachedRaw);
          } else {
            entry = cachedRaw;
          }
          const responseHeaders = entry.serializedHeaders
            ? new Headers(entry.serializedHeaders)
            : undefined;
          return { session: entry.session, responseHeaders };
        }
      } catch (err) {
        console.error("[cachedSession] Error fetching cached session from Redis:", err);
      }
    }
  } else {
    if (redis) {
      try {
        await redis.del(getRedisKey(cacheKey));
      } catch (err) {
        console.error("[cachedSession] Error clearing session from Redis on forceRefresh:", err);
      }
    }
  }

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
      if (redis) {
        try {
          await redis.del(getRedisKey(cacheKey));
        } catch (err) {
          console.error("[cachedSession] Error evicting invalid session from Redis:", err);
        }
      }
      return { session: null, responseHeaders };
    }

    const expiresAt = parseSessionExpiresAt(session);
    const now = Date.now();
    const timeToSessionExpirySec = Math.floor((expiresAt - now) / 1000);
    // Redis cache TTL of 5 minutes (300 seconds) capped by the session's actual expiry
    const cacheTtlSec = Math.min(300, Math.max(0, timeToSessionExpirySec));

    if (cacheTtlSec > 0 && redis) {
      const entry: RedisCacheEntry = {
        session,
        serializedHeaders: responseHeaders ? Array.from(responseHeaders.entries()) : undefined,
      };
      try {
        await redis.set(getRedisKey(cacheKey), JSON.stringify(entry), { ex: cacheTtlSec });
      } catch (err) {
        console.error("[cachedSession] Error saving session to Redis:", err);
      }
    }

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
 * Also evicts the session cache entry.
 */
export function invalidateSessionDataCookie(response: any, headers: Headers): void {
  void evictSession(headers);
  const cookieName = getSessionDataCookieName();
  const attrs = getSessionDataCookieAttributes();
  response.cookies.set(cookieName, "", { ...attrs, maxAge: 0 });
}
