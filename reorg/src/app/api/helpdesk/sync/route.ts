import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { runHelpdeskPoll } from "@/lib/services/helpdesk-ebay-sync";
import { recordHelpdeskPollStatus } from "@/lib/services/helpdesk-poll-status";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Admin-triggered manual sync. Same logic as the cron route, but gated by
 * session auth + ADMIN role rather than CRON_SECRET.
 *
 * Records the same `helpdesk_poll_last_tick_at` / `_last_outcome` /
 * `_last_summary` app settings the cron does — so the "Synced X ago"
 * indicator updates after a manual sync, not just after the cron tick.
 */
export async function POST(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tickedAt = new Date().toISOString();
  try {
    const result = await runHelpdeskPoll();
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "completed",
      durationMs: result.durationMs,
      summaries: result.summaries,
      error: null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordHelpdeskPollStatus({
      tickedAt,
      outcome: "failed",
      durationMs: 0,
      summaries: [],
      error: message,
    });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}
