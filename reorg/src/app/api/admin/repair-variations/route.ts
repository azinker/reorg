import { NextResponse } from "next/server";
import { cleanupFalseVariationFamilies } from "@/lib/services/variation-repair";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await cleanupFalseVariationFamilies();
    return NextResponse.json({ ok: true, message: "False variation families cleaned up." });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
