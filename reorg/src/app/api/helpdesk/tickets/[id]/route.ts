import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HelpdeskOutboundStatus, HelpdeskTicketType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id },
    include: {
      integration: { select: { label: true, platform: true } },
      primaryAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
      },
      additionalAssignees: {
        include: {
          user: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      tags: { include: { tag: true } },
      messages: {
        orderBy: { sentAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      notes: {
        where: { isDeleted: false },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
      // Surface in-flight outbound jobs (the 5s undo window + any rows
      // currently being SENDING by the cron) so the thread can render an
      // immediate "Sending…" bubble. We deliberately exclude SENT (those
      // become real HelpdeskMessage rows on next sync) and CANCELED
      // (Undo'd by the agent — they don't want to see it).
      outboundJobs: {
        where: {
          status: {
            in: [
              HelpdeskOutboundStatus.PENDING,
              HelpdeskOutboundStatus.SENDING,
            ],
          },
        },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
          },
        },
      },
    },
  });

  if (!ticket) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Mark as read on detail open: clear unreadCount.
  if (ticket.unreadCount > 0) {
    await db.helpdeskTicket.update({
      where: { id: ticket.id },
      data: { unreadCount: 0 },
    });
  }

  // Stamp a "ticket opened" audit row so the reader timeline can show
  // "Adam opened the ticket". Two-part dedupe so the timeline stays clean
  // even when an agent revisits the same ticket many times in a day:
  //
  //   1. Hard debounce: never write more than one open per (agent, ticket)
  //      within a 30-minute window. The Help Desk hook auto-refreshes the
  //      currently selected ticket every 30 seconds; without this the
  //      timeline would gain a fresh row every minute of viewing.
  //
  //   2. Activity gate: skip writing if the agent has opened this ticket
  //      before AND nothing has happened on the ticket since their last
  //      open (no new buyer/agent message, no note, no other audit row,
  //      no status change). Re-opening a ticket the agent already saw
  //      with no new activity isn't useful timeline noise — it just
  //      means they came back to look. We still let the read-state
  //      logic above clear unreadCount, and we still serve the ticket;
  //      we just don't stamp another "opened" event.
  //
  // Cheap lookup — uses the (entityType, entityId) audit_logs index.
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000);
  const recentOpen = await db.auditLog.findFirst({
    where: {
      action: "HELPDESK_TICKET_OPENED",
      entityType: "HelpdeskTicket",
      entityId: ticket.id,
      userId: session.user.id,
      createdAt: { gte: thirtyMinutesAgo },
    },
    select: { id: true },
  });
  if (!recentOpen) {
    // Find the most recent prior open by this agent (any time).
    const lastOpen = await db.auditLog.findFirst({
      where: {
        action: "HELPDESK_TICKET_OPENED",
        entityType: "HelpdeskTicket",
        entityId: ticket.id,
        userId: session.user.id,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    let shouldStamp = true;
    if (lastOpen) {
      // Activity gate: only stamp if SOMETHING new happened on this
      // ticket since the previous open. We check the ticket's
      // updatedAt (covers status changes, assignment, tag changes,
      // unreadCount bumps from new messages) — that's denormalized
      // for exactly this kind of cheap "anything changed?" probe.
      shouldStamp = ticket.updatedAt > lastOpen.createdAt;
    }

    if (shouldStamp) {
      await db.auditLog.create({
        data: {
          userId: session.user.id,
          action: "HELPDESK_TICKET_OPENED",
          entityType: "HelpdeskTicket",
          entityId: ticket.id,
          details: {},
        },
      });
    }
  }

  // Shape the response so it matches HelpdeskTicketSummary plus messages/notes.
  return NextResponse.json({
    data: {
      id: ticket.id,
      channel: ticket.channel,
      integrationLabel: ticket.integration.label,
      threadKey: ticket.threadKey,
      buyerUserId: ticket.buyerUserId,
      buyerName: ticket.buyerName,
      buyerEmail: ticket.buyerEmail,
      ebayItemId: ticket.ebayItemId,
      ebayItemTitle: ticket.ebayItemTitle,
      ebayOrderNumber: ticket.ebayOrderNumber,
      subject: ticket.subject,
      kind: ticket.kind,
      type: ticket.type,
      typeOverridden: ticket.typeOverridden,
      status: ticket.status,
      isSpam: ticket.isSpam,
      isArchived: ticket.isArchived,
      isFavorite: ticket.isFavorite,
      isImportant: ticket.isImportant,
      snoozedUntil: ticket.snoozedUntil,
      primaryAssignee: ticket.primaryAssignee,
      unreadCount: 0,
      lastBuyerMessageAt: ticket.lastBuyerMessageAt,
      lastAgentMessageAt: ticket.lastAgentMessageAt,
      firstResponseAt: ticket.firstResponseAt,
      reopenCount: ticket.reopenCount,
      messageCount: ticket.messages.length,
      noteCount: ticket.notes.length,
      tags: ticket.tags.map((tt) => ({
        id: tt.tag.id,
        name: tt.tag.name,
        color: tt.tag.color,
      })),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      messages: ticket.messages,
      notes: ticket.notes,
      pendingOutboundJobs: ticket.outboundJobs.map((job) => ({
        id: job.id,
        composerMode: job.composerMode,
        bodyText: job.bodyText,
        status: job.status,
        scheduledAt: job.scheduledAt,
        createdAt: job.createdAt,
        // lastError is set by the cron worker if a send hit a transient
        // failure or a write lock. Surfacing it here lets the thread
        // bubble show "Send blocked: <reason>" instead of an indefinite
        // sending spinner.
        willBlockReason: job.lastError ?? null,
        author: job.author,
      })),
      additionalAssignees: ticket.additionalAssignees,
    },
  });
}

/**
 * Per-ticket partial update for the new triage controls in the ticket
 * header bar. Each field is optional — agents can call this with just the
 * one thing they changed (e.g. picking a Type from the dropdown).
 *
 *   - `type`        sets the ticket type AND flips `typeOverridden=true` so
 *                   the inbound auto-detector won't silently undo the choice
 *                   on a later message.
 *   - `isFavorite`  shared favorite (any agent can toggle it for the team).
 *   - `isImportant` row-badge flag in the inbox; pure visual hint.
 *
 * Each successful change writes a per-ticket audit row so the reader
 * timeline shows who flipped what. We deliberately do NOT attempt to write
 * to eBay for any of these fields — they're internal triage state only.
 */
const patchSchema = z
  .object({
    type: z.nativeEnum(HelpdeskTicketType).optional(),
    isFavorite: z.boolean().optional(),
    isImportant: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.type !== undefined ||
      v.isFavorite !== undefined ||
      v.isImportant !== undefined,
    { message: "At least one field is required" },
  );

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const json = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  const auditEntries: Array<{ action: string; details: object }> = [];

  if (parsed.data.type !== undefined) {
    data.type = parsed.data.type;
    data.typeOverridden = true;
    auditEntries.push({
      action: "HELPDESK_TICKET_TYPE_CHANGED",
      details: { type: parsed.data.type },
    });
  }
  if (parsed.data.isFavorite !== undefined) {
    data.isFavorite = parsed.data.isFavorite;
    auditEntries.push({
      action: "HELPDESK_TICKET_FAVORITE_TOGGLED",
      details: { isFavorite: parsed.data.isFavorite },
    });
  }
  if (parsed.data.isImportant !== undefined) {
    data.isImportant = parsed.data.isImportant;
    auditEntries.push({
      action: "HELPDESK_TICKET_IMPORTANT_TOGGLED",
      details: { isImportant: parsed.data.isImportant },
    });
  }

  const updated = await db.helpdeskTicket.update({
    where: { id },
    data,
    select: {
      id: true,
      type: true,
      typeOverridden: true,
      isFavorite: true,
      isImportant: true,
    },
  });

  if (auditEntries.length > 0) {
    await db.auditLog.createMany({
      data: auditEntries.map((e) => ({
        userId: session.user!.id!,
        action: e.action,
        entityType: "HelpdeskTicket",
        entityId: id,
        details: e.details,
      })),
    });
  }

  return NextResponse.json({ data: updated });
}
