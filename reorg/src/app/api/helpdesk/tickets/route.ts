import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  buildFolderWhere,
  type HelpdeskFolderKey,
} from "@/lib/helpdesk/folders";
import { resolveHelpdeskSearch } from "@/lib/helpdesk/search";
import { HelpdeskOutboundStatus, Platform, type Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build a one-line preview from a message body. HTML bodies get tags stripped
 * and entities decoded; whitespace is collapsed; the result is truncated to
 * 240 chars to keep the inbox payload small while leaving the table room to
 * truncate further with CSS for visual polish.
 *
 * We deliberately do NOT strip the buyer's name greeting from the preview.
 * The user's spec is "show the actual message content as-is" — the greeting
 * is part of the AR's voice and trimming it would silently mangle real
 * agent-typed messages too.
 */
const PREVIEW_MAX = 240;
function summarizeBody(
  body: string | null | undefined,
  isHtml: boolean,
): string {
  if (!body) return "";
  let text = body;
  if (isHtml) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > PREVIEW_MAX) {
    text = text.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
  }
  return text;
}

const folderEnum = z.enum([
  "pre_sales",
  "my_tickets",
  "all_tickets",
  "all_new",
  "all_to_do",
  "all_to_do_unread",
  "all_to_do_awaiting",
  "all_waiting",
  "buyer_cancellation",
  "from_ebay",
  "snoozed",
  "resolved",
  "unassigned",
  "mentioned",
  "favorites",
  "spam",
  "archived",
]);

