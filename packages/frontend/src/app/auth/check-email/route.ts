import { db } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
    try {
        const { email } = await req.json();
        
        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        // Use direct MongoDB query to check if the user exists
        const user = await db.collection("user").findOne({ email });

        const exists = !!user;

        return NextResponse.json({ exists });
    } catch (error) {
        console.error("Error checking email existence:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
