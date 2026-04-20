/**
 * DELETE /api/helpdesk/outbound/[jobId] — cancel a pending outbound job.
 *
 * Used by the Composer's Undo button during the send-delay window.
 * Once a job has flipped to SENDING/SENT/FAILED it cannot be canceled.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { HelpdeskOutboundStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const job = await db.helpdeskOutboundJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (job.status !== HelpdeskOutboundStatus.PENDING) {
    return NextResponse.json(
      { error: `Cannot cancel — job is ${job.status}` },
      { status: 409 },
    );
  }

  const updated = await db.helpdeskOutboundJob.updateMany({
    where: { id: jobId, status: HelpdeskOutboundStatus.PENDING },
    data: {
      status: HelpdeskOutboundStatus.CANCELED,
      lastError: "canceled_by_user",
    },
  });

  if (updated.count === 0) {
    return NextResponse.json(
      { error: "Job already moved past PENDING" },
      { status: 409 },
    );
  }

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_OUTBOUND_CANCELED",
      entityType: "HelpdeskOutboundJob",
      entityId: jobId,
      details: { ticketId: job.ticketId },
    },
  });

  return NextResponse.json({ data: { canceled: true } });
}
