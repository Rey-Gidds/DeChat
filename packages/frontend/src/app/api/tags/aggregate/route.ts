import { NextResponse } from "next/server";
import { runTagAggregation } from "@/lib/tag-stats";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");

    if (
      process.env.NODE_ENV !== "development" &&
      key !== process.env.ADMIN_INDEX_KEY
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await runTagAggregation();
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[tag-aggregate] Failed:", err);
    return NextResponse.json(
      { error: err.message || "Aggregation failed" },
      { status: 500 }
    );
  }
}