const querySchema = z.object({
  folder: folderEnum.default("all_tickets"),
  channel: z.enum(["TPP_EBAY", "TT_EBAY"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Sub-filter chip on the From eBay folder. When set, narrows the
  // resultset to tickets whose `systemMessageType` matches one of the
  // tokens defined in `lib/helpdesk/from-ebay-detect.ts` (e.g.
  // RETURN_APPROVED, ITEM_DELIVERED). Ignored on every other folder.
  systemMessageType: z.string().trim().min(1).max(64).optional(),
  agentFolderId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(sp.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { folder, channel, search, cursor, limit, systemMessageType, agentFolderId } = parsed.data;
  // When a global search is active we deliberately ignore the folder filter
  // so the agent can find resolved / spam / archived tickets too — this is
  // how eDesk behaves and matches user expectation ("search the whole
  // mailbox"). The folder still drives the count badges in the sidebar
  // (separate endpoint), so the UX remains coherent.
  const where: Prisma.HelpdeskTicketWhereInput = agentFolderId
    ? { agentFolderId }
    : search
      ? {}
      : {
          ...buildFolderWhere(folder as HelpdeskFolderKey, { userId: session.user.id }),
        };
  if (channel) where.channel = channel as Platform;
  // From-eBay sub-filter chip: only honored when the agent is actually
  // viewing the from_ebay folder. Honoring it on other folders would let
  // a stale URL parameter silently empty out a regular folder view.
  if (systemMessageType && folder === "from_ebay") {
    where.systemMessageType = systemMessageType;
  }

  // Global search: STRICT mode — eBay Order ID OR buyer username, never both.
  // The shape resolution lives in `lib/helpdesk/search.ts` so it's unit-
  // testable and the route stays a thin Prisma wrapper.
  const resolved = resolveHelpdeskSearch(search);
  if (resolved) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      resolved.where,
    ];
  }

  // Inbox list: keep the included relations minimal. We previously also
  // selected `_count: { messages, notes }`, but neither field is consumed by
  // the client (verified — `messageCount`/`noteCount` only appear in the
  // type, never in JSX) and they each issue an extra correlated subquery per
  // row. With `limit=50` that meant 100 extra subqueries per inbox load,
  // contributing materially to the 10s+ TTFB on this endpoint.
  const tickets = await db.helpdeskTicket.findMany({
    where,
    orderBy: [{ lastBuyerMessageAt: "desc" }, { updatedAt: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      integration: { select: { label: true, platform: true } },
      primaryAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
      },
      tags: { include: { tag: true } },
    },
  });

  const hasMore = tickets.length > limit;
  const page = hasMore ? tickets.slice(0, limit) : tickets;

  // Compute a one-line `latestPreview` per ticket from the most recent real
  // message (excluding raw eBay digest envelopes — those still contain a
  // `<div id="UserInputtedText...">` block; the exploded sub-messages don't).
  // Done as a single batched query keyed off the page's ticket ids so the
  // inbox stays one-roundtrip even at limit=50.
  const previewByTicket = new Map<string, { preview: string; at: Date }>();
  if (page.length > 0) {
    const ticketIds = page.map((t) => t.id);
    function setLatestPreview(ticketId: string, preview: string, at: Date) {
      if (!preview) return;
      const existing = previewByTicket.get(ticketId);
      if (existing && existing.at.getTime() >= at.getTime()) return;
      previewByTicket.set(ticketId, { preview, at });
    }
    // "Latest update" should only ever surface a real buyer or agent
    // message — never an eBay system notification (Return approved,
    // Case closed, etc.) and never the raw digest envelope / stripped
    // stub. We identify system messages by sender: the Trading API
    // stamps system mail with `sender=eBay`, which we persist into
    // `fromName`/`fromIdentifier` on the message row.
    const recent = await db.helpdeskMessage.findMany({
      where: {
        ticketId: { in: ticketIds },
        deletedAt: null,
        AND: [
          { NOT: { bodyText: { contains: "UserInputtedText" } } },
          { NOT: { bodyText: { startsWith: "[digest envelope" } } },
          { NOT: { fromName: { equals: "eBay", mode: "insensitive" } } },
          { NOT: { fromIdentifier: { equals: "eBay", mode: "insensitive" } } },
        ],
      },
      orderBy: { sentAt: "desc" },
      select: { ticketId: true, bodyText: true, isHtml: true, sentAt: true },
    });
    for (const m of recent) {
      setLatestPreview(
        m.ticketId,
        summarizeBody(m.bodyText, m.isHtml),
        m.sentAt,
      );
    }

    // Show agent replies immediately after Send, even before the outbound
    // worker/sync cycle has materialized them as HelpdeskMessage rows.
    const outbound = await db.helpdeskOutboundJob.findMany({
      where: {
        ticketId: { in: ticketIds },
        status: {
          in: [
            HelpdeskOutboundStatus.PENDING,
            HelpdeskOutboundStatus.SENDING,
            HelpdeskOutboundStatus.SENT,
          ],
        },
      },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      select: {
        ticketId: true,
        bodyText: true,
        sentAt: true,
        createdAt: true,
      },
    });
    for (const job of outbound) {
      setLatestPreview(
        job.ticketId,
        summarizeBody(job.bodyText, false),
        job.sentAt ?? job.createdAt,
      );
    }
  }

  return NextResponse.json({
    data: page.map((t) => ({
      id: t.id,
      channel: t.channel,
      integrationLabel: t.integration.label,
      threadKey: t.threadKey,
      buyerUserId: t.buyerUserId,
      buyerName: t.buyerName,
      buyerEmail: t.buyerEmail,
      ebayItemId: t.ebayItemId,
      ebayItemTitle: t.ebayItemTitle,
      ebayOrderNumber: t.ebayOrderNumber,
      subject: t.subject,
      latestPreview: previewByTicket.get(t.id)?.preview ?? null,
      kind: t.kind,
      type: t.type,
      typeOverridden: t.typeOverridden,
      systemMessageType: t.systemMessageType,
      status: t.status,
      isSpam: t.isSpam,
      isArchived: t.isArchived,
      isFavorite: t.isFavorite,
      isImportant: t.isImportant,
      snoozedUntil: t.snoozedUntil,
      primaryAssignee: t.primaryAssignee,
      unreadCount: t.unreadCount,
      lastBuyerMessageAt: t.lastBuyerMessageAt,
      lastAgentMessageAt: t.lastAgentMessageAt,
      firstResponseAt: t.firstResponseAt,
      reopenCount: t.reopenCount,
      // messageCount / noteCount intentionally omitted; not rendered.
      tags: t.tags.map((tt) => ({
        id: tt.tag.id,
        name: tt.tag.name,
        color: tt.tag.color,
      })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
}
