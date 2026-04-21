import { NextResponse, type NextRequest } from "next/server";
import { runHelpdeskPoll } from "@/lib/services/helpdesk-ebay-sync";
import { runHelpdeskActionsPoll } from "@/lib/services/helpdesk-ebay-actions";
import { recordHelpdeskPollStatus } from "@/lib/services/helpdesk-poll-status";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const headerSecret = request.headers.get("x-cron-secret");
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  return headerSecret === secret || bearerSecret === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const tickedAt = new Date().toISOString();
  try {
    const result = await runHelpdeskPoll();
    // Run the eBay action workers (returns / cancellations / feedback) in
    // the same tick. They share the integration list and OAuth tokens so
    // there's no advantage to a separate cron schedule, and bundling
    // them keeps the poll-status dashboard a single source of truth.
    // Failures are isolated per-integration inside the worker — they
    // never bubble out as a 500, so we don't wrap this in try/catch
    // tighter than the existing outer try.
    let actionsResult: Awaited<ReturnType<typeof runHelpdeskActionsPoll>> | null =
      null;
    try {
      actionsResult = await runHelpdeskActionsPoll();
    } catch (err) {
      // Last-ditch defensive catch — the worker itself swallows per-
      // integration errors but a top-level throw (e.g. DB outage during
      // checkpoint upsert) would otherwise blank out the whole tick.
      console.error("[cron/helpdesk-poll] actions worker crashed", err);
    }
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "completed",
      durationMs: result.durationMs,
      summaries: result.summaries,
      error: null,
    });
    return NextResponse.json({ ok: true, ...result, actions: actionsResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "failed",
      durationMs: 0,
      summaries: [],
      error: message,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// GET supported for Vercel cron (Vercel pings cron URLs via GET).
export const GET = POST;
