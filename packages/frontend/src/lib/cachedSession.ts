import { auth, ensureMongoConnected } from "./auth";

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

type CacheEntry = {
  session: Session;
  timestamp: number;
  expiresAt: number;
};

const sessionCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;

function getDefaultTtlMs(): number {
  const env = process.env.SESSION_CACHE_TTL_MS;
  if (!env) return 60_000;
  const parsed = parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function extractSessionCacheKey(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookieParts = cookieHeader.split(";").map((c) => c.trim());

  // Better Auth cookie name uses underscore (session_token). Older code used
  // a dash variant (session-token). Support both for safety. Use exact name match
  // (not startsWith) so we don't accidentally grab the `.sig` companion cookie.
  const findCookie = (name: string) =>
    cookieParts.find((c) => c === name || c.startsWith(`${name}=`));
  const sessionCookie =
    findCookie("better-auth.session_token") ??
    findCookie("better-auth.session-token");

  return sessionCookie ?? null;
}

function parseSessionExpiresAt(session: Session): number {
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

export async function getCachedSession(
  headers: Headers,
  options: GetCachedSessionOptions = {}
): Promise<Session | null> {
  const cookieHeader = headers.get("cookie");
  const cacheKey = extractSessionCacheKey(cookieHeader);
  if (!cacheKey) return null;

  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = sessionCache.get(cacheKey);
    if (cached && isFresh(cached, now)) {
      return cached.session;
    }
  } else {
    sessionCache.delete(cacheKey);
  }

  evictStaleEntries(now);

  try {
    // Better Auth uses the database for session validation. Ensure MongoDB is connected
    // before calling getSession, otherwise all protected routes can incorrectly 401.
    await ensureMongoConnected();
    // Mirror exactly how better-auth's own /api/auth/get-session handler resolves
    // the session. Passing `query: { disableCookieCache: true }` previously caused
    // getSession to take a different cookie-resolution path that returns null on
    // serverless runtimes (Vercel/Render) while working on localhost. We already
    // disable the cookie cache via `session.cookieCache.enabled: false` in auth.ts,
    // so forcing it here is both redundant and harmful.
    const session = await auth.api.getSession({ headers });

    if (!session?.session || !session?.user) {
      sessionCache.delete(cacheKey);
      return null;
    }

    const expiresAt = parseSessionExpiresAt(session);
    sessionCache.set(cacheKey, {
      session,
      timestamp: now,
      expiresAt,
    });

    return session;
  } catch (err) {
    console.error("[cachedSession] Error fetching session:", err);
    return null;
  }
}
