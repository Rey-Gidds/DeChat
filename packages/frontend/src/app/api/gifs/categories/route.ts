import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/api-auth";
import { fetchCategories } from "@/lib/gif-cache";

export async function GET(request: NextRequest) {
  const auth = await requireSession(request);
  if ("error" in auth) return auth.error;

  try {
    const categories = await fetchCategories();
    return NextResponse.json({ categories });
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
