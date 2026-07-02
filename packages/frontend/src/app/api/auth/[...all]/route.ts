import { toNextJsHandler } from "better-auth/next-js";
import { auth, ensureMongoConnected } from "@/lib/auth";
import { evictSession } from "@/lib/cachedSession";

const handler = toNextJsHandler(auth);

const SESSION_INVALIDATION_PATHS = [
  "sign-out",
  "revoke-session",
  "revoke-sessions",
  "change-password",
  "reset-password",
];

function shouldEvictSessionCache(url: string): boolean {
  return SESSION_INVALIDATION_PATHS.some((segment) => url.includes(segment));
}

export const GET = async (req: Request) => {
  await ensureMongoConnected();
  return handler.GET(req);
};

export const POST = async (req: Request) => {
  await ensureMongoConnected();
  if (shouldEvictSessionCache(req.url)) {
    evictSession(req.headers);
  }
  return handler.POST(req);
};
