/**
 * POST /api/helpdesk/tickets/[id]/messages
 *
 * Enqueue a HelpdeskOutboundJob for an eBay reply or external email.
 * The job is held for `sendDelaySeconds` (default 5) so the agent can hit Undo
 * via DELETE /api/helpdesk/outbound/[jobId] before it actually fires.
 *
 * Safety: This route NEVER touches the marketplace directly. The cron worker
 * picks up the job and executes the send only if all feature flags are set.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  HelpdeskComposerMode,
  HelpdeskOutboundStatus,
  HelpdeskTicketStatus,
} from "@prisma/client";
import { helpdeskFlags } from "@/lib/helpdesk/flags";
import {
  extractMentionHandles,
  resolveMentions,
  fanOutMentionNotifications,
} from "@/lib/helpdesk/mentions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  composerMode: z.enum(["REPLY", "NOTE", "EXTERNAL"]),
  bodyText: z.string().trim().min(1).max(10_000),
  sendDelaySeconds: z.number().int().min(0).max(60).default(5),
  setStatus: z.enum(["WAITING", "RESOLVED"]).optional(),
});

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
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const ticket = await db.helpdeskTicket.findUnique({ where: { id } });
  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  if (ticket.isArchived && parsed.data.composerMode !== HelpdeskComposerMode.NOTE) {
    return NextResponse.json(
      { error: "Archived ticket — reopen before sending" },
      { status: 409 },
    );
  }

  // Note path: write directly. Notes never queue.
  if (parsed.data.composerMode === "NOTE") {
    const handles = extractMentionHandles(parsed.data.bodyText);
    const mention = await resolveMentions(handles);
    const note = await db.helpdeskNote.create({
      data: {
        ticketId: id,
        authorUserId: session.user.id,
        bodyText: parsed.data.bodyText,
        mentions: mention.matched.map((m) => ({
          handle: m.handle,
          userId: m.userId,
        })),
      },
    });
    const fanOut = await fanOutMentionNotifications({
      ticketId: id,
      noteId: note.id,
      authorUserId: session.user.id,
      body: parsed.data.bodyText,
      matched: mention.matched,
    });
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: "HELPDESK_NOTE_CREATED",
        entityType: "HelpdeskNote",
        entityId: note.id,
        details: {
          ticketId: id,
          mentionsMatched: mention.matched.length,
          mentionsUnmatched: mention.unmatched.length,
          notificationsCreated: fanOut.created,
        },
      },
    });
    return NextResponse.json({
      data: {
        kind: "note",
        id: note.id,
        mentionsMatched: mention.matched.length,
        notificationsCreated: fanOut.created,
      },
    });
  }

  // Outbound paths: enqueue with send delay.
  const scheduledAt = new Date(Date.now() + parsed.data.sendDelaySeconds * 1000);
  const setStatus =
    parsed.data.setStatus === "RESOLVED"
      ? HelpdeskTicketStatus.RESOLVED
      : parsed.data.setStatus === "WAITING"
        ? HelpdeskTicketStatus.WAITING
        : null;

  // Pre-flight visibility for the agent: if a feature flag is off we still
  // accept the job (the worker will mark it CANCELED) — the response includes a
  // `willBlock` warning so the UI can show a banner.
  const willBlockReason: string | null = helpdeskFlags.safeMode
    ? "safe_mode"
    : parsed.data.composerMode === "REPLY" && !helpdeskFlags.enableEbaySend
      ? "ebay_send_disabled"
      : parsed.data.composerMode === "EXTERNAL" && !helpdeskFlags.enableResendExternal
        ? "external_email_disabled"
        : null;

  const job = await db.helpdeskOutboundJob.create({
    data: {
      ticketId: id,
      authorUserId: session.user.id,
      composerMode: parsed.data.composerMode as HelpdeskComposerMode,
      bodyText: parsed.data.bodyText,
      scheduledAt,
      setStatus,
      status: HelpdeskOutboundStatus.PENDING,
    },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HELPDESK_OUTBOUND_QUEUED",
      entityType: "HelpdeskOutboundJob",
      entityId: job.id,
      details: {
        ticketId: id,
        composerMode: parsed.data.composerMode,
        scheduledAt: scheduledAt.toISOString(),
        willBlockReason,
      },
    },
  });

  return NextResponse.json({
    data: {
      kind: "outbound_job",
      id: job.id,
      scheduledAt: scheduledAt.toISOString(),
      willBlockReason,
    },
  });
}
