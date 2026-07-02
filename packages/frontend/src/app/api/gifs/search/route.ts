import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/api-auth";
import { searchGifs } from "@/lib/gif-cache";

export async function GET(request: NextRequest) {
  const auth = await requireSession(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim().slice(0, 100) ?? "";
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit")) || 20));

  if (!q) {
    return NextResponse.json({ results: [], next: null });
  }

  try {
    const result = await searchGifs(q, offset, limit);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "RATE_LIMITED") {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (message === "GIPHY_API_KEY is not configured") {
      return NextResponse.json({ error: "Giphy API not configured" }, { status: 500 });
    }
    return NextResponse.json({ error: "Could not load GIFs. Try again." }, { status: 502 });
  }
}
