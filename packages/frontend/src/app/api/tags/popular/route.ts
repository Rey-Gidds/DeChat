import { NextResponse } from "next/server";
import { getPopularTags } from "@/lib/tag-stats";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") || "20", 10), 1),
      50
    );

    const tags = await getPopularTags(limit);
    return NextResponse.json({ tags });
  } catch (err) {
    console.error("[tags/popular] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
