/**
 * POST /api/helpdesk/auto-resolve
 *
 * Walks every open ticket and marks it RESOLVED when the most recent message
 * is outbound (i.e. the agent already replied — usually because the reply
 * happened on eBay before reorG existed). This is meant to be run once after
 * the initial 180-day backfill finishes; the live sync handles new traffic
 * automatically going forward.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoResolveAlreadyAnswered } from "@/lib/helpdesk/filters";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await autoResolveAlreadyAnswered();
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_AUTO_RESOLVE_RUN",
        entityType: "HelpdeskTicket",
        details: result,
      },
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
