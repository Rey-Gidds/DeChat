import { NextResponse } from "next/server";
import { getCachedSession } from "./cachedSession";

export type AuthSession = NonNullable<
  Awaited<ReturnType<typeof getCachedSession>>
>;

export type RequireSessionOptions = {
  /** Bypass caches and revalidate session against the database. */
  fresh?: boolean;
};

export async function requireSession(
  req: Request,
  options: RequireSessionOptions = {}
): Promise<{ session: AuthSession } | { error: NextResponse }> {
  const session = await getCachedSession(req.headers, {
    forceRefresh: options.fresh,
  });

  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return { session };
}
