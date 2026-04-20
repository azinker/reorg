/**
 * Daily Help Desk housekeeping cron. Vercel calls GET; we accept POST too.
 * Runs the auto-archive, unsnooze, and notification pruning sweeps.
 */

import { NextResponse } from "next/server";
import { runHelpdeskHousekeeping } from "@/lib/services/helpdesk-housekeeping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runHelpdeskHousekeeping();
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    console.error("[helpdesk-housekeeping] failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export const GET = POST;
