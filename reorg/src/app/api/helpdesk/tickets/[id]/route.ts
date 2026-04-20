import { NextResponse, type NextRequest } from "next/server";
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
      status: ticket.status,
      isSpam: ticket.isSpam,
      isArchived: ticket.isArchived,
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
      additionalAssignees: ticket.additionalAssignees,
    },
  });
}
