/**
 * Cron worker for Help Desk outbound queue.
 * Runs every minute to flush jobs whose send-delay has elapsed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { processHelpdeskOutboundJobs } from "@/lib/services/helpdesk-outbound";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // local dev: allow
  const header = request.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  // Vercel cron sends `x-vercel-signature` not bearer; accept either.
  if (request.headers.get("x-vercel-cron") === "1") return true;
  const queryToken = request.nextUrl.searchParams.get("token");
  return queryToken === expected;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  try {
    const result = await processHelpdeskOutboundJobs();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - start,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = POST;
