/**
 * POST /api/helpdesk/tickets/:id/archive   { archived: boolean }
 * Archived tickets are read-only — the composer hides itself in the UI when
 * `isArchived` is true. Reopening simply un-archives and (if previously
 * RESOLVED) bumps reopenCount.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HelpdeskTicketStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ archived: z.boolean() });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const ticket = await db.helpdeskTicket.findUnique({ where: { id } });
  if (!ticket)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {
    isArchived: parsed.data.archived,
    archivedAt: parsed.data.archived ? new Date() : null,
  };
  // Reopening from archive: if it was resolved, bump reopenCount and re-open.
  if (
    !parsed.data.archived &&
    ticket.isArchived &&
    ticket.status === HelpdeskTicketStatus.RESOLVED
  ) {
    data.status = HelpdeskTicketStatus.TO_DO;
    data.reopenCount = ticket.reopenCount + 1;
    data.lastReopenedAt = new Date();
    data.resolvedAt = null;
    data.resolvedById = null;
  }
  await db.helpdeskTicket.update({ where: { id }, data });
  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: parsed.data.archived
        ? "HELPDESK_TICKET_ARCHIVED"
        : "HELPDESK_TICKET_REOPENED",
      entityType: "HelpdeskTicket",
      entityId: id,
      details: { reopenedFromResolved: !!data.lastReopenedAt },
    },
  });
  return NextResponse.json({
    data: { id, archived: parsed.data.archived },
  });
}
