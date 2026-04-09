import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { processAutoResponderJobs } = await import("@/lib/services/auto-responder");

  let totalProcessed = 0;
  let totalSent = 0;
  let totalFailed = 0;
  const startMs = Date.now();

  for (let pass = 0; pass < 20; pass++) {
    if (Date.now() - startMs > 45_000) break;
    const batch = await processAutoResponderJobs();
    totalProcessed += batch.processed;
    totalSent += batch.sent;
    totalFailed += batch.failed;
    if (batch.processed === 0) break;
  }

  return NextResponse.json({
    processed: totalProcessed,
    sent: totalSent,
    failed: totalFailed,
    elapsedMs: Date.now() - startMs,
  });
}
