/**
 * POST /api/helpdesk/filters/:id/run
 *
 * Run a filter retroactively across the existing inbox. Returns a summary
 * suitable for displaying as a toast (e.g. "Scanned 1,200 messages, matched
 * 18 tickets, archived 18").
 *
 * This wraps `runFilterOverInbox` from the filter engine so the UI doesn't
 * need to know how matches are evaluated.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runFilterOverInbox } from "@/lib/helpdesk/filters";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const result = await runFilterOverInbox(id, session.user.id);
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_FILTER_RUN",
        entityType: "HelpdeskFilter",
        entityId: id,
        details: {
          scanned: result.scanned,
          matched: result.matched,
          applied: result.applied,
        },
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
