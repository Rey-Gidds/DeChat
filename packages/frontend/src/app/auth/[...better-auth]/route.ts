import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { evictSession } from "@/lib/cachedSession";

const handler = toNextJsHandler(auth);

export const GET = handler.GET;
export const POST = async (req: Request) => {
    // If the user is signing out, clear their cache entry immediately
    if (req.url.includes("sign-out")) {
        evictSession(req.headers);
    }
    return handler.POST(req);
};
