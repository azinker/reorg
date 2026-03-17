import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const bodySchema = z.object({ id: z.string().min(1) });

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await db.unmatchedListing.delete({
      where: { id: parsed.data.id },
    });

    return NextResponse.json({ data: { ok: true } });
  } catch (error) {
    console.error("[unmatched/ignore] Failed", error);
    return NextResponse.json(
      { error: "Failed to ignore listing" },
      { status: 500 }
    );
  }
}
