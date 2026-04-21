import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  buildFolderWhere,
  type HelpdeskFolderKey,
} from "@/lib/helpdesk/folders";
import { resolveHelpdeskSearch } from "@/lib/helpdesk/search";
import { Platform, type Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const folderEnum = z.enum([
  "pre_sales",
  "my_tickets",
  "all_tickets",
  "all_new",
  "all_to_do",
  "all_waiting",
  "buyer_cancellation",
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

  const { folder, channel, search, cursor, limit } = parsed.data;
  // When a global search is active we deliberately ignore the folder filter
  // so the agent can find resolved / spam / archived tickets too — this is
  // how eDesk behaves and matches user expectation ("search the whole
  // mailbox"). The folder still drives the count badges in the sidebar
  // (separate endpoint), so the UX remains coherent.
  const where: Prisma.HelpdeskTicketWhereInput = search
    ? {}
    : {
        ...buildFolderWhere(folder as HelpdeskFolderKey, { userId: session.user.id }),
      };
  if (channel) where.channel = channel as Platform;

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
      kind: t.kind,
      type: t.type,
      typeOverridden: t.typeOverridden,
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
