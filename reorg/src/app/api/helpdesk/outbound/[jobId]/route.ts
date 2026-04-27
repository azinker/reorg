/**
 * DELETE /api/helpdesk/outbound/[jobId] — cancel a pending outbound job.
 * POST /api/helpdesk/outbound/[jobId] — retry a failed/canceled job.
 *
 * Used by the Composer's Undo button during the send-delay window.
 * Once a job has flipped to SENDING/SENT/FAILED it cannot be canceled.
 * Retry never sends directly; it only puts the job back into PENDING so
 * the normal HelpdeskOutboundJob worker still owns every marketplace write.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { HelpdeskOutboundStatus, HelpdeskTicketStatus } from "@prisma/client";

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

  const metadata =
    job.metadata && typeof job.metadata === "object" && !Array.isArray(job.metadata)
      ? (job.metadata as Record<string, unknown>)
      : {};
  const previousStatus = metadata.previousTicketStatus;
  const previousIsArchived = metadata.previousIsArchived === true;
  const previousArchivedAt =
    typeof metadata.previousArchivedAt === "string"
      ? new Date(metadata.previousArchivedAt)
      : null;
  const previousResolvedAt =
    typeof metadata.previousResolvedAt === "string"
      ? new Date(metadata.previousResolvedAt)
      : null;
  const previousResolvedById =
    typeof metadata.previousResolvedById === "string"
      ? metadata.previousResolvedById
      : null;

  if (isHelpdeskTicketStatus(previousStatus) && (job.setStatus || previousIsArchived)) {
    await db.helpdeskTicket.updateMany({
      where: {
        id: job.ticketId,
        ...(job.setStatus ? { status: job.setStatus } : {}),
        ...(previousIsArchived ? { isArchived: false } : {}),
      },
      data: {
        status: previousStatus,
        resolvedAt: previousResolvedAt,
        resolvedById: previousResolvedById,
        isArchived: previousIsArchived,
        archivedAt: previousIsArchived ? previousArchivedAt ?? new Date() : null,
      },
    });
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

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;
  const job = await db.helpdeskOutboundJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (
    job.status !== HelpdeskOutboundStatus.FAILED &&
    job.status !== HelpdeskOutboundStatus.CANCELED
  ) {
    return NextResponse.json(
      { error: `Cannot retry — job is ${job.status}` },
      { status: 409 },
    );
  }

  const scheduledAt = new Date();
  await db.$transaction(async (tx) => {
    const updated = await tx.helpdeskOutboundJob.updateMany({
      where: {
        id: jobId,
        status: {
          in: [HelpdeskOutboundStatus.FAILED, HelpdeskOutboundStatus.CANCELED],
        },
      },
      data: {
        status: HelpdeskOutboundStatus.PENDING,
        scheduledAt,
        lastError: null,
        externalId: null,
        sentAt: null,
        attemptCount: 0,
      },
    });
    if (updated.count === 0) {
      throw new Error("Job already moved past retryable state");
    }

    if (job.setStatus) {
      await tx.helpdeskTicket.update({
        where: { id: job.ticketId },
        data: {
          status: job.setStatus,
          ...(job.setStatus === HelpdeskTicketStatus.RESOLVED
            ? { resolvedAt: new Date(), resolvedById: session.user.id }
            : { resolvedAt: null, resolvedById: null }),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_OUTBOUND_RETRIED",
        entityType: "HelpdeskOutboundJob",
        entityId: jobId,
        details: {
          ticketId: job.ticketId,
          previousStatus: job.status,
          previousError: job.lastError,
          scheduledAt: scheduledAt.toISOString(),
        },
      },
    });
  });

  return NextResponse.json({
    data: {
      id: job.id,
      status: HelpdeskOutboundStatus.PENDING,
      scheduledAt: scheduledAt.toISOString(),
    },
  });
}

function isHelpdeskTicketStatus(value: unknown): value is HelpdeskTicketStatus {
  return (
    typeof value === "string" &&
    Object.values(HelpdeskTicketStatus).includes(value as HelpdeskTicketStatus)
  );
}
