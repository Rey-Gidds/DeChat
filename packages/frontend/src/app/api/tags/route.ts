import { NextResponse } from "next/server";
import { getTags, searchTags } from "@/lib/tags";
import { ensureMongoConnected } from "@/lib/mongodb";

export async function GET(req: Request) {
  try {
    await ensureMongoConnected();
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q") || "";

    const tags = query ? await searchTags(query) : await getTags();

    return NextResponse.json({ tags });
  } catch (err) {
    console.error("Tags fetch error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
