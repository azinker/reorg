import { NextResponse, type NextRequest } from "next/server";
import { runReconciliation, processAutoResponderJobs } from "@/lib/services/auto-responder";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cronSecret = request.headers.get("x-cron-secret");
  return bearerSecret === secret || cronSecret === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const reconResult = await runReconciliation();

  // Process any jobs that were enqueued by reconciliation
  let processResult = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  if (reconResult.jobsEnqueued > 0) {
    processResult = await processAutoResponderJobs();
  }

  return NextResponse.json({ data: { reconciliation: reconResult, processing: processResult } });
}
